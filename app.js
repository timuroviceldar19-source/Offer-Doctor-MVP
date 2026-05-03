import { buckets, heuristicAudit } from "./audit-core.js";

const form = document.querySelector("#audit-form");
const leadForm = document.querySelector("#lead-form");
const emptyState = document.querySelector("#empty-state");
const results = document.querySelector("#results");
const scoreNode = document.querySelector("#score");
const diagnosisNode = document.querySelector("#diagnosis");
const analysisModeNode = document.querySelector("#analysis-mode");
const scoreBarsNode = document.querySelector("#score-bars");
const extractionBlockNode = document.querySelector("#extraction-block");
const extractionEditorBlockNode = document.querySelector("#extraction-editor-block");
const extractionEditorNode = document.querySelector("#extraction-editor");
const recalculateFromEditorButton = document.querySelector("#recalculate-from-editor");
const editorStatusNode = document.querySelector("#editor-status");
const extractionSummaryNode = document.querySelector("#extraction-summary");
const extractionTitleNode = document.querySelector("#extraction-title");
const extractionDescriptionNode = document.querySelector("#extraction-description");
const extractionPreviewNode = document.querySelector("#extraction-preview");
const issuesListNode = document.querySelector("#issues-list");
const actionsListNode = document.querySelector("#actions-list");
const rewriteHeadlineNode = document.querySelector("#rewrite-headline");
const rewriteSubheadNode = document.querySelector("#rewrite-subhead");
const rewriteCtaNode = document.querySelector("#rewrite-cta");
const copyButton = document.querySelector("#copy-report");
const downloadMarkdownButton = document.querySelector("#download-markdown");
const exportPdfButton = document.querySelector("#export-pdf");
const leadStatusNode = document.querySelector("#lead-status");
const historyEmptyNode = document.querySelector("#history-empty");
const historyListNode = document.querySelector("#history-list");
const historySearchNode = document.querySelector("#history-search");
const historyProviderFilterNode = document.querySelector("#history-provider-filter");
const historyModeFilterNode = document.querySelector("#history-mode-filter");
const leadInboxEmptyNode = document.querySelector("#lead-inbox-empty");
const leadInboxListNode = document.querySelector("#lead-inbox-list");
const leadStatusFilterNode = document.querySelector("#lead-status-filter");
const leadSearchNode = document.querySelector("#lead-search");
const leadInboxSummaryNode = document.querySelector("#lead-inbox-summary");
const leadTodayQueueNode = document.querySelector("#lead-today-queue");
const leadViewButtons = Array.from(document.querySelectorAll("[data-lead-view]"));

let lastInput = null;
let lastReport = null;
let lastExtractionMeta = null;
let preserveExtractionContext = false;
let allReports = [];
let allLeads = [];
let currentLeadView = "all";

form.addEventListener("submit", (event) => {
  event.preventDefault();
  preserveExtractionContext = false;
  void runAudit();
});

void loadHistory();
void loadLeads();

historySearchNode.addEventListener("input", () => {
  renderHistory(allReports);
});

historyProviderFilterNode.addEventListener("change", () => {
  renderHistory(allReports);
});

historyModeFilterNode.addEventListener("change", () => {
  renderHistory(allReports);
});

leadStatusFilterNode.addEventListener("change", () => {
  renderLeadInbox(allLeads);
});

leadSearchNode.addEventListener("input", () => {
  renderLeadInbox(allLeads);
});

for (const button of leadViewButtons) {
  button.addEventListener("click", () => {
    const view = button.getAttribute("data-lead-view") || "all";
    currentLeadView = view;
    syncLeadViewButtons();
    renderLeadInbox(allLeads);
  });
}

leadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitLead();
});

recalculateFromEditorButton.addEventListener("click", () => {
  void rerunFromEditedExtraction();
});

downloadMarkdownButton.addEventListener("click", () => {
  downloadMarkdownReport();
});

exportPdfButton.addEventListener("click", () => {
  exportPdfReport();
});

copyButton.addEventListener("click", async () => {
  if (!lastReport) {
    return;
  }

  try {
    await navigator.clipboard.writeText(buildPlainTextReport());
    copyButton.textContent = "Отчет скопирован";
  } catch {
    copyButton.textContent = "Копирование недоступно";
  }

  window.setTimeout(() => {
    copyButton.textContent = "Скопировать отчет";
  }, 1800);
});

async function runAudit() {
  lastInput = {
    niche: document.querySelector("#niche").value.trim(),
    audience: document.querySelector("#audience").value.trim(),
    goal: document.querySelector("#goal").value,
    url: document.querySelector("#url").value.trim(),
    copy: document.querySelector("#landing-copy").value.trim(),
  };

  if (!lastInput.copy && !lastInput.url) {
    emptyState.classList.remove("hidden");
    results.classList.add("hidden");
    analysisModeNode.textContent = "Добавьте текст лендинга или ссылку на страницу.";
    return;
  }

  emptyState.classList.add("hidden");
  results.classList.remove("hidden");
  analysisModeNode.textContent =
    lastInput.url && !lastInput.copy
      ? "Загружаю страницу по URL и собираю текст для аудита..."
      : "Идет AI-анализ страницы...";
  copyButton.disabled = true;

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(lastInput),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "AI endpoint недоступен");
    }

    lastReport = data;
  } catch (error) {
    const fallbackNote =
      error instanceof Error ? error.message : "Серверный AI-анализ не ответил.";
    lastReport = {
      ...heuristicAudit(lastInput),
      meta: {
        provider: "heuristic-browser",
        note: fallbackNote,
      },
    };
  }

  renderReport(lastReport);
  leadStatusNode.textContent = "";
  copyButton.disabled = false;
  void loadHistory();
}

