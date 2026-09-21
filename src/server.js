import "dotenv/config";
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
  recordOpen,
  rememberSent,
} from "./store.js";
import { ensurePlaceholderAttachments, sendReadyLeads, verifySmtp, getCompanyProfile } from "./mailer.js";
import { getTemplate, listTemplates } from "./templateCatalog.js";

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

const app = express();
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
app.use(express.static(path.resolve("public")));

app.get("/tracker", (_req, res) => {
  res.sendFile(path.resolve("public/tracker.html"));
});

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
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

app.get("/api/templates", (_req, res) => {
  res.json({ templates: listTemplates() });
});

app.get("/api/status", async (_req, res) => {
  const smtp = await verifySmtp();
  const database = { ok: isDbReady(), error: isDbReady() ? "" : getDbError() };
  const sentCount = database.ok ? await countSends() : 0;
  res.json({
    company: getCompanyProfile(),
    smtp,
    database,
    sentCount,
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

app.get("/t/o/:token", async (req, res) => {
  const token = cleanToken(req.params.token);
  if (TOKEN_RE.test(token)) {
    try {
      await recordOpen(token);
    } catch (error) {
      console.error("Open tracking failed", error.message);
    }
  }
  res.set({
    "Content-Type": "image/gif",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
  });
  res.send(PIXEL);
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
    res.type("html").send(page(
      "Unsubscribe",
      `<h1>Unsubscribe</h1>
       <p>Stop emails to ${escapeHtml(contact.email)}?</p>
       <form method="post" action="/u/${encodeURIComponent(token)}">
         <button type="submit">Confirm unsubscribe</button>
       </form>`
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

    const smtp = await verifySmtp();
    if (!smtp.ok) {
      return res.status(400).json({ error: smtp.error });
    }

    const suppression = await loadSuppression(template.id);
    const parsed = parseWorkbook(req.file.buffer, template, suppression);
    const sendResults = await sendReadyLeads(parsed.ready, template);
    const sent = sendResults.filter((row) => row.status === "sent");
    await rememberSent(sent);

    res.json({
      filename: req.file.originalname,
      templateName: template.name,
      total: parsed.total,
      sent,
      failed: sendResults.filter((row) => row.status === "failed"),
      skipped: parsed.skipped,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const port = Number(process.env.PORT || 3000);

await fs.mkdir(path.resolve("data"), { recursive: true });
await ensurePlaceholderAttachments();
await initStore();
if (!isDbReady()) {
  console.error(`Database not ready: ${getDbError()}`);
}

app.listen(port, () => {
  console.log(`Lead Emailer running at http://localhost:${port}`);
});
