import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import { parseWorkbook } from "./parser.js";
import {
  confirmUnsubscribe,
  countSends,
  findUnsubscribe,
  getDbError,
  initStore,
  isDbReady,
  listHistory,
  loadSuppression,
  publicBaseUrl,
  recordExpertInterest,
  recordOpen,
  ensureOpened,
  rememberSent,
} from "./store.js";
import { ensurePlaceholderAttachments, sendReadyLeads, verifySmtp, getCompanyProfile } from "./mailer.js";
import { getTemplate, listTemplates } from "./templateCatalog.js";
import { maskEmailForLogs } from "./safeMail.js";

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const sendJobs = new Map();

const app = express();

function publicSendJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    filename: job.filename,
    templateName: job.templateName,
    total: job.total,
    readyCount: job.readyCount,
    processed: job.processed,
    sent: job.sent,
    failed: job.failed,
    skipped: job.skipped,
    rows: [...job.sent, ...job.failed, ...job.skipped],
    error: job.error || "",
  };
}

function hasActiveSendJob() {
  for (const job of sendJobs.values()) {
    if (job.status === "queued" || job.status === "running") return true;
  }
  return false;
}

async function runSendJob(jobId, leads, template) {
  const job = sendJobs.get(jobId);
  if (!job) return;
  job.status = "running";
  console.log(`Send job ${jobId.slice(0, 8)} started (${leads.length} ready)`);
  try {
    await sendReadyLeads(leads, template, async ({ index, total, result }) => {
      job.processed = index + 1;
      if (result.status === "sent") {
        job.sent.push(result);
        try {
          await rememberSent([result]);
        } catch (error) {
          console.error("Failed to remember sent email", error.message);
        }
      } else {
        job.failed.push(result);
        console.warn(
          `Send failed ${maskEmailForLogs(result.email)}: ${result.reason || "unknown"}`
        );
      }
      if ((index + 1) % 5 === 0 || index + 1 === total) {
        console.log(`Send job ${jobId.slice(0, 8)} progress ${index + 1}/${total}`);
      }
    });
    job.status = "completed";
    console.log(
      `Send job ${jobId.slice(0, 8)} completed: ${job.sent.length} sent, ${job.failed.length} failed`
    );
  } catch (error) {
    job.status = "failed";
    job.error = error.message || "Send job failed";
    console.error(`Send job ${jobId.slice(0, 8)} failed`, job.error);
  }
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".xls", ".xlsx", ".xlsm", ".csv"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error("Please upload an Excel or CSV file."));
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function receiveWorkbook(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    next();
  });
}

function requireDatabase(_req, res, next) {
  if (!isDbReady()) {
    return res.status(400).json({ error: getDbError() });
  }
  next();
}