function renderReport(report) {
  scoreNode.textContent = report.total;
  diagnosisNode.textContent = report.diagnosis;
  diagnosisNode.className = `score-diagnosis ${report.toneClass}`;
  analysisModeNode.textContent = buildAnalysisMode(report.meta);

  if (report.meta?.extraction?.used) {
    lastExtractionMeta = report.meta.extraction;
  } else if (!preserveExtractionContext) {
    lastExtractionMeta = null;
  }

  renderExtractionPreview(report.meta?.extraction || (preserveExtractionContext ? lastExtractionMeta : null));
  preserveExtractionContext = false;

  scoreBarsNode.innerHTML = buckets
    .map((bucket) => {
      const value = report.rawScores[bucket.key];
      const percent = Math.round((value / bucket.weight) * 100);

      return `
        <div class="score-bar">
          <div class="score-bar-header">
            <span>${bucket.title}</span>
            <span>${value}/${bucket.weight}</span>
          </div>
          <div class="meter">
            <span style="width:${percent}%"></span>
          </div>
        </div>
      `;
    })
    .join("");

  issuesListNode.innerHTML = report.issues.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  actionsListNode.innerHTML = report.actions.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  rewriteHeadlineNode.textContent = report.rewrite.headline;
  rewriteSubheadNode.textContent = report.rewrite.subhead;
  rewriteCtaNode.textContent = report.rewrite.cta;
}

async function loadHistory() {
  try {
    const response = await fetch("/api/reports?limit=12");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Не удалось загрузить историю.");
    }

    allReports = Array.isArray(data.reports) ? data.reports : [];
    renderHistory(allReports);
  } catch {
    allReports = [];
    renderHistory([]);
  }
}

async function loadLeads() {
  try {
    const response = await fetch("/api/leads?limit=10");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not load leads.");
    }

    allLeads = Array.isArray(data.leads) ? data.leads : [];
    renderLeadInbox(allLeads);
  } catch {
    allLeads = [];
    renderLeadInbox([]);
  }
}

function renderHistory(reports) {
  const filteredReports = filterReports(reports);
  historyEmptyNode.classList.toggle("hidden", filteredReports.length > 0);
  historyListNode.innerHTML = filteredReports
    .map(
      (item) => `
        <article class="history-item ${item.favorite ? "favorite" : ""}">
          <div class="history-row">
            <p class="history-title">${escapeHtml(item.title || "Offer Doctor report")}</p>
            <div class="history-actions">
              <button class="secondary-button" type="button" data-report-favorite="${escapeHtml(item.id)}">
                ${item.favorite ? "Убрать из избранного" : "В избранное"}
              </button>
              <button class="secondary-button" type="button" data-report-id="${escapeHtml(item.id)}">Открыть</button>
              <button class="secondary-button" type="button" data-report-delete="${escapeHtml(item.id)}">Удалить</button>
            </div>
          </div>
          <div class="history-badges">
            <span class="history-badge ${escapeHtml(providerBadgeClass(item.provider))}">${escapeHtml(providerLabelShort(item.provider))}</span>
            <span class="history-badge">${escapeHtml(modeLabel(item.mode))}</span>
            ${item.favorite ? '<span class="history-badge provider-gemini">Избранное</span>' : ""}
          </div>
          <p class="history-meta">Score: ${item.score ?? "—"}/100 · ${escapeHtml(formatReportDate(item.createdAt))}</p>
          <p class="history-meta">${escapeHtml(item.diagnosis || "")}</p>
        </article>
      `
    )
    .join("");

  const historyItems = Array.from(historyListNode.querySelectorAll(".history-item"));
  for (const [index, item] of filteredReports.entries()) {
    const card = historyItems[index];

    if (!card) {
      continue;
    }

    if (Array.isArray(item.tags) && item.tags.length > 0) {
      const tagsNode = document.createElement("div");
      tagsNode.className = "history-tags";
      tagsNode.innerHTML = item.tags
        .map((tag) => `<span class="history-tag">#${escapeHtml(tag)}</span>`)
        .join("");
      card.insertBefore(tagsNode, card.querySelector(".history-meta"));
    }

    const crmNode = document.createElement("div");
    crmNode.className = "history-crm";
    crmNode.innerHTML = `
      <label class="history-field">
        <span>Tags</span>
        <input
          class="history-input"
          type="text"
          value="${escapeHtml(Array.isArray(item.tags) ? item.tags.join(", ") : "")}"
          placeholder="saas, hot lead, b2b"
          data-report-tags="${escapeHtml(item.id)}"
        />
      </label>
      <label class="history-field">
        <span>Note</span>
        <textarea
          class="history-note"
          rows="3"
          placeholder="What did we learn and what is the next step?"
          data-report-note="${escapeHtml(item.id)}"
        >${escapeHtml(item.note || "")}</textarea>
      </label>
      <div class="history-editor-actions">
        <button class="secondary-button" type="button" data-report-save="${escapeHtml(item.id)}">
          Save CRM fields
        </button>
      </div>
    `;
    card.append(crmNode);
  }

  for (const button of historyListNode.querySelectorAll("[data-report-id]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-report-id");
      if (id) {
        void openSavedReport(id);
      }
    });
  }

  for (const button of historyListNode.querySelectorAll("[data-report-favorite]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-report-favorite");
      if (id) {
        void toggleFavoriteReport(id);
      }
    });
  }

  for (const button of historyListNode.querySelectorAll("[data-report-delete]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-report-delete");
      if (id) {
        void deleteReport(id);
      }
    });
  }

  for (const button of historyListNode.querySelectorAll("[data-report-save]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-report-save");
      if (id) {
        void saveReportCrm(id);
      }
    });
  }
}

