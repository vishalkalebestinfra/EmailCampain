import fs from "fs/promises";
import path from "path";
import { INTERESTS } from "./interests.js";

function escapePdfText(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/[()]/g, "\\$&");
}

function wrap(text, width = 78) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function buildPdf({ title, brand, lines }) {
  const content = [
    "BT",
    "/F1 22 Tf",
    "50 760 Td",
    `(${escapePdfText(brand)}) Tj`,
    "0 -36 Td",
    "/F1 18 Tf",
    `(${escapePdfText(title)}) Tj`,
    "0 -28 Td",
    "/F1 11 Tf",
    "(Replace this placeholder with your real brochure PDF.) Tj",
    ...lines.flatMap((line) => ["0 -18 Td", `(${escapePdfText(line)}) Tj`]),
    "ET",
  ].join("\n");

  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${Buffer.byteLength(content)} >> stream\n${content}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += `${object}\n`;
  }
  const xrefPos = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(body, "utf8");
}

export async function ensurePlaceholderPdfs(attachmentsDir, brand) {
  await fs.mkdir(attachmentsDir, { recursive: true });
  const created = [];

  for (const interest of INTERESTS) {
    const filePath = path.join(attachmentsDir, interest.attachment);
    try {
      await fs.access(filePath);
      continue;
    } catch {
      const pdf = buildPdf({
        title: interest.label,
        brand,
        lines: wrap(interest.intro).concat([""], interest.highlights.map((item) => `• ${item}`)),
      });
      await fs.writeFile(filePath, pdf);
      created.push(interest.attachment);
    }
  }

  return created;
}
