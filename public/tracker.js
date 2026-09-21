const templateFilter = document.querySelector("#templateFilter");
const searchInput = document.querySelector("#searchInput");
const trackerList = document.querySelector("#trackerList");
const trackingWarning = document.querySelector("#trackingWarning");
const refreshBtn = document.querySelector("#refreshBtn");

let records = [];
let loadError = "";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatWhen(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function groupRecords(rows) {
  const groups = new Map();
  for (const record of rows) {
    const key = record.deliveryId || `${record.email}::${record.templateId}::${record.sentAt}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...record,
        interests: record.interest ? [record.interest] : [],
        openCount: Number(record.openCount || 0),
        expertClickCount: Number(record.expertClickCount || 0),
      });
      continue;
    }
    if (record.interest && !existing.interests.includes(record.interest)) {
      existing.interests.push(record.interest);
    }
    existing.openCount = Math.max(existing.openCount, Number(record.openCount || 0));
    existing.expertClickCount = Math.max(existing.expertClickCount, Number(record.expertClickCount || 0));
    if (record.openedAt && (!existing.openedAt || new Date(record.openedAt) < new Date(existing.openedAt))) {
      existing.openedAt = record.openedAt;
    }
    if (record.lastOpenedAt && (!existing.lastOpenedAt || new Date(record.lastOpenedAt) > new Date(existing.lastOpenedAt))) {
      existing.lastOpenedAt = record.lastOpenedAt;
    }
    if (record.expertClickedAt && (!existing.expertClickedAt || new Date(record.expertClickedAt) < new Date(existing.expertClickedAt))) {
      existing.expertClickedAt = record.expertClickedAt;
    }
    if (record.unsubscribedAt) existing.unsubscribedAt = record.unsubscribedAt;
  }
  return [...groups.values()];
}

function filteredRecords() {
  const templateId = templateFilter.value;
  const query = searchInput.value.trim().toLowerCase();
  return groupRecords(records).filter((record) => {
    if (templateId && record.templateId !== templateId) return false;
    if (!query) return true;
    const haystack = [
      record.email,
      record.name,
      record.company,
      record.templateName,
      ...(record.interests || []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function metric(label, value, tone = "") {
  return `<div class="metric ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function render() {
  if (loadError) {
    document.querySelector("#statSent").textContent = "0";
    document.querySelector("#statOpened").textContent = "0";
    document.querySelector("#statOpenCount").textContent = "0";
    document.querySelector("#statExpert").textContent = "0";
    document.querySelector("#trackerCaption").textContent = "Could not load send history.";
    trackerList.innerHTML = `<div class="empty-card">${escapeHtml(loadError)}</div>`;
    return;
  }

  const rows = filteredRecords();
  const opened = rows.filter((record) => record.openedAt).length;
  const totalOpens = rows.reduce((sum, record) => sum + Number(record.openCount || 0), 0);
  const exploreClicks = rows.filter((record) => record.expertClickedAt).length;

  document.querySelector("#statSent").textContent = rows.length;
  document.querySelector("#statOpened").textContent = opened;
  document.querySelector("#statOpenCount").textContent = totalOpens;
  document.querySelector("#statExpert").textContent = exploreClicks;

  const selected = templateFilter.selectedOptions[0]?.textContent || "All templates";
  document.querySelector("#trackerCaption").textContent = templateFilter.value
    ? `${selected} · ${rows.length} deliveries · ${totalOpens} opens · ${exploreClicks} Explore`
    : `${rows.length} deliveries · ${totalOpens} opens · ${exploreClicks} Explore`;

  if (!rows.length) {
    trackerList.innerHTML = `<div class="empty-card">No matching emails.</div>`;
    return;
  }

  trackerList.innerHTML = rows
    .map((record) => {
      const interests = (record.interests || []).filter(Boolean);
      const interestHtml = interests.length
        ? interests.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")
        : `<span class="chip muted">No interest tagged</span>`;
      const statusTone = record.unsubscribedAt ? "bad" : record.openedAt ? "ok" : "muted";
      const statusLabel = record.unsubscribedAt
        ? "Unsubscribed"
        : record.openedAt
          ? "Opened"
          : "Not opened";

      return `
      <article class="activity-card">
        <div class="activity-main">
          <div class="activity-identity">
            <h4>${escapeHtml(record.name || "Unknown lead")}</h4>
            <p class="activity-email">${escapeHtml(record.email)}</p>
            <p class="activity-meta">${escapeHtml(record.company || "No company")} · ${escapeHtml(record.templateName || "—")}</p>
          </div>
          <div class="activity-status">
            <span class="badge ${statusTone === "ok" ? "opened" : statusTone === "bad" ? "failed" : "unopened"}">${statusLabel}</span>
            <span class="activity-time">${escapeHtml(formatWhen(record.sentAt))}</span>
          </div>
        </div>
        <div class="interest-row">${interestHtml}</div>
        <div class="metric-row">
          ${metric("Opens", record.openCount || 0, record.openCount ? "ok" : "")}
          ${metric("Last open", record.lastOpenedAt ? formatWhen(record.lastOpenedAt) : "—")}
          ${metric("Explore", record.expertClickCount || 0, record.expertClickCount ? "ok" : "")}
          ${metric("Unsubscribed", record.unsubscribedAt ? formatWhen(record.unsubscribedAt) : "No", record.unsubscribedAt ? "bad" : "")}
        </div>
      </article>`;
    })
    .join("");
}

function fillTemplates(templates) {
  const seen = new Map();
  for (const template of templates) {
    if (template?.id) seen.set(template.id, template.name || template.id);
  }
  for (const record of records) {
    if (record.templateId && !seen.has(record.templateId)) {
      seen.set(record.templateId, record.templateName || record.templateId);
    }
  }
  const current = templateFilter.value;
  templateFilter.innerHTML = `<option value="">All templates</option>${[...seen.entries()]
    .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`)
    .join("")}`;
  if (current && seen.has(current)) templateFilter.value = current;
}

async function load() {
  const [historyRes, templateRes, statusRes] = await Promise.all([
    fetch("/api/history"),
    fetch("/api/templates"),
    fetch("/api/status"),
  ]);
  const templatePayload = await templateRes.json().catch(() => ({ templates: [] }));
  const statusPayload = await statusRes.json().catch(() => ({}));

  if (statusPayload.tracking?.warning) {
    trackingWarning.hidden = false;
    trackingWarning.textContent = statusPayload.tracking.warning;
  } else {
    trackingWarning.hidden = true;
    trackingWarning.textContent = "";
  }

  if (!historyRes.ok) {
    const payload = await historyRes.json().catch(() => ({}));
    records = [];
    loadError = payload.error || "Database is not connected.";
    fillTemplates(templatePayload.templates || []);
    render();
    return;
  }

  loadError = "";
  const history = await historyRes.json();
  records = history.records || [];
  fillTemplates(templatePayload.templates || []);
  render();
}

templateFilter.addEventListener("change", render);
searchInput.addEventListener("input", render);
refreshBtn.addEventListener("click", () => {
  load().catch((error) => {
    trackerList.innerHTML = `<div class="empty-card">${escapeHtml(error.message)}</div>`;
  });
});

load().catch((error) => {
  trackerList.innerHTML = `<div class="empty-card">${escapeHtml(error.message)}</div>`;
});