function renderLeadInbox(leads) {
  const filteredLeads = filterLeads(leads);
  syncLeadViewButtons();
  renderLeadSummary(leads);
  renderLeadTodayQueue(leads);
  leadInboxEmptyNode.classList.toggle("hidden", filteredLeads.length > 0);
  leadInboxListNode.innerHTML = filteredLeads
    .map(
      (lead) => `
        <article class="lead-item ${isLeadHot(lead) ? "hot" : ""}">
          <div class="lead-row">
            <div>
              <p class="lead-title">${escapeHtml(lead.name || lead.email || "Unnamed lead")}</p>
              <p class="lead-meta">${escapeHtml(lead.email || "no email")} · ${escapeHtml(formatReportDate(lead.createdAt))}</p>
            </div>
            <div class="lead-actions">
              <select class="lead-status-select" data-lead-status="${escapeHtml(lead.id)}">
                ${buildLeadStatusOptions(lead.status)}
              </select>
              ${lead.reportId ? `<button class="secondary-button" type="button" data-lead-report="${escapeHtml(lead.reportId)}">Open report</button>` : ""}
              ${lead.sourceUrl ? `<a class="secondary-button lead-link-button" href="${escapeHtml(lead.sourceUrl)}" target="_blank" rel="noreferrer">Open source</a>` : ""}
            </div>
          </div>
          <div class="lead-badges">
            <span class="history-badge lead-badge ${escapeHtml(leadStatusClass(lead.status))}">${escapeHtml(leadStatusLabel(lead.status))}</span>
            ${lead.provider ? `<span class="history-badge ${escapeHtml(providerBadgeClass(lead.provider))}">${escapeHtml(providerLabelShort(lead.provider))}</span>` : ""}
            ${lead.score != null ? `<span class="history-badge">Score ${escapeHtml(String(lead.score))}</span>` : ""}
            ${lead.followUpAt ? `<span class="history-badge ${isLeadHot(lead) ? "lead-badge status-new" : ""}">Follow-up ${escapeHtml(formatLeadFollowUp(lead.followUpAt))}</span>` : ""}
            ${isLeadHot(lead) ? '<span class="history-badge lead-badge status-new">Hot</span>' : ""}
          </div>
          <p class="lead-meta">${escapeHtml(lead.niche || "")}${lead.audience ? ` · ${escapeHtml(lead.audience)}` : ""}</p>
          ${lead.diagnosis ? `<p class="lead-meta">${escapeHtml(lead.diagnosis)}</p>` : ""}
          ${lead.note ? `<p class="lead-note-copy">${escapeHtml(lead.note)}</p>` : ""}
          ${lead.sourceUrl ? `<p class="lead-meta"><a href="${escapeHtml(lead.sourceUrl)}" target="_blank" rel="noreferrer">Source page</a></p>` : ""}
          <div class="lead-crm">
            <label class="lead-field">
              <span>Follow-up date</span>
              <input
                class="lead-next-step"
                type="date"
                value="${escapeHtml(lead.followUpAt || "")}"
                data-lead-follow-up="${escapeHtml(lead.id)}"
              />
            </label>
            <div class="lead-follow-presets">
              <button class="secondary-button lead-preset-button" type="button" data-lead-follow-preset="${escapeHtml(lead.id)}" data-preset-value="today">Today</button>
              <button class="secondary-button lead-preset-button" type="button" data-lead-follow-preset="${escapeHtml(lead.id)}" data-preset-value="plus_1">+1d</button>
              <button class="secondary-button lead-preset-button" type="button" data-lead-follow-preset="${escapeHtml(lead.id)}" data-preset-value="plus_3">+3d</button>
              <button class="secondary-button lead-preset-button" type="button" data-lead-follow-preset="${escapeHtml(lead.id)}" data-preset-value="next_week">Next week</button>
              <button class="secondary-button lead-preset-button" type="button" data-lead-follow-preset="${escapeHtml(lead.id)}" data-preset-value="clear">Clear</button>
            </div>
            <label class="lead-field">
              <span>Next step</span>
              <input
                class="lead-next-step"
                type="text"
                value="${escapeHtml(lead.nextStep || "")}"
                placeholder="Call back, send audit, book demo..."
                data-lead-next-step="${escapeHtml(lead.id)}"
              />
            </label>
            <label class="lead-field">
              <span>CRM note</span>
              <textarea
                class="lead-crm-note"
                rows="3"
                placeholder="Internal note about urgency, objections, context..."
                data-lead-crm-note="${escapeHtml(lead.id)}"
              >${escapeHtml(lead.crmNote || "")}</textarea>
            </label>
            <div class="history-editor-actions">
              <button class="secondary-button" type="button" data-lead-save="${escapeHtml(lead.id)}">
                Save lead CRM
              </button>
            </div>
            <div class="lead-template-actions">
              <button class="secondary-button lead-preset-button" type="button" data-lead-action="${escapeHtml(lead.id)}" data-action-template="send_audit">
                Send audit
              </button>
              <button class="secondary-button lead-preset-button" type="button" data-lead-action="${escapeHtml(lead.id)}" data-action-template="book_call">
                Book call
              </button>
              <button class="secondary-button lead-preset-button" type="button" data-lead-action="${escapeHtml(lead.id)}" data-action-template="telegram_nudge">
                Nudge in Telegram
              </button>
            </div>
          </div>
        </article>
      `
    )
    .join("");

  for (const select of leadInboxListNode.querySelectorAll("[data-lead-status]")) {
    select.addEventListener("change", () => {
      const id = select.getAttribute("data-lead-status");
      if (id && select instanceof HTMLSelectElement) {
        void updateLeadStatus(id, select.value);
      }
    });
  }

  for (const button of leadInboxListNode.querySelectorAll("[data-lead-report]")) {
    button.addEventListener("click", () => {
      const reportId = button.getAttribute("data-lead-report");
      if (reportId) {
        void openSavedReport(reportId);
      }
    });
  }

  for (const button of leadInboxListNode.querySelectorAll("[data-lead-save]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-lead-save");
      if (id) {
        void saveLeadCrm(id);
      }
    });
  }

  for (const button of leadInboxListNode.querySelectorAll("[data-lead-follow-preset]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-lead-follow-preset");
      const preset = button.getAttribute("data-preset-value") || "";
      if (id) {
        void applyLeadFollowUpPreset(id, preset);
      }
    });
  }

  for (const button of leadInboxListNode.querySelectorAll("[data-lead-action]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-lead-action");
      const action = button.getAttribute("data-action-template") || "";
      if (id) {
        void applyLeadActionTemplate(id, action);
      }
    });
  }

  for (const button of leadTodayQueueNode.querySelectorAll("[data-lead-report]")) {
    button.addEventListener("click", () => {
      const reportId = button.getAttribute("data-lead-report");
      if (reportId) {
        void openSavedReport(reportId);
      }
    });
  }
}

