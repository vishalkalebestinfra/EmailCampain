import XLSX from "xlsx";
import {
  formatInterestList,
  parseInterests,
  uniqueAttachmentNames,
  uniquenessKey,
} from "./interests.js";
import { columnsForTemplate } from "./templateCatalog.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapHeaders(headers, columns) {
  const mapped = {};
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    for (const column of columns) {
      if (column.aliases.some((alias) => normalized === alias || normalized.startsWith(alias))) {
        mapped[header] = column.key;
        break;
      }
    }
  }
  return mapped;
}

function pick(row, headerMap, field) {
  const header = Object.keys(headerMap).find((key) => headerMap[key] === field);
  if (!header) return "";
  const value = row[header];
  if (value == null) return "";
  return String(value).trim();
}

function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

function rowPayload(base, interests, extra = {}) {
  const labels = interests.map((item) => item.matchedLabel);
  const files = uniqueAttachmentNames(interests);
  return {
    ...base,
    interest: labels.length ? formatInterestList(labels) : "",
    interests: labels,
    interestIds: interests.map((item) => item.id),
    attachment: files.join(", ") || "—",
    attachments: files,
    ...extra,
  };
}

function emptyInterestRow(base, extra = {}) {
  return rowPayload(base, [], extra);
}

export function parseWorkbook(buffer, template, suppression) {
  const columns = columnsForTemplate(template);
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("The spreadsheet has no sheets.");
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  if (!rows.length) {
    throw new Error("The spreadsheet has no data rows.");
  }

  const headerMap = mapHeaders(Object.keys(rows[0]), columns);
  const missing = columns.filter((column) => column.required && !Object.values(headerMap).includes(column.key));
  if (missing.length) {
    const names = missing.map((column) => column.label).join(", ");
    throw new Error(`This template needs these columns: ${names}.`);
  }

  const useInterests = template.mode === "interest-brochures";
  const seenInFile = new Set();
  const classified = rows.map((row, index) => {
    const fields = {};
    for (const column of columns) {
      fields[column.key] = pick(row, headerMap, column.key);
    }

    const base = {
      excelRow: index + 2,
      templateId: template.id,
      name: fields.name || "",
      company: fields.company || "",
      mobile: fields.mobile || "",
      timestamp: fields.timestamp || "",
      email: String(fields.email || "").toLowerCase(),
      fields,
    };

    const parsedInterests = useInterests ? parseInterests(fields.interest) : [];

    const describe = (extra) => (
      useInterests ? rowPayload(base, parsedInterests, extra) : emptyInterestRow(base, extra)
    );

    if (!base.email) {
      return describe({ status: "skipped", reason: "No email present" });
    }

    if (!isValidEmail(base.email)) {
      return describe({ status: "skipped", reason: "Invalid email" });
    }

    if (suppression.unsubscribed.has(base.email)) {
      return describe({ status: "skipped", reason: "Unsubscribed" });
    }

    const missingValue = columns.find((column) => column.required && column.key !== "email" && column.key !== "interest" && !fields[column.key]);
    if (missingValue) {
      return describe({ status: "skipped", reason: `Missing ${missingValue.label}` });
    }

    if (!useInterests) {
      const key = uniquenessKey(base.email, "");
      if (seenInFile.has(key)) {
        return emptyInterestRow(base, { status: "skipped", reason: "Duplicate email in this file" });
      }
      if (suppression.sentKeys.has(key)) {
        return emptyInterestRow(base, { status: "skipped", reason: "Already emailed with this template" });
      }
      seenInFile.add(key);
      return emptyInterestRow(base, { status: "ready", reason: "Unique email for this template" });
    }

    if (!parsedInterests.length) {
      return rowPayload(base, parsedInterests, {
        status: "skipped",
        reason: "No area of interest selected",
      });
    }

    const fresh = [];
    const already = [];
    const inFile = [];

    for (const interest of parsedInterests) {
      const key = uniquenessKey(base.email, interest.matchedLabel);
      if (seenInFile.has(key)) {
        inFile.push(interest);
        continue;
      }
      if (suppression.sentKeys.has(key)) {
        already.push(interest);
        continue;
      }
      seenInFile.add(key);
      fresh.push(interest);
    }

    if (!fresh.length) {
      const reason = already.length
        ? "Already emailed for these areas of interest"
        : "Duplicate email + area of interest in this file";
      return rowPayload(base, parsedInterests, { status: "skipped", reason });
    }

    const skippedBits = [];
    if (already.length) skippedBits.push(`${formatInterestList(already.map((item) => item.matchedLabel))} already emailed`);
    if (inFile.length) skippedBits.push(`${formatInterestList(inFile.map((item) => item.matchedLabel))} already in this file`);

    return rowPayload(base, fresh, {
      status: "ready",
      reason: skippedBits.length
        ? `Sending new interests only (${skippedBits.join("; ")})`
        : "Unique email + area of interest",
      selectedInterests: parsedInterests.map((item) => item.matchedLabel),
    });
  });

  return {
    sheetName,
    templateId: template.id,
    templateName: template.name,
    total: classified.length,
    ready: classified.filter((row) => row.status === "ready"),
    skipped: classified.filter((row) => row.status === "skipped"),
    rows: classified,
  };
}
