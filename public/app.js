const fileInput = document.querySelector("#fileInput");
const dropzone = document.querySelector("#dropzone");
const fileChip = document.querySelector("#fileChip");
const previewBtn = document.querySelector("#previewBtn");
const sendBtn = document.querySelector("#sendBtn");
const templateSelect = document.querySelector("#templateSelect");
const templateColumns = document.querySelector("#templateColumns");
const stats = document.querySelector("#stats");
const tablePanel = document.querySelector("#tablePanel");
const rowsBody = document.querySelector("#rowsBody");
const historyBody = document.querySelector("#historyBody");
const toast = document.querySelector("#toast");

let selectedFile = null;
let templates = [];

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function badge(status, reason) {
  return `<span class="badge ${status}">${status}</span><div style="margin-top:6px;color:#5b716c;font-size:12px;">${reason || ""}</div>`;
}

function selectedTemplate() {
  return templates.find((template) => template.id === templateSelect.value) || null;
}

function renderTemplateColumns() {
  const template = selectedTemplate();
  if (!template) {
    templateColumns.textContent = "Choose a template to see the columns its spreadsheet needs. Email is always required.";
    return;
  }
  const columns = template.columns
    .map((column) => `${column.label}${column.required ? " (required)" : ""}`)
    .join(", ");
  templateColumns.textContent = `${template.name} expects: ${columns}.`;
}

function renderRows(rows) {
  rowsBody.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${row.excelRow}</td>
        <td>${row.name || "—"}</td>
        <td>${row.company || "—"}</td>
        <td>${row.email || "—"}</td>
        <td>${row.interest || "—"}</td>
        <td>${row.attachment || "—"}</td>
        <td>${badge(row.status, row.reason)}</td>
      </tr>`
    )
    .join("");
}

function setStats({ total, ready, skipped, sent, failed }) {
  stats.hidden = false;
  document.querySelector("#statTotal").textContent = total;
  document.querySelector("#statReady").textContent = ready;
  document.querySelector("#statSkipped").textContent = skipped;
  document.querySelector("#statSent").textContent =
    sent == null ? "—" : `${sent}${failed ? ` / ${failed}` : ""}`;
}

function formatWhen(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

async function refreshMeta() {
  const [statusRes, historyRes, templateRes] = await Promise.all([
    fetch("/api/status"),
    fetch("/api/history"),
    fetch("/api/templates"),
  ]);
  const status = await statusRes.json();
  const templatePayload = await templateRes.json();
  templates = templatePayload.templates || [];

  const previous = templateSelect.value;
  templateSelect.innerHTML = templates
    .map((template) => `<option value="${template.id}">${template.name}</option>`)
    .join("");
  if (previous && templates.some((template) => template.id === previous)) {
    templateSelect.value = previous;
  }
  renderTemplateColumns();

  const smtpPill = document.querySelector("#smtpPill");
  if (status.smtp.ok) {
    smtpPill.textContent = "SMTP ready";
    smtpPill.className = "pill ok";
    smtpPill.title = "";
  } else {
    const detail = String(status.smtp.error || "").trim();
    const authFailed = /authentication failed|invalid login|535/i.test(detail);
    const missing = /set zoho smtp|not configured|smtp_user|smtp_pass/i.test(detail);
    smtpPill.textContent = authFailed
      ? "SMTP login failed"
      : missing
        ? "SMTP not configured"
        : "SMTP error";
    smtpPill.className = "pill warn";
    smtpPill.title = detail || "Check SMTP settings in .env";
  }

  const dbPill = document.querySelector("#dbPill");
  dbPill.textContent = status.database?.ok ? "Database ready" : "Database not configured";
  dbPill.className = `pill ${status.database?.ok ? "ok" : "warn"}`;
  dbPill.title = status.database?.error || "";

  if (!historyRes.ok) {
    const payload = await historyRes.json().catch(() => ({}));
    document.querySelector("#historyPill").textContent = "History unavailable";
    historyBody.innerHTML = `<tr><td colspan="7" class="empty">${payload.error || "Database is not connected."}</td></tr>`;
    return;
  }

  const history = await historyRes.json();
  document.querySelector("#historyPill").textContent = `${history.records.length} remembered`;
  if (!history.records.length) {
    historyBody.innerHTML = `<tr><td colspan="7" class="empty">No emails remembered yet.</td></tr>`;
    return;
  }
  historyBody.innerHTML = history.records
    .map(
      (record) => `
      <tr>
        <td>${record.email}</td>
        <td>${record.templateName || "—"}</td>
        <td>${record.interest || "—"}</td>
        <td>${record.name || "—"}</td>
        <td>${formatWhen(record.sentAt)}</td>
        <td>${record.openedAt ? `<span class="badge opened">Opened</span> ${formatWhen(record.openedAt)}` : `<span class="badge unopened">Not opened</span>`}</td>
        <td>${record.unsubscribedAt ? `Yes ${formatWhen(record.unsubscribedAt)}` : "No"}</td>
      </tr>`
    )
    .join("");
}

function setFile(file) {
  selectedFile = file || null;
  fileChip.textContent = selectedFile ? selectedFile.name : "No file selected";
  const ready = Boolean(selectedFile && templateSelect.value);
  previewBtn.disabled = !ready;
  sendBtn.disabled = !ready;
}

async function postFile(url) {
  if (!selectedFile) return null;
  const data = new FormData();
  data.append("templateId", templateSelect.value);
  data.append("file", selectedFile);
  const response = await fetch(url, { method: "POST", body: data });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

previewBtn.addEventListener("click", async () => {
  try {
    previewBtn.disabled = true;
    const result = await postFile("/api/preview");
    tablePanel.hidden = false;
    document.querySelector("#tableTitle").textContent = "Preview";
    document.querySelector("#tableCaption").textContent =
      `${result.templateName} · ${result.filename} · ${result.ready.length} unique emails can be sent`;
    setStats({
      total: result.total,
      ready: result.ready.length,
      skipped: result.skipped.length,
    });
    renderRows(result.rows);
    showToast("Preview ready. Duplicates, unsubscribes, and missing emails were skipped.");
  } catch (error) {
    showToast(error.message);
  } finally {
    previewBtn.disabled = !selectedFile;
  }
});

sendBtn.addEventListener("click", async () => {
  const template = selectedTemplate();
  const label = template ? template.name : "the selected template";
  if (!window.confirm(`Send ${label} emails only for new recipients?`)) return;
  try {
    sendBtn.disabled = true;
    const result = await postFile("/api/send");
    tablePanel.hidden = false;
    document.querySelector("#tableTitle").textContent = "Send result";
    document.querySelector("#tableCaption").textContent =
      `${result.sent.length} sent · ${result.failed.length} failed · ${result.skipped.length} skipped`;
    setStats({
      total: result.total,
      ready: result.sent.length,
      skipped: result.skipped.length,
      sent: result.sent.length,
      failed: result.failed.length,
    });
    renderRows([...result.sent, ...result.failed, ...result.skipped]);
    await refreshMeta();
    showToast(result.sent.length ? "Emails sent and remembered." : "No unique emails to send.");
  } catch (error) {
    showToast(error.message);
  } finally {
    sendBtn.disabled = !selectedFile;
  }
});

templateSelect.addEventListener("change", () => {
  renderTemplateColumns();
  setFile(selectedFile);
});

fileInput.addEventListener("change", (event) => setFile(event.target.files[0]));
["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("drag");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag");
  });
});
dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (file) {
    fileInput.files = event.dataTransfer.files;
    setFile(file);
  }
});

refreshMeta().catch((error) => showToast(error.message));