function renderLeadSummary(leads) {
  const active = leads.filter((lead) => !isLeadClosed(lead)).length;
  const hot = leads.filter((lead) => isLeadHot(lead)).length;
  const dueToday = leads.filter((lead) => isLeadDueToday(lead)).length;
  const overdue = leads.filter((lead) => isLeadOverdue(lead)).length;

  leadInboxSummaryNode.innerHTML = [
    buildLeadSummaryCard("Active", active),
    buildLeadSummaryCard("Hot", hot),
    buildLeadSummaryCard("Due today", dueToday),
    buildLeadSummaryCard("Overdue", overdue),
  ].join("");
}

function buildLeadSummaryCard(label, value) {
  return `
    <article class="lead-summary-card">
      <p class="lead-summary-label">${escapeHtml(label)}</p>
      <p class="lead-summary-value">${escapeHtml(String(value))}</p>
    </article>
  `;
}

function renderLeadTodayQueue(leads) {
  const queueLeads = leads.filter((lead) => isLeadOverdue(lead) || isLeadDueToday(lead)).sort(compareLeads).slice(0, 5);

  if (queueLeads.length === 0) {
    leadTodayQueueNode.innerHTML = `
      <article class="lead-queue-card">
        <p class="lead-queue-head">Today Queue</p>
        <p class="lead-queue-meta">No overdue or due-today follow-ups right now.</p>
      </article>
    `;
    return;
  }

  leadTodayQueueNode.innerHTML = `
    <article class="lead-queue-card">
      <p class="lead-queue-head">Today Queue</p>
      <div class="lead-queue-list">
        ${queueLeads
          .map(
            (lead) => `
              <div class="lead-queue-item">
                <div>
                  <p class="lead-queue-title">${escapeHtml(lead.name || lead.email || "Unnamed lead")}</p>
                  <p class="lead-queue-meta">${escapeHtml(lead.email || "no email")} · ${escapeHtml(queueLabelForLead(lead))}</p>
                </div>
                <div class="lead-actions">
                  ${lead.reportId ? `<button class="secondary-button" type="button" data-lead-report="${escapeHtml(lead.reportId)}">Open report</button>` : ""}
                  ${lead.sourceUrl ? `<a class="secondary-button lead-link-button" href="${escapeHtml(lead.sourceUrl)}" target="_blank" rel="noreferrer">Open source</a>` : ""}
                </div>
              </div>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}

