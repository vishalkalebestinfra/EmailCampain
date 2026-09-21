import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ATTACHMENT_FILES, INTERESTS } from "./interests.js";
import { publicBaseUrl } from "./store.js";
import { buildEmail } from "./templates.js";
import {
  createSecureTransporter,
  isSmtpConfigured,
  maskEmailForLogs,
  resolveSmtpFromAddress,
  sendSafeMail,
  serializeMailError,
} from "./safeMail.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensurePlaceholderAttachments() {
  await fs.mkdir(path.resolve("attachments"), { recursive: true });
}

function allowedAttachmentPath(filename) {
  const allowed = new Set([
    ...Object.values(ATTACHMENT_FILES),
    ...INTERESTS.flatMap((item) => item.attachments || []),
  ]);
  const base = path.basename(filename);
  if (!allowed.has(base)) return null;
  const root = path.resolve("attachments");
  const fullPath = path.resolve(root, base);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) return null;
  return fullPath;
}

async function loadBrochureBuffer(filename) {
  const fullPath = allowedAttachmentPath(filename);
  if (!fullPath) return null;
  try {
    const content = await fs.readFile(fullPath);
    return { filename: path.basename(fullPath), content, contentType: "application/pdf" };
  } catch {
    return null;
  }
}

export function getCompanyProfile() {
  return {
    name: process.env.COMPANY_NAME || "Your Company",
    website: process.env.COMPANY_WEBSITE || "",
    email: process.env.COMPANY_EMAIL || process.env.SMTP_FROM || "",
    phone: process.env.COMPANY_PHONE || "",
  };
}

export async function verifySmtp() {
  if (!isSmtpConfigured()) {
    return {
      ok: false,
      error: "Set Zoho SMTP_USER and SMTP_PASS in .env (full mailbox + password or app password).",
    };
  }
  const transport = createSecureTransporter();
  if (!transport) {
    return { ok: false, error: "SMTP transport could not be created." };
  }
  try {
    const timeoutMs = Number(process.env.SMTP_TIMEOUT_MS || 10000);
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("SMTP verification timed out")), timeoutMs);
    });
    await Promise.race([transport.verify(), timeout]);
    return { ok: true };
  } catch (error) {
    const details = serializeMailError(error);
    const message = details.message || "Mail send failed";
    if (/535|authentication failed|invalid login/i.test(message)) {
      return {
        ok: false,
        error:
          `${message}. Check SMTP_USER/SMTP_PASS (use a Zoho app password if 2FA is on), ` +
          "and SMTP_HOST (smtppro.zoho.in for custom-domain Workplace).",
      };
    }
    return { ok: false, error: message };
  }
}

export async function sendLeadEmail(lead, template, transport) {
  const from = resolveSmtpFromAddress();
  if (!from) throw new Error("SMTP From address is missing.");

  const deliveryId = crypto.randomUUID();
  const trackingToken = crypto.randomBytes(24).toString("base64url");
  const unsubscribeToken = crypto.randomBytes(24).toString("base64url");
  const base = publicBaseUrl();
  const openPixelUrl = `${base}/t/o/${trackingToken}.gif`;
  const unsubscribeUrl = `${base}/u/${unsubscribeToken}`;
  const exploreUrl = `${base}/t/e/${trackingToken}`;
  const { subject, html, text } = await buildEmail({
    template,
    lead,
    openPixelUrl,
    unsubscribeUrl,
    exploreUrl,
  });

  const files = template.mode === "interest-brochures" && Array.isArray(lead.attachments)
    ? lead.attachments
    : [];
  const attachments = [];
  for (const filename of files) {
    const brochure = await loadBrochureBuffer(filename);
    if (brochure) attachments.push(brochure);
  }

  if (template.mode === "interest-brochures" && !attachments.length) {
    throw new Error(`No brochure files found in attachments/ for ${lead.interest || "this interest"}`);
  }

  const mailer = transport || createSecureTransporter();
  if (!mailer) throw new Error("SMTP is not configured.");

  const info = await sendSafeMail(
    mailer,
    { from, to: lead.email, subject, text, html },
    attachments
  );

  console.log(`Sent ${lead.interest} mail to ${maskEmailForLogs(lead.email)} with ${attachments.map((item) => item.filename).join(", ")}`);

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    subject,
    deliveryId,
    trackingToken,
    unsubscribeToken,
    attachment: attachments.map((item) => item.filename).join(", ") || "—",
    attachments: attachments.map((item) => item.filename),
  };
}

export async function sendReadyLeads(leads, template, onProgress) {
  const delay = Number(process.env.SEND_DELAY_MS || 800);
  const transport = createSecureTransporter();
  if (!transport) throw new Error("SMTP is not configured.");
  const results = [];

  for (const [index, lead] of leads.entries()) {
    try {
      const sent = await sendLeadEmail(lead, template, transport);
      const result = {
        ...lead,
        templateId: template.id,
        templateName: template.name,
        status: "sent",
        reason: "Email sent",
        messageId: sent.messageId,
        subject: sent.subject,
        deliveryId: sent.deliveryId,
        trackingToken: sent.trackingToken,
        unsubscribeToken: sent.unsubscribeToken,
        attachment: sent.attachment,
        sentAt: new Date().toISOString(),
      };
      results.push(result);
      onProgress?.({ index, total: leads.length, result });
    } catch (error) {
      const details = serializeMailError(error);
      const result = {
        ...lead,
        status: "failed",
        reason: details.message,
      };
      results.push(result);
      onProgress?.({ index, total: leads.length, result });
    }

    if (index < leads.length - 1 && delay > 0) {
      await sleep(delay);
    }
  }

  return results;
}
