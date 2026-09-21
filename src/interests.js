export const ATTACHMENT_FILES = {
  smartSolutions: "Smart Solutions.pdf",
  companyProfile: "Company Profile Exhibition.pdf",
  ev: "EV.pdf",
};

export const INTERESTS = [
  {
    id: "smart-metering-ami",
    label: "Smart Metering & AMI",
    aliases: ["smart metering & ami", "smart metering"],
    attachments: [ATTACHMENT_FILES.smartSolutions, ATTACHMENT_FILES.companyProfile],
  },
  {
    id: "electrical-infrastructure-epc",
    label: "Electrical Infrastructure / EPC",
    aliases: ["electrical infrastructure / epc", "electrical infrastructure"],
    attachments: [ATTACHMENT_FILES.smartSolutions, ATTACHMENT_FILES.companyProfile],
  },
  {
    id: "renewable-energy",
    label: "Renewable Energy",
    aliases: ["renewable energy"],
    attachments: [ATTACHMENT_FILES.ev, ATTACHMENT_FILES.companyProfile],
  },
  {
    id: "ev-charging-infrastructure",
    label: "EV Charging Infrastructure",
    aliases: ["ev charging infrastructure", "ev charging"],
    attachments: [ATTACHMENT_FILES.ev, ATTACHMENT_FILES.companyProfile],
  },
  {
    id: "bess-energy-storage",
    label: "BESS / Energy Storage",
    aliases: ["bess / energy storage", "energy storage"],
    attachments: [ATTACHMENT_FILES.companyProfile],
  },
  {
    id: "iot-smart-solutions",
    label: "IoT & Smart Solutions",
    aliases: ["iot & smart solutions"],
    attachments: [ATTACHMENT_FILES.smartSolutions, ATTACHMENT_FILES.companyProfile],
  },
  {
    id: "software-digital-solutions",
    label: "Software / Digital Solutions",
    aliases: ["software / digital solutions", "digital solutions"],
    attachments: [ATTACHMENT_FILES.smartSolutions, ATTACHMENT_FILES.companyProfile],
  },
  {
    id: "other",
    label: "Other",
    aliases: ["other", "other:"],
    attachments: [ATTACHMENT_FILES.companyProfile],
  },
];

export function normalizeInterest(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function uniquenessKey(email, interestLabel, templateId = "") {
  return [
    String(email).trim().toLowerCase(),
    String(templateId || "").trim(),
    normalizeInterest(interestLabel),
  ].join("::");
}

export function uniqueAttachmentNames(interests) {
  const seen = new Set();
  const files = [];
  const profile = ATTACHMENT_FILES.companyProfile;

  for (const interest of interests) {
    for (const file of interest.attachments || []) {
      if (file === profile || seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }

  const needsProfile = interests.some((item) => (item.attachments || []).includes(profile));
  if (needsProfile) files.push(profile);
  return files;
}

export function formatInterestList(labels) {
  const items = labels.filter(Boolean);
  if (!items.length) return "our solutions";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseInterests(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return [];

  const known = INTERESTS.filter((item) => item.id !== "other").sort(
    (a, b) => b.label.length - a.label.length
  );
  const found = [];
  let remaining = raw;

  for (const item of known) {
    const patterns = [item.label, ...(item.aliases || [])].sort((a, b) => b.length - a.length);
    for (const pattern of patterns) {
      const match = remaining.match(new RegExp(escapeRegExp(pattern), "i"));
      if (!match) continue;
    const originalIndex = raw.search(new RegExp(escapeRegExp(item.label), "i"));
      found.push({
        ...item,
        matchedLabel: item.label,
        index: originalIndex < 0 ? match.index : originalIndex,
      });
      remaining = `${remaining.slice(0, match.index)} ${remaining.slice(match.index + match[0].length)}`;
      break;
    }
  }

  remaining = remaining
    .replace(/[,;|/]+/g, " ")
    .replace(/\bother\b\s*:?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  found.sort((a, b) => a.index - b.index);

  if (remaining.length > 1) {
    found.push({
      ...INTERESTS.find((item) => item.id === "other"),
      matchedLabel: remaining,
    });
  }

  const seen = new Set();
  return found.filter((item) => {
    const key = item.id === "other" ? `other:${normalizeInterest(item.matchedLabel)}` : item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveInterest(rawValue) {
  return parseInterests(rawValue)[0] || {
    ...INTERESTS.find((item) => item.id === "other"),
    matchedLabel: "Other",
  };
}