function filterLeads(leads) {
  const status = leadStatusFilterNode.value;
  const query = leadSearchNode.value.trim().toLowerCase();

  return leads
    .filter((lead) => {
      const statusMatch = status === "all" || lead.status === status;
      const viewMatch = matchesLeadView(lead, currentLeadView);
      const haystack = [
        lead.name,
        lead.email,
        lead.niche,
        lead.audience,
        lead.note,
        lead.crmNote,
        lead.nextStep,
        lead.followUpAt,
        lead.diagnosis,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const queryMatch = !query || haystack.includes(query);

      return statusMatch && viewMatch && queryMatch;
    })
    .sort(compareLeads);
}

function filterReports(reports) {
  const query = historySearchNode.value.trim().toLowerCase();
  const provider = historyProviderFilterNode.value;
  const mode = historyModeFilterNode.value;

  return reports.filter((item) => {
    const haystack = [
      item.title,
      item.diagnosis,
      item.niche,
      item.audience,
      item.url,
      item.note,
      ...(Array.isArray(item.tags) ? item.tags : []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const providerMatch =
      provider === "all" ||
      (provider === "heuristic"
        ? String(item.provider || "").startsWith("heuristic")
        : item.provider === provider);
    const modeMatch = mode === "all" || item.mode === mode;
    const queryMatch = !query || haystack.includes(query);

    return providerMatch && modeMatch && queryMatch;
  });
}

async function openSavedReport(id) {
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Не удалось открыть отчет.");
    }

    lastInput = data.input || null;
    lastReport = data.report || null;
    lastReport.meta = {
      ...(lastReport.meta || {}),
      reportId: data.id,
      savedAt: data.createdAt,
    };
    preserveExtractionContext = false;
    hydrateFormFromInput(lastInput);
    emptyState.classList.add("hidden");
    results.classList.remove("hidden");
    renderReport(lastReport);
    leadStatusNode.textContent = `Открыт сохраненный отчет от ${formatReportDate(data.createdAt)}.`;
  } catch (error) {
    leadStatusNode.textContent =
      error instanceof Error ? error.message : "Не удалось открыть отчет.";
  }
}

async function toggleFavoriteReport(id) {
  const current = allReports.find((item) => item.id === id);

  if (!current) {
    return;
  }

  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        favorite: !current.favorite,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Не удалось обновить избранное.");
    }

    allReports = mergeUpdatedReport(data);
    renderHistory(allReports);
  } catch (error) {
    leadStatusNode.textContent =
      error instanceof Error ? error.message : "Не удалось обновить избранное.";
  }
}

async function saveReportCrm(id) {
  const tagsInput = Array.from(historyListNode.querySelectorAll("[data-report-tags]")).find(
    (node) => node.getAttribute("data-report-tags") === id
  );
  const noteInput = Array.from(historyListNode.querySelectorAll("[data-report-note]")).find(
    (node) => node.getAttribute("data-report-note") === id
  );

  if (!(tagsInput instanceof HTMLInputElement) || !(noteInput instanceof HTMLTextAreaElement)) {
    return;
  }

  const tags = tagsInput.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const note = noteInput.value.trim();

  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tags,
        note,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not save CRM fields.");
    }

    allReports = mergeUpdatedReport(data);
    renderHistory(allReports);
    leadStatusNode.textContent = "Tags and note saved.";
  } catch (error) {
    leadStatusNode.textContent =
      error instanceof Error ? error.message : "Could not save CRM fields.";
  }
}

async function updateLeadStatus(id, status) {
  try {
    const response = await fetch(`/api/leads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not update lead status.");
    }

    allLeads = allLeads.map((lead) => (lead.id === id ? { ...lead, ...data } : lead));
    renderLeadInbox(allLeads);
    leadStatusNode.textContent = "Lead status updated.";
  } catch (error) {
    leadStatusNode.textContent =
      error instanceof Error ? error.message : "Could not update lead status.";
  }
}

async function saveLeadCrm(id) {
  const followUpInput = Array.from(leadInboxListNode.querySelectorAll("[data-lead-follow-up]")).find(
    (node) => node.getAttribute("data-lead-follow-up") === id
  );
  const nextStepInput = Array.from(leadInboxListNode.querySelectorAll("[data-lead-next-step]")).find(
    (node) => node.getAttribute("data-lead-next-step") === id
  );
  const crmNoteInput = Array.from(leadInboxListNode.querySelectorAll("[data-lead-crm-note]")).find(
    (node) => node.getAttribute("data-lead-crm-note") === id
  );

  if (
    !(followUpInput instanceof HTMLInputElement) ||
    !(nextStepInput instanceof HTMLInputElement) ||
    !(crmNoteInput instanceof HTMLTextAreaElement)
  ) {
    return;
  }

  try {
    const response = await fetch(`/api/leads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        followUpAt: followUpInput.value.trim(),
        nextStep: nextStepInput.value.trim(),
        crmNote: crmNoteInput.value.trim(),
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not save lead CRM.");
    }

    allLeads = allLeads.map((lead) => (lead.id === id ? { ...lead, ...data } : lead));
    renderLeadInbox(allLeads);
    leadStatusNode.textContent = "Lead CRM saved.";
  } catch (error) {
    leadStatusNode.textContent =
      error instanceof Error ? error.message : "Could not save lead CRM.";
  }
}

async function applyLeadFollowUpPreset(id, preset) {
  const nextDate = resolveLeadFollowUpPreset(preset);

  try {
    const response = await fetch(`/api/leads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        followUpAt: nextDate,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not update follow-up date.");
    }

    allLeads = allLeads.map((lead) => (lead.id === id ? { ...lead, ...data } : lead));
    renderLeadInbox(allLeads);
    leadStatusNode.textContent = "Follow-up date updated.";
  } catch (error) {
    leadStatusNode.textContent =
      error instanceof Error ? error.message : "Could not update follow-up date.";
  }
}

async function applyLeadActionTemplate(id, action) {
  const lead = allLeads.find((item) => item.id === id);

  if (!lead) {
    leadStatusNode.textContent = "Lead not found.";
    return;
  }

  const template = buildLeadActionTemplate(lead, action);

  if (!template) {
    leadStatusNode.textContent = "Unknown action template.";
    return;
  }

  try {
    const response = await fetch(`/api/leads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: template.status,
        nextStep: template.nextStep,
        followUpAt: template.followUpAt,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not apply lead action.");
    }

    allLeads = allLeads.map((item) => (item.id === id ? { ...item, ...data } : item));
    renderLeadInbox(allLeads);

    const copied = await copyLeadActionText(template.copy);
    leadStatusNode.textContent = copied ? template.successCopied : template.successUpdated;
  } catch (error) {
    leadStatusNode.textContent =
      error instanceof Error ? error.message : "Could not apply lead action.";
  }
}

