import fs from "node:fs/promises";
import path from "node:path";
import { formatInterestList } from "./interests.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{{${key}}}`
  );
}

function ensureTracking(html, openPixelUrl, unsubscribeUrl) {
  let next = html;
  if (openPixelUrl && !next.includes(openPixelUrl)) {
    const pixel = `<img src="${escapeHtml(openPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
    next = next.includes("</body>") ? next.replace("</body>", `${pixel}\n</body>`) : `${next}${pixel}`;
  }
  if (unsubscribeUrl && !next.includes(unsubscribeUrl)) {
    const link = `<p style="text-align:center;margin:20px 0;"><a href="${escapeHtml(unsubscribeUrl)}" style="display:inline-block;padding:10px 18px;background:#f3f4f6;color:#374151;text-decoration:none;border-radius:999px;font-size:13px;font-weight:700;">Unsubscribe</a></p>`;
    next = next.includes("</body>") ? next.replace("</body>", `${link}\n</body>`) : `${next}${link}`;
  }
  return next;
}

function summitContent(lead) {
  const name = lead.name || "there";
  const labels = Array.isArray(lead.interests) && lead.interests.length
    ? lead.interests
    : [lead.interest].filter(Boolean);
  const fileCount = Array.isArray(lead.attachments) ? lead.attachments.length : 1;
  const area = formatInterestList(labels);
  const pluralInterest = labels.length > 1 ? "interests" : "interest";
  const brochureWord = fileCount > 1 ? "brochures" : "brochure";
  const orgClause =
    ` on behalf of <strong style="font-weight: 600;color:#163B7C">Best Infra Pvt Ltd</strong>`;

  const subject =
    labels.length > 1
      ? "Thank You for Visiting Us | Best Infra"
      : `Thank You for Visiting Us | ${area} | Best Infra`;

  const text = [
    `Hi ${name},`,
    "",
    "Thank you for visiting Best Infra at the Energy Efficiency Summit 2026.",
    "",
    "It was a pleasure connecting with you and discussing how smarter infrastructure and innovative energy solutions can create a more efficient and sustainable future.",
    "",
    `Based on your ${pluralInterest} in ${area} on behalf of Best Infra Pvt Ltd, we have attached relevant ${brochureWord} with this email.`,
    "",
    "About Best Infra",
    "At Best Infra, we bring together technology, infrastructure, and energy solutions to help organizations optimize resources, improve operational efficiency, and build a more sustainable future.",
    "",
    "Let's Continue the Conversation: https://bestinfra.org/",
    "",
    "Best Regards,",
    "Team Best Infra",
    "BUILDING A SUSTAINABLE TOMORROW",
    "",
    "www.bestinfra.org | marketrelations@bestinfra.tech | +91 9440409776",
  ];

  return {
    subject,
    text,
    vars: {
      LEAD_NAME: escapeHtml(name),
      LEAD_INTEREST: escapeHtml(area),
      LEAD_ORG_CLAUSE: orgClause,
      INTEREST_WORD: pluralInterest,
      BROCHURE_WORD: brochureWord,
    },
  };
}

function mergeContent(template, lead) {
  const vars = {};
  for (const [key, value] of Object.entries(lead.fields || {})) {
    vars[key.toUpperCase()] = escapeHtml(value);
  }
  if (!vars.NAME) vars.NAME = escapeHtml(lead.name || "there");
  const subjectTemplate = template.subject || template.name;
  const subject = fill(subjectTemplate, vars);
  const text = [
    lead.name ? `Hi ${lead.name},` : "Hello,",
    "",
    template.name,
  ];
  return { subject, text, vars };
}

export async function buildEmail({ template, lead, openPixelUrl, unsubscribeUrl, exploreUrl }) {
  const built = template.mode === "interest-brochures"
    ? summitContent(lead)
    : mergeContent(template, lead);

  const htmlSource = await fs.readFile(path.resolve(template.htmlPath), "utf8");
  const html = ensureTracking(fill(htmlSource, {
    ...built.vars,
    OPEN_PIXEL_URL: openPixelUrl || "",
    UNSUBSCRIBE_URL: unsubscribeUrl || "",
    EXPLORE_URL: exploreUrl || "https://bestinfra.org/",
  }), openPixelUrl, unsubscribeUrl);

  const text = [
    ...built.text,
    "",
    exploreUrl ? `Explore: ${exploreUrl}` : "",
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : "",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");

  return { subject: built.subject, html, text };
}
