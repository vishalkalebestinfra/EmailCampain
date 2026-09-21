import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { uniquenessKey } from "./interests.js";
import { getTemplate, SUMMIT_TEMPLATE_ID } from "./templateCatalog.js";

const { Pool } = pg;
const STORE_PATH = path.resolve("data/sent-records.json");
const STORE_MIGRATED_PATH = path.resolve("data/sent-records.json.migrated");

let pool = null;
let readyError = "Database is not connected.";

function databaseError(error) {
  const message = error?.message || "Could not connect to PostgreSQL.";
  if (message.includes("://") || message.includes("DATABASE_URL")) {
    return "Could not connect to PostgreSQL. Check DATABASE_URL in .env.";
  }
  return message;
}

export function getDbError() {
  return readyError;
}

export function isDbReady() {
  return Boolean(pool) && !readyError;
}

export function publicBaseUrl() {
  const configured = String(process.env.PUBLIC_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (configured) return configured;
  const port = Number(process.env.PORT || 3000);
  return `http://localhost:${port}`;
}

export async function initDb() {
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  if (!connectionString) {
    readyError = "Set DATABASE_URL in .env to a PostgreSQL connection string.";
    pool = null;
    return;
  }

  const nextPool = new Pool({ connectionString });
  try {
    await nextPool.query("SELECT 1");
    pool = nextPool;
    await ensureSchema();
    await migrateSentRecords();
    readyError = null;
  } catch (error) {
    readyError = databaseError(error);
    await nextPool.end().catch(() => {});
    if (pool === nextPool) pool = null;
    else pool = null;
  }
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      unsubscribed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS sends (
      id UUID PRIMARY KEY,
      delivery_id UUID NOT NULL,
      email TEXT NOT NULL REFERENCES contacts (email),
      template_id TEXT NOT NULL,
      template_name TEXT NOT NULL DEFAULT '',
      interest TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      sent_at TIMESTAMPTZ NOT NULL,
      opened_at TIMESTAMPTZ,
      open_count INTEGER NOT NULL DEFAULT 0,
      last_opened_at TIMESTAMPTZ,
      expert_clicked_at TIMESTAMPTZ,
      expert_click_count INTEGER NOT NULL DEFAULT 0,
      last_expert_clicked_at TIMESTAMPTZ,
      tracking_token TEXT NOT NULL UNIQUE,
      unsubscribe_token TEXT NOT NULL UNIQUE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS sends_email_template_interest
      ON sends (email, template_id, interest);

    CREATE INDEX IF NOT EXISTS sends_delivery_id ON sends (delivery_id);
  `);

  await pool.query(`
    ALTER TABLE sends
    ADD COLUMN IF NOT EXISTS template_name TEXT NOT NULL DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE sends
    ADD COLUMN IF NOT EXISTS expert_clicked_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE sends
    ADD COLUMN IF NOT EXISTS expert_click_count INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE sends
    ADD COLUMN IF NOT EXISTS last_expert_clicked_at TIMESTAMPTZ
  `);

  await pool.query(`
    UPDATE sends AS s
    SET template_name = COALESCE(NULLIF(s.template_name, ''), $2)
    WHERE s.template_id = $1 AND (s.template_name IS NULL OR s.template_name = '')
  `, [SUMMIT_TEMPLATE_ID, getTemplate(SUMMIT_TEMPLATE_ID)?.name || "Energy Summit thank-you"]);
}

function stableToken(prefix, key) {
  const digest = crypto.createHash("sha256").update(`${prefix}:${key}`).digest("base64url");
  return digest.slice(0, 43);
}

function templateNameFor(templateId, fallback = "") {
  return getTemplate(templateId)?.name || fallback || templateId || "";
}

async function migrateSentRecords() {
  let raw;
  try {
    raw = await fs.readFile(STORE_PATH, "utf8");
  } catch {
    return;
  }

  let records = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) records = parsed;
    else if (parsed && Array.isArray(parsed.records)) records = parsed.records;
  } catch {
    return;
  }

  const seen = new Set();
  for (const record of records) {
    const email = String(record.email || "").trim().toLowerCase();
    const interest = String(record.interest || "").trim();
    if (!email) continue;
    const templateId = String(record.templateId || SUMMIT_TEMPLATE_ID).trim() || SUMMIT_TEMPLATE_ID;
    const templateName = String(record.templateName || "").trim() || templateNameFor(templateId);
    const dedupe = uniquenessKey(email, interest, templateId);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const sentAt = record.sentAt ? new Date(record.sentAt) : new Date();
    const when = Number.isNaN(sentAt.getTime()) ? new Date() : sentAt;
    const id = crypto.randomUUID();
    const key = record.key || dedupe;

    await pool.query(
      `INSERT INTO contacts (email, name)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE
       SET name = CASE WHEN contacts.name = '' THEN EXCLUDED.name ELSE contacts.name END`,
      [email, String(record.name || "")]
    );

    await pool.query(
      `INSERT INTO sends (
         id, delivery_id, email, template_id, template_name, interest, name, company, subject,
         message_id, sent_at, tracking_token, unsubscribe_token
       ) VALUES (
         $1, $1, $2, $3, $4, $5, $6, $7, '',
         $8, $9, $10, $11
       )
       ON CONFLICT (email, template_id, interest) DO UPDATE
       SET template_name = CASE
         WHEN sends.template_name = '' THEN EXCLUDED.template_name
         ELSE sends.template_name
       END`,
      [
        id,
        email,
        templateId,
        templateName,
        interest,
        String(record.name || ""),
        String(record.company || ""),
        String(record.messageId || ""),
        when,
        stableToken("track", key),
        stableToken("unsub", key),
      ]
    );
  }

  try {
    await fs.rename(STORE_PATH, STORE_MIGRATED_PATH);
  } catch {
    try {
      await fs.writeFile(STORE_PATH, `${JSON.stringify({ records: [] }, null, 2)}\n`, "utf8");
    } catch {
      // ignore archive failures; DB is the source of truth
    }
  }
}

export async function countSends() {
  if (!isDbReady()) return 0;
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM sends");
  return result.rows[0]?.count || 0;
}

export async function loadSuppression(templateId) {
  const sent = await pool.query(
    "SELECT email, interest, template_id FROM sends WHERE template_id = $1",
    [templateId]
  );
  const unsubscribed = await pool.query(
    "SELECT email FROM contacts WHERE unsubscribed_at IS NOT NULL"
  );
  return {
    sentKeys: new Set(
      sent.rows.map((row) => uniquenessKey(row.email, row.interest, row.template_id || templateId))
    ),
    unsubscribed: new Set(unsubscribed.rows.map((row) => row.email)),
  };
}

export async function rememberSent(entries) {
  if (!isDbReady()) {
    throw new Error(getDbError() || "Database is not connected.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const entry of entries) {
      const email = String(entry.email || "").trim().toLowerCase();
      if (!email) continue;
      const labels = Array.isArray(entry.interests) && entry.interests.length
        ? entry.interests.filter(Boolean)
        : [entry.interest].filter(Boolean);
      const interests = labels.length ? labels : [""];
      const deliveryId = entry.deliveryId || crypto.randomUUID();
      const sentAt = entry.sentAt ? new Date(entry.sentAt) : new Date();
      const templateId = String(entry.templateId || "").trim();
      const templateName = String(entry.templateName || "").trim() || templateNameFor(templateId);

      await client.query(
        `INSERT INTO contacts (email, name)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE
         SET name = CASE WHEN contacts.name = '' THEN EXCLUDED.name ELSE contacts.name END`,
        [email, String(entry.name || "")]
      );

      for (const [index, interest] of interests.entries()) {
        const trackingToken = index === 0
          ? entry.trackingToken
          : crypto.randomBytes(24).toString("base64url");
        const unsubscribeToken = index === 0
          ? entry.unsubscribeToken
          : crypto.randomBytes(24).toString("base64url");
        await client.query(
          `INSERT INTO sends (
             id, delivery_id, email, template_id, template_name, interest, name, company, subject,
             message_id, sent_at, tracking_token, unsubscribe_token
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13
           )
           ON CONFLICT (email, template_id, interest) DO NOTHING`,
          [
            crypto.randomUUID(),
            deliveryId,
            email,
            templateId,
            templateName,
            String(interest || ""),
            String(entry.name || ""),
            String(entry.company || ""),
            String(entry.subject || ""),
            String(entry.messageId || ""),
            sentAt,
            trackingToken,
            unsubscribeToken,
          ]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listHistory() {
  const result = await pool.query(
    `SELECT
       s.delivery_id,
       s.email,
       s.template_id,
       s.template_name,
       s.interest,
       s.name,
       s.company,
       s.sent_at,
       s.opened_at,
       s.open_count,
       s.last_opened_at,
       s.expert_clicked_at,
       s.expert_click_count,
       s.last_expert_clicked_at,
       s.message_id,
       c.unsubscribed_at
     FROM sends s
     JOIN contacts c ON c.email = s.email
     ORDER BY s.sent_at DESC`
  );
  return result.rows.map((row) => {
    const template = getTemplate(row.template_id);
    return {
      deliveryId: row.delivery_id,
      email: row.email,
      templateId: row.template_id,
      templateName: row.template_name || template?.name || row.template_id,
      interest: row.interest,
      name: row.name,
      company: row.company,
      sentAt: row.sent_at,
      openedAt: row.opened_at,
      openCount: row.open_count,
      lastOpenedAt: row.last_opened_at,
      expertClickedAt: row.expert_clicked_at,
      expertClickCount: row.expert_click_count,
      lastExpertClickedAt: row.last_expert_clicked_at,
      messageId: row.message_id,
      unsubscribedAt: row.unsubscribed_at,
    };
  });
}

export async function recordOpen(token) {
  if (!isDbReady() || !token) return false;
  const result = await pool.query(
    `UPDATE sends AS target
     SET opened_at = COALESCE(target.opened_at, NOW()),
         last_opened_at = NOW(),
         open_count = target.open_count + 1
     WHERE target.delivery_id = (
       SELECT delivery_id FROM sends WHERE tracking_token = $1 LIMIT 1
     )
     RETURNING target.id`,
    [token]
  );
  return result.rowCount > 0;
}

/** Marks as opened without inflating count when Explore is clicked and the pixel never loaded. */
export async function ensureOpened(token) {
  if (!isDbReady() || !token) return false;
  const result = await pool.query(
    `UPDATE sends AS target
     SET opened_at = COALESCE(target.opened_at, NOW()),
         last_opened_at = COALESCE(target.last_opened_at, NOW()),
         open_count = CASE WHEN target.open_count = 0 THEN 1 ELSE target.open_count END
     WHERE target.delivery_id = (
       SELECT delivery_id FROM sends WHERE tracking_token = $1 LIMIT 1
     )
     RETURNING target.id`,
    [token]
  );
  return result.rowCount > 0;
}

export async function recordExpertInterest(token) {
  if (!isDbReady() || !token) return null;

  const updated = await pool.query(
    `UPDATE sends AS target
     SET expert_clicked_at = COALESCE(target.expert_clicked_at, NOW()),
         last_expert_clicked_at = NOW(),
         expert_click_count = target.expert_click_count + 1
     WHERE target.delivery_id = (
       SELECT delivery_id FROM sends WHERE tracking_token = $1
     )
     RETURNING
       target.email,
       target.name,
       target.company,
       target.interest,
       target.template_id,
       target.template_name,
       target.expert_click_count,
       target.expert_clicked_at,
       target.last_expert_clicked_at`,
    [token]
  );

  if (!updated.rows.length) return null;

  const byEmail = new Map();
  for (const row of updated.rows) {
    const email = row.email;
    const existing = byEmail.get(email);
    if (!existing) {
      byEmail.set(email, {
        email: row.email,
        name: row.name || "",
        company: row.company || "",
        interests: row.interest ? [row.interest] : [],
        templateId: row.template_id,
        templateName: row.template_name || templateNameFor(row.template_id),
        expertClickCount: row.expert_click_count,
        expertClickedAt: row.expert_clicked_at,
        lastExpertClickedAt: row.last_expert_clicked_at,
      });
      continue;
    }
    if (row.interest && !existing.interests.includes(row.interest)) {
      existing.interests.push(row.interest);
    }
    existing.expertClickCount = Math.max(existing.expertClickCount, row.expert_click_count);
  }

  return [...byEmail.values()][0] || null;
}

export async function findUnsubscribe(token) {
  if (!isDbReady() || !token) return null;
  const result = await pool.query(
    `SELECT c.email, c.unsubscribed_at
     FROM sends s
     JOIN contacts c ON c.email = s.email
     WHERE s.unsubscribe_token = $1`,
    [token]
  );
  return result.rows[0] || null;
}

export async function confirmUnsubscribe(token) {
  const result = await pool.query(
    `UPDATE contacts AS c
     SET unsubscribed_at = COALESCE(c.unsubscribed_at, NOW())
     FROM sends s
     WHERE s.unsubscribe_token = $1
       AND c.email = s.email
     RETURNING c.email, c.unsubscribed_at`,
    [token]
  );
  return result.rows[0] || null;
}