async function deleteReport(id) {
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Не удалось удалить отчет.");
    }

    allReports = allReports.filter((item) => item.id !== id);
    renderHistory(allReports);

    if (lastReport?.meta?.reportId === id) {
      leadStatusNode.textContent = "Текущий отчет удален из истории.";
    }
  } catch (error) {
    leadStatusNode.textContent =
      error instanceof Error ? error.message : "Не удалось удалить отчет.";
  }
}

function hydrateFormFromInput(input) {
  if (!input) {
    return;
  }

  document.querySelector("#niche").value = input.niche || "";
  document.querySelector("#audience").value = input.audience || "";
  document.querySelector("#goal").value = input.goal || "lead";
  document.querySelector("#url").value = input.url || "";
  document.querySelector("#landing-copy").value = input.copy || "";
}

function buildAnalysisMode(meta = {}) {
  const provider = providerLabel(meta.provider, meta.model);
  const extraction = meta.extraction;

  if (extraction?.used) {
    const titlePart = extraction.title ? ` · ${extraction.title}` : "";
    return `${provider} · источник: URL (${extraction.finalUrl || extraction.url})${titlePart}`;
  }

  if (meta?.note) {
    return meta.note;
  }

  return provider;
}

function renderExtractionPreview(extraction) {
  if (!extraction?.used) {
    extractionBlockNode.classList.add("hidden");
    extractionEditorBlockNode.classList.add("hidden");
    extractionSummaryNode.textContent = "";
    extractionTitleNode.textContent = "";
    extractionDescriptionNode.textContent = "";
    extractionPreviewNode.innerHTML = "";
    extractionEditorNode.value = "";
    editorStatusNode.textContent = "";
    return;
  }

  extractionBlockNode.classList.remove("hidden");
  extractionEditorBlockNode.classList.remove("hidden");
  extractionSummaryNode.textContent = `Источник: ${extraction.finalUrl || extraction.url} · извлечено ${extraction.extractedBlocks || 0} блоков, ${extraction.extractedChars || 0} символов`;
  extractionTitleNode.textContent = extraction.title ? `Title: ${extraction.title}` : "";
  extractionDescriptionNode.textContent = extraction.description
    ? `Description: ${extraction.description}`
    : "Meta description не найдена или пустая.";
  extractionPreviewNode.innerHTML = Array.isArray(extraction.previewLines)
    ? extraction.previewLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")
    : "";
  extractionEditorNode.value = extraction.extractedText || "";
  editorStatusNode.textContent = "";
}

function providerLabel(provider, model) {
  if (provider === "gemini") {
    return `AI-разбор через Gemini${model ? ` (${model})` : ""}`;
  }

  if (provider === "openai") {
    return `AI-разбор через OpenAI${model ? ` (${model})` : ""}`;
  }

  if (provider === "heuristic-fallback" || provider === "heuristic-browser") {
    return "Локальный fallback-аудит";
  }

  return "Эвристический аудит";
}

async function rerunFromEditedExtraction() {
  const editedText = extractionEditorNode.value.trim();

  if (!editedText) {
    editorStatusNode.textContent = "Сначала оставьте текст для повторного аудита.";
    return;
  }

  document.querySelector("#landing-copy").value = editedText;
  editorStatusNode.textContent = "Пересчитываю аудит по отредактированному тексту...";

  lastInput = {
    niche: document.querySelector("#niche").value.trim(),
    audience: document.querySelector("#audience").value.trim(),
    goal: document.querySelector("#goal").value,
    url: document.querySelector("#url").value.trim(),
    copy: editedText,
  };

  preserveExtractionContext = true;
  await runAudit();
  editorStatusNode.textContent = "Аудит обновлен по вашей версии текста.";
}

async function submitLead() {
  if (!lastInput || !lastReport) {
    leadStatusNode.textContent = "Сначала выполните аудит, чтобы сохранить лид.";
    return;
  }

  const payload = {
    name: document.querySelector("#lead-name").value.trim(),
    email: document.querySelector("#lead-email").value.trim(),
    note: document.querySelector("#lead-note").value.trim(),
    niche: lastInput.niche,
    audience: lastInput.audience,
    goal: lastInput.goal,
    report: {
      total: lastReport.total,
      diagnosis: lastReport.diagnosis,
      issues: lastReport.issues,
      actions: lastReport.actions,
      rewrite: lastReport.rewrite,
      provider: lastReport.meta?.provider || lastReport.source || "unknown",
      reportId: lastReport.meta?.reportId || null,
      extraction: lastReport.meta?.extraction || null,
    },
  };

  try {
    const response = await fetch("/api/leads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Не удалось сохранить лид");
    }

    leadStatusNode.textContent = data.message || "Лид сохранен.";
    leadForm.reset();
    await loadLeads();
  } catch (error) {
    leadStatusNode.textContent =
      error instanceof Error ? error.message : "Не удалось сохранить лид.";
  }
}