function cleanToken(value) {
  return String(value || "").replace(/\.gif$/i, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eef7f0; color: #0d1e35; font-family: Manrope, "Segoe UI", sans-serif; }
    main { width: min(440px, calc(100% - 32px)); background: white; border: 1px solid #eaecef; border-radius: 18px; padding: 28px; }
    h1 { margin: 0 0 10px; font-size: 24px; color: #163b7c; }
    p { margin: 0; line-height: 1.5; color: #575757; }
    button { margin-top: 18px; border: 0; border-radius: 16px; padding: 12px 16px; background: #55b56c; color: white; font-weight: 650; cursor: pointer; }
    a { color: #163b7c; font-weight: 650; }
    strong { color: #0d1e35; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function isPublicTrackingBase(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && !host.endsWith(".local");
  } catch {
    return false;
  }
}

async function sendOpenPixel(req, res) {
  const token = cleanToken(req.params.token);
  if (TOKEN_RE.test(token) && req.method !== "HEAD") {
    try {
      const ok = await recordOpen(token);
      if (ok) console.log("Open recorded", token.slice(0, 8));
      else console.warn("Open pixel token not found", token.slice(0, 8));
    } catch (error) {
      console.error("Open tracking failed", error.message);
    }
  }
  res.set({
    "Content-Type": "image/gif",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
  if (req.method === "HEAD") return res.status(200).end();
  res.send(PIXEL);
}

// Tracking routes before static files so .gif open pixels are never missed.
app.get("/t/o/:token", sendOpenPixel);
app.head("/t/o/:token", sendOpenPixel);

app.get("/t/e/:token", async (req, res) => {
  try {
    const token = cleanToken(req.params.token);
    if (TOKEN_RE.test(token) && isDbReady()) {
      try {
        await ensureOpened(token);
      } catch (error) {
        console.error("Explore open fallback failed", error.message);
      }
      try {
        await recordExpertInterest(token);
      } catch (error) {
        console.error("Explore click tracking failed", error.message);
      }
    }
    const dest = String(
      process.env.BOOKING_URL || process.env.COMPANY_WEBSITE || "https://bestinfra.org/"
    ).trim() || "https://bestinfra.org/";
    res.redirect(302, dest);
  } catch (error) {
    console.error("Explore redirect failed", error.message);
    const dest = String(
      process.env.BOOKING_URL || process.env.COMPANY_WEBSITE || "https://bestinfra.org/"
    ).trim() || "https://bestinfra.org/";
    res.redirect(302, dest);
  }
});

app.get("/u/:token", async (req, res) => {
  try {
    const token = cleanToken(req.params.token);
    if (!TOKEN_RE.test(token) || !isDbReady()) {
      return res.status(404).type("html").send(page("Unsubscribe", "<h1>Link not found</h1><p>This unsubscribe link is not valid.</p>"));
    }
    const contact = await findUnsubscribe(token);
    if (!contact) {
      return res.status(404).type("html").send(page("Unsubscribe", "<h1>Link not found</h1><p>This unsubscribe link is not valid.</p>"));
    }
    if (contact.unsubscribed_at) {
      return res.type("html").send(page(
        "Unsubscribed",
        `<h1>You are unsubscribed</h1><p>${escapeHtml(contact.email)} will not receive further emails from us.</p>`
      ));
    }

    const confirmed = await confirmUnsubscribe(token);
    if (!confirmed) {
      return res.status(404).type("html").send(page("Unsubscribe", "<h1>Link not found</h1><p>This unsubscribe link is not valid.</p>"));
    }

    res.type("html").send(page(
      "Unsubscribed",
      `<h1>You are unsubscribed</h1><p>${escapeHtml(confirmed.email)} will not receive further emails from us.</p>`
    ));
  } catch (error) {
    res.status(500).type("html").send(page("Unsubscribe", `<h1>Something went wrong</h1><p>${escapeHtml(error.message)}</p>`));
  }
});

app.post("/u/:token", async (req, res) => {
  try {
    const token = cleanToken(req.params.token);
    if (!TOKEN_RE.test(token) || !isDbReady()) {
      return res.status(404).type("html").send(page("Unsubscribe", "<h1>Link not found</h1><p>This unsubscribe link is not valid.</p>"));
    }
    const contact = await confirmUnsubscribe(token);
    if (!contact) {
      return res.status(404).type("html").send(page("Unsubscribe", "<h1>Link not found</h1><p>This unsubscribe link is not valid.</p>"));
    }
    res.type("html").send(page(
      "Unsubscribed",
      `<h1>You are unsubscribed</h1><p>${escapeHtml(contact.email)} will not receive further emails from us.</p>`
    ));
  } catch (error) {
    res.status(500).type("html").send(page("Unsubscribe", `<h1>Something went wrong</h1><p>${escapeHtml(error.message)}</p>`));
  }
});

app.use(express.static(path.resolve("public")));

app.get("/tracker", (_req, res) => {
  res.sendFile(path.resolve("public/tracker.html"));
});

app.get("/api/templates", (_req, res) => {
  res.json({ templates: listTemplates() });
});

app.get("/api/status", async (_req, res) => {
  const smtp = await verifySmtp();
  const database = { ok: isDbReady(), error: isDbReady() ? "" : getDbError() };
  const sentCount = database.ok ? await countSends() : 0;
  const trackingBase = publicBaseUrl();
  const trackingPublic = isPublicTrackingBase(trackingBase);
  res.json({
    company: getCompanyProfile(),
    smtp,
    database,
    sentCount,
    tracking: {
      baseUrl: trackingBase,
      public: trackingPublic,
      warning: trackingPublic
        ? ""
        : "Open counts will not update from Gmail while PUBLIC_BASE_URL is localhost. On the server set PUBLIC_BASE_URL to your public HTTPS URL (e.g. https://13.234.152.158.sslip.io), restart the app, then send new emails.",
    },
  });
});

app.get("/api/history", requireDatabase, async (_req, res) => {
  try {
    const records = await listHistory();
    res.json({ records });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/preview", requireDatabase, receiveWorkbook, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload an Excel or CSV file." });
    }
    const template = getTemplate(req.body.templateId);
    if (!template) {
      return res.status(400).json({ error: "Choose an email template." });
    }
    const suppression = await loadSuppression(template.id);
    const parsed = parseWorkbook(req.file.buffer, template, suppression);
    res.json({
      filename: req.file.originalname,
      ...parsed,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/send", requireDatabase, receiveWorkbook, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload an Excel or CSV file." });
    }
    const template = getTemplate(req.body.templateId);
    if (!template) {
      return res.status(400).json({ error: "Choose an email template." });
    }
    if (hasActiveSendJob()) {
      return res.status(409).json({
        error: "A send job is already running. Wait for it to finish, then try again.",
      });
    }

    const smtp = await verifySmtp();
    if (!smtp.ok) {
      return res.status(400).json({ error: smtp.error });
    }

    const suppression = await loadSuppression(template.id);
    const parsed = parseWorkbook(req.file.buffer, template, suppression);
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: "queued",
      filename: req.file.originalname,
      templateName: template.name,
      total: parsed.total,
      readyCount: parsed.ready.length,
      processed: 0,
      sent: [],
      failed: [],
      skipped: parsed.skipped,
      error: "",
      createdAt: Date.now(),
    };
    sendJobs.set(jobId, job);

    // Return immediately so nginx never waits on the full SMTP batch.
    res.status(202).json(publicSendJob(job));

    setImmediate(() => {
      runSendJob(jobId, parsed.ready, template).catch((error) => {
        const active = sendJobs.get(jobId);
        if (!active) return;
        active.status = "failed";
        active.error = error.message || "Send job failed";
      });
    });

    // Drop finished jobs after 2 hours to limit memory use.
    setTimeout(() => sendJobs.delete(jobId), 2 * 60 * 60 * 1000).unref?.();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/send/:jobId", requireDatabase, (req, res) => {
  const job = sendJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Send job not found (it may have expired after a restart)." });
  }
  res.json(publicSendJob(job));
});

const port = Number(process.env.PORT || 3000);

await fs.mkdir(path.resolve("data"), { recursive: true });
await ensurePlaceholderAttachments();
await initStore();
if (!isDbReady()) {
  console.error(`Database not ready: ${getDbError()}`);
}

app.listen(port, () => {
  const base = publicBaseUrl();
  console.log(`Lead Emailer running at http://localhost:${port}`);
  if (!isPublicTrackingBase(base)) {
    console.warn(
      `Open tracking will not work from Gmail while PUBLIC_BASE_URL is "${base}". Set a public HTTPS URL.`
    );
  }
});
