const templateFilter = document.querySelector("#templateFilter");
const trackerBody = document.querySelector("#trackerBody");

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

function filteredRecords() {
  const templateId = templateFilter.value;
  if (!templateId) return records;
  return records.filter((record) => record.templateId === templateId);
}

function render() {
  if (loadError) {
    document.querySelector("#statSent").textContent = "0";
    document.querySelector("#statOpened").textContent = "0";
    document.querySelector("#statClosed").textContent = "0";
    document.querySelector("#trackerCaption").textContent = "Could not load send history.";
    trackerBody.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(loadError)}</td></tr>`;
    return;
  }

  const rows = filteredRecords();
  const opened = rows.filter((record) => record.openedAt).length;
  document.querySelector("#statSent").textContent = rows.length;
  document.querySelector("#statOpened").textContent = opened;
  document.querySelector("#statClosed").textContent = rows.length - opened;

  const selected = templateFilter.selectedOptions[0]?.textContent || "All templates";
  document.querySelector("#trackerCaption").textContent = templateFilter.value
    ? `${selected} · ${opened} opened of ${rows.length} sent`
    : `${opened} opened of ${rows.length} sent`;

  if (!rows.length) {
    trackerBody.innerHTML = `<tr><td colspan="7" class="empty">No emails for this template.</td></tr>`;
    return;
  }

  trackerBody.innerHTML = rows
    .map((record) => {
      const status = record.openedAt
        ? `<span class="badge opened">Opened</span>`
        : `<span class="badge unopened">Not opened</span>`;
      return `
      <tr>
        <td>${escapeHtml(record.email)}</td>
        <td>${escapeHtml(record.templateName || "—")}</td>
        <td>${escapeHtml(record.name || "—")}</td>
        <td>${escapeHtml(formatWhen(record.sentAt))}</td>
        <td>${status}</td>
        <td>${escapeHtml(record.openedAt ? formatWhen(record.openedAt) : "—")}</td>
        <td>${escapeHtml(record.openCount || 0)}</td>
      </tr>`;
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
  const [historyRes, templateRes] = await Promise.all([
    fetch("/api/history"),
    fetch("/api/templates"),
  ]);
  const templatePayload = await templateRes.json().catch(() => ({ templates: [] }));

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
load().catch((error) => {
  trackerBody.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(error.message)}</td></tr>`;
});