function buildPlainTextReport() {
  return [
    `Offer Doctor: ${scoreNode.textContent}/100`,
    diagnosisNode.textContent,
    analysisModeNode.textContent,
    "",
    "Проблемы:",
    ...Array.from(issuesListNode.children).map((item) => `- ${item.textContent}`),
    "",
    "Что править первым:",
    ...Array.from(actionsListNode.children).map((item) => `- ${item.textContent}`),
    "",
    "Новый оффер:",
    rewriteHeadlineNode.textContent,
    rewriteSubheadNode.textContent,
    rewriteCtaNode.textContent,
  ].join("\n");
}

function buildReportMarkdown() {
  if (!lastReport) {
    return "";
  }

  const extraction = lastReport.meta?.extraction;
  const lines = [
    "# Offer Doctor Report",
    "",
    `- Score: ${lastReport.total}/100`,
    `- Diagnosis: ${lastReport.diagnosis}`,
    `- Analysis mode: ${buildAnalysisMode(lastReport.meta)}`,
  ];

  if (lastInput?.niche) lines.push(`- Niche: ${lastInput.niche}`);
  if (lastInput?.audience) lines.push(`- Audience: ${lastInput.audience}`);
  if (lastInput?.goal) lines.push(`- Goal: ${lastInput.goal}`);
  if (lastInput?.url) lines.push(`- URL: ${lastInput.url}`);

  lines.push("", "## Score Breakdown", "");
  for (const bucket of buckets) {
    lines.push(`- ${bucket.title}: ${lastReport.rawScores[bucket.key]}/${bucket.weight}`);
  }

  lines.push("", "## Problems", "");
  for (const issue of lastReport.issues) {
    lines.push(`- ${issue}`);
  }

  lines.push("", "## Priorities", "");
  for (const action of lastReport.actions) {
    lines.push(`- ${action}`);
  }

  lines.push(
    "",
    "## Rewrite",
    "",
    "### Headline",
    lastReport.rewrite.headline,
    "",
    "### Subhead",
    lastReport.rewrite.subhead,
    "",
    "### CTA",
    lastReport.rewrite.cta
  );

  if (extraction?.used) {
    lines.push("", "## Extraction", "");
    lines.push(`- Source URL: ${extraction.finalUrl || extraction.url}`);
    if (extraction.title) lines.push(`- Title: ${extraction.title}`);
    if (extraction.description) lines.push(`- Description: ${extraction.description}`);
    lines.push(`- Extracted blocks: ${extraction.extractedBlocks || 0}`);
    lines.push(`- Extracted chars: ${extraction.extractedChars || 0}`);

    if (Array.isArray(extraction.previewLines) && extraction.previewLines.length > 0) {
      lines.push("", "### Preview lines", "");
      for (const line of extraction.previewLines) {
        lines.push(`- ${line}`);
      }
    }
  }

  return lines.join("\n");
}

