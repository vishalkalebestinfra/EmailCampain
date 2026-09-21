/**
 * Safe mail composition boundary for Nodemailer.
 * Only from/to/subject/text/html are composed here. Filesystem paths and URLs
 * cannot reach the transport. Brochures are attached as Buffers only.
 */
import nodemailer from "nodemailer";

const FORBIDDEN_MESSAGE_KEYS = [
  "raw",
  "attachments",
  "envelope",
  "list",
  "headers",
  "icalEvent",
  "alternatives",
];

const PLACEHOLDER_USERS = new Set(["you@gmail.com", "you@yourdomain.com", "info@example.com"]);
const PLACEHOLDER_PASSWORDS = new Set(["your-app-password", "your-zoho-password"]);

export function maskEmailForLogs(email) {
  const trimmed = String(email || "").trim();
  const at = trimmed.indexOf("@");
  if (at <= 0) return "[redacted-email]";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

export function resolveSmtpFromAddress() {
  const from = stripQuotes(process.env.SMTP_FROM);
  if (from) return from;
  const email = stripQuotes(process.env.SMTP_FROM_EMAIL) || stripQuotes(process.env.SMTP_USER);
  if (!email) return "";
  const name = stripQuotes(process.env.SMTP_FROM_NAME) || stripQuotes(process.env.COMPANY_NAME);
  return name ? `${name} <${email}>` : email;
}

export function resolveSmtpPassword() {
  return stripQuotes(process.env.SMTP_PASS ?? process.env.SMTP_PASSWORD ?? "");
}

export function isSmtpConfigured() {
  const user = stripQuotes(process.env.SMTP_USER);
  const pass = resolveSmtpPassword();
  const host = stripQuotes(process.env.SMTP_HOST);
  if (!host || !user || !pass) return false;
  if (PLACEHOLDER_USERS.has(user.toLowerCase())) return false;
  if (PLACEHOLDER_PASSWORDS.has(pass)) return false;
  return true;
}

export function serializeMailError(err) {
  if (err && typeof err === "object") {
    const maybe = err;
    return {
      name: typeof maybe.name === "string" ? maybe.name : undefined,
      message: typeof maybe.message === "string" ? maybe.message : "Mail send failed",
      code: typeof maybe.code === "string" ? maybe.code : undefined,
    };
  }
  return { message: "Mail send failed" };
}

export function assertSafeMailMessage(message) {
  if (!message || typeof message !== "object") {
    throw new Error("Mail message must be an object");
  }

  for (const key of FORBIDDEN_MESSAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(message, key)) {
      throw new Error(`Unsafe mail option "${key}" is not allowed`);
    }
  }

  const { from, to, subject, text, html } = message;
  for (const [name, value] of [
    ["from", from],
    ["to", to],
    ["subject", subject],
    ["text", text],
    ["html", html],
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Mail field "${name}" must be a non-empty string`);
    }
  }

  return { from, to, subject, text, html };
}

export function createSecureTransporter() {
  if (!isSmtpConfigured()) return null;

  const user = stripQuotes(process.env.SMTP_USER);
  const pass = resolveSmtpPassword();
  const port = Number(process.env.SMTP_PORT || 465);
  const timeoutMs = Number(process.env.SMTP_TIMEOUT_MS || 10000);
  const secure = String(process.env.SMTP_SECURE || "true") === "true" || port === 465;

  return nodemailer.createTransport({
    host: stripQuotes(process.env.SMTP_HOST),
    port,
    secure,
    requireTLS: !secure && port === 587,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    auth: { user, pass },
  });
}

function stripQuotes(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function assertBufferAttachments(attachments) {
  if (!attachments?.length) return [];
  return attachments.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Attachment ${index} is invalid`);
    }
    if (item.path || item.href || item.raw) {
      throw new Error("Filesystem/URL attachments cannot reach the transport");
    }
    const filename = String(item.filename || "").replace(/^.*[\\/]/, "");
    if (!filename) throw new Error(`Attachment ${index} is missing a filename`);
    if (!Buffer.isBuffer(item.content)) {
      throw new Error(`Attachment ${index} must be an in-memory Buffer`);
    }
    return {
      filename,
      content: item.content,
      contentType: item.contentType || "application/pdf",
    };
  });
}

export async function sendSafeMail(transport, message, attachments = []) {
  const safe = assertSafeMailMessage(message);
  const files = assertBufferAttachments(attachments);
  return transport.sendMail({
    from: safe.from,
    to: safe.to,
    subject: safe.subject,
    text: safe.text,
    html: safe.html,
    disableFileAccess: true,
    disableUrlAccess: true,
    ...(files.length ? { attachments: files } : {}),
  });
}