function downloadMarkdownReport() {
  if (!lastReport) {
    return;
  }

  const markdown = buildReportMarkdown();
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${buildReportFileStem()}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportPdfReport() {
  if (!lastReport) {
    return;
  }

  const previousTitle = document.title;
  document.title = buildReportFileStem();
  window.print();
  window.setTimeout(() => {
    document.title = previousTitle;
  }, 1000);
}

function buildReportFileStem() {
  let raw = lastInput?.niche || lastInput?.audience || "offer-doctor-report";

  if (lastInput?.url) {
    try {
      raw = new URL(lastInput.url).hostname;
    } catch {
      raw = lastInput.url;
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  return `${safeSlug(raw) || "offer-doctor-report"}-${date}`;
}

function formatReportDate(value) {
  if (!value) {
    return "без даты";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function providerLabelShort(provider) {
  if (provider === "gemini") return "Gemini";
  if (provider === "openai") return "OpenAI";
  return "Heuristic";
}

function providerBadgeClass(provider) {
  if (provider === "gemini") return "provider-gemini";
  if (provider === "openai") return "provider-openai";
  return "provider-heuristic";
}

function modeLabel(mode) {
  return mode === "url" ? "URL" : "Text";
}

function leadStatusLabel(status) {
  if (status === "contacted") return "Contacted";
  if (status === "won") return "Won";
  if (status === "lost") return "Lost";
  return "New";
}

function leadStatusClass(status) {
  if (status === "contacted") return "status-contacted";
  if (status === "won") return "status-won";
  if (status === "lost") return "status-lost";
  return "status-new";
}

function buildLeadStatusOptions(currentStatus) {
  const statuses = ["new", "contacted", "won", "lost"];

  return statuses
    .map(
      (status) =>
        `<option value="${status}" ${status === currentStatus ? "selected" : ""}>${leadStatusLabel(status)}</option>`
    )
    .join("");
}

function formatLeadFollowUp(value) {
  if (!value) {
    return "";
  }

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
  }).format(date);
}

function isLeadHot(lead) {
  if (!lead || lead.status === "won" || lead.status === "lost") {
    return false;
  }

  if (lead.followUpAt) {
    if (lead.followUpAt <= getTodayKey()) {
      return true;
    }
  }

  return lead.status === "new" && Number(lead.score || 0) >= 85;
}

function isLeadClosed(lead) {
  return lead?.status === "won" || lead?.status === "lost";
}

function isLeadDueToday(lead) {
  return Boolean(lead?.followUpAt) && lead.followUpAt === getTodayKey() && !isLeadClosed(lead);
}

function isLeadOverdue(lead) {
  return Boolean(lead?.followUpAt) && lead.followUpAt < getTodayKey() && !isLeadClosed(lead);
}

function matchesLeadView(lead, view) {
  if (view === "hot") return isLeadHot(lead);
  if (view === "due_today") return isLeadDueToday(lead);
  if (view === "overdue") return isLeadOverdue(lead);
  return true;
}

function syncLeadViewButtons() {
  for (const button of leadViewButtons) {
    button.classList.toggle("active", button.getAttribute("data-lead-view") === currentLeadView);
  }
}

function getTodayKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

function resolveLeadFollowUpPreset(preset) {
  if (preset === "clear") {
    return "";
  }

  const today = new Date();

  if (preset === "today") {
    return getDateKey(today);
  }

  if (preset === "plus_1") {
    const next = new Date(today);
    next.setDate(next.getDate() + 1);
    return getDateKey(next);
  }

  if (preset === "plus_3") {
    const next = new Date(today);
    next.setDate(next.getDate() + 3);
    return getDateKey(next);
  }

  if (preset === "next_week") {
    const next = new Date(today);
    next.setDate(next.getDate() + 7);
    return getDateKey(next);
  }

  return "";
}

function getDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function queueLabelForLead(lead) {
  if (isLeadOverdue(lead)) {
    return `Overdue · ${formatLeadFollowUp(lead.followUpAt)}`;
  }

  if (isLeadDueToday(lead)) {
    return "Due today";
  }

  return lead.followUpAt ? `Follow-up ${formatLeadFollowUp(lead.followUpAt)}` : "No follow-up date";
}

function buildLeadActionTemplate(lead, action) {
  const status = isLeadClosed(lead) ? lead.status : "contacted";
  const name = leadGreetingName(lead);
  const hasScore = lead.score !== null && lead.score !== undefined && Number.isFinite(Number(lead.score));
  const score = hasScore ? `${lead.score}/100` : "n/a";
  const diagnosis = lead.diagnosis || "your landing page still needs a sharper offer";
  const niche = lead.niche || "your niche";

  if (action === "send_audit") {
    return {
      status,
      nextStep: "Send full audit and ask for reply",
      followUpAt: resolveLeadFollowUpPreset("plus_1"),
      successCopied: "Audit message copied and lead updated.",
      successUpdated: "Lead updated. Clipboard unavailable on this device.",
      copy: [
        `Hi ${name},`,
        "",
        `Thanks for trying Offer Doctor. I reviewed the page for ${niche}.`,
        `Current score: ${score}.`,
        `Main diagnosis: ${diagnosis}.`,
        "",
        "My first recommendation is to tighten the headline, clarify the value, and make the CTA more explicit.",
        "If you want, reply here and I will send the top 3 fixes in priority order.",
      ].join("\n"),
    };
  }

  if (action === "book_call") {
    return {
      status,
      nextStep: "Offer a 15-minute conversion call",
      followUpAt: resolveLeadFollowUpPreset("plus_3"),
      successCopied: "Call invite copied and lead updated.",
      successUpdated: "Lead updated. Clipboard unavailable on this device.",
      copy: [
        `Hi ${name},`,
        "",
        `I looked through your landing page audit for ${niche}.`,
        `The biggest opportunity right now is: ${diagnosis}.`,
        "",
        "If helpful, we can do a quick 15-minute call and I will walk you through the highest-impact fixes live.",
        "If that sounds useful, send me a time that works and I will line it up.",
      ].join("\n"),
    };
  }

  if (action === "telegram_nudge") {
    return {
      status,
      nextStep: "Send Telegram follow-up nudge",
      followUpAt: resolveLeadFollowUpPreset("today"),
      successCopied: "Telegram nudge copied and lead updated.",
      successUpdated: "Lead updated. Clipboard unavailable on this device.",
      copy: [
        `Hi ${name}, quick nudge on your landing page audit.`,
        `The main issue I saw was ${diagnosis}.`,
        "If you want, I can send the top fixes in one short message so you can act on them today.",
      ].join("\n"),
    };
  }

  return null;
}

function leadGreetingName(lead) {
  const rawName = String(lead?.name || "").trim();

  if (!rawName) {
    return "there";
  }

  return rawName.split(/\s+/)[0];
}

async function copyLeadActionText(text) {
  if (!text || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function compareLeads(a, b) {
  const aHot = isLeadHot(a);
  const bHot = isLeadHot(b);

  if (aHot !== bHot) {
    return aHot ? -1 : 1;
  }

  const aClosed = a.status === "won" || a.status === "lost";
  const bClosed = b.status === "won" || b.status === "lost";

  if (aClosed !== bClosed) {
    return aClosed ? 1 : -1;
  }

  if (a.followUpAt && b.followUpAt && a.followUpAt !== b.followUpAt) {
    return a.followUpAt.localeCompare(b.followUpAt);
  }

  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

function mergeUpdatedReport(updated) {
  const next = allReports.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
  next.sort((a, b) => {
    if (a.favorite !== b.favorite) {
      return a.favorite ? -1 : 1;
    }

    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
  return next;
}

function safeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
