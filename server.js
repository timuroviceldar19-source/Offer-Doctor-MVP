import "dotenv/config";
import { createServer } from "node:http";
import { mkdir, appendFile, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";
import OpenAI from "openai";
import { heuristicAudit, normalizeAiReport } from "./audit-core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const reportsDir = path.join(dataDir, "reports");
const leadsFile = path.join(dataDir, "leads.jsonl");
const port = Number(process.env.PORT || 4173);

const MAX_JSON_SIZE = 300 * 1024;
const MAX_HTML_SIZE = 1024 * 1024;
const MAX_REDIRECTS = 3;

const aiProvider = resolveProvider();
const openAiModel = process.env.OPENAI_MODEL || "gpt-4o";
const geminiModel = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const openAiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  try {
    const isPrivateEndpoint = 
      (req.method === "GET" && url.pathname === "/api/reports") ||
      (url.pathname.startsWith("/api/reports/") && ["GET", "PATCH", "DELETE"].includes(req.method)) ||
      (req.method === "GET" && url.pathname === "/api/leads") ||
      (req.method === "PATCH" && url.pathname.startsWith("/api/leads/"));

    if (isPrivateEndpoint && !checkAdminAuth(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readJson(req);
      let input = {
        niche: clean(body.niche),
        audience: clean(body.audience),
        goal: clean(body.goal) || "lead",
        url: clean(body.url),
        copy: clean(body.copy),
      };

      let extractionMeta = null;

      if (!input.copy && input.url) {
        const extracted = await extractAuditInputFromUrl(input.url);
        input = {
          ...input,
          copy: extracted.copy,
        };
        extractionMeta = extracted.meta;
      }

      if (!input.copy) {
        return json(res, 400, { error: "Передайте текст лендинга или ссылку на страницу." });
      }

      const report = await buildReport(input, extractionMeta);
      const savedReport = await saveReportRecord(input, report);
      report.meta = {
        ...(report.meta || {}),
        reportId: savedReport.id,
        savedAt: savedReport.createdAt,
      };
      return json(res, 200, report);
    }

    if (req.method === "GET" && url.pathname === "/api/reports") {
      const limit = Number(url.searchParams.get("limit") || 12);
      const reports = await listSavedReports(Number.isFinite(limit) ? limit : 12);
      return json(res, 200, { reports });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/reports/")) {
      const reportIdRaw = decodeURIComponent(url.pathname.slice("/api/reports/".length));
      const reportId = validateReportId(reportIdRaw);

      if (!reportId) {
        return json(res, 400, { error: "Некорректный id отчета." });
      }

      const reportRecord = await readSavedReport(reportId);

      if (!reportRecord) {
        return json(res, 404, { error: "Отчет не найден." });
      }

      return json(res, 200, reportRecord);
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/reports/")) {
      const reportIdRaw = decodeURIComponent(url.pathname.slice("/api/reports/".length));
      const reportId = validateReportId(reportIdRaw);

      if (!reportId) {
        return json(res, 400, { error: "Некорректный id отчета." });
      }

      const body = await readJson(req);
      const patch = {};

      if (typeof body.favorite === "boolean") {
        patch.favorite = body.favorite;
      }

      if (Object.prototype.hasOwnProperty.call(body, "note")) {
        patch.note = clean(body.note);
      }

      if (Object.prototype.hasOwnProperty.call(body, "tags")) {
        patch.tags = normalizeTags(body.tags);
      }

      const updated = await updateSavedReport(reportId, patch);

      if (!updated) {
        return json(res, 404, { error: "Отчет не найден." });
      }

      return json(res, 200, updated);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/reports/")) {
      const reportIdRaw = decodeURIComponent(url.pathname.slice("/api/reports/".length));
      const reportId = validateReportId(reportIdRaw);

      if (!reportId) {
        return json(res, 400, { error: "Некорректный id отчета." });
      }

      const removed = await deleteSavedReport(reportId);

      if (!removed) {
        return json(res, 404, { error: "Отчет не найден." });
      }

      return json(res, 200, { ok: true, id: reportId });
    }

    if (req.method === "GET" && url.pathname === "/api/leads") {
      const limit = Number(url.searchParams.get("limit") || 10);
      const leads = await listSavedLeads(Number.isFinite(limit) ? limit : 10);
      return json(res, 200, { leads });
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/leads/")) {
      const leadId = decodeURIComponent(url.pathname.slice("/api/leads/".length));

      if (!leadId) {
        return json(res, 400, { error: "Lead id is required." });
      }

      const body = await readJson(req);
      const patch = {};

      if (Object.prototype.hasOwnProperty.call(body, "status")) {
        patch.status = normalizeLeadStatus(body.status);
      }

      if (Object.prototype.hasOwnProperty.call(body, "crmNote")) {
        patch.crmNote = clean(body.crmNote);
      }

      if (Object.prototype.hasOwnProperty.call(body, "nextStep")) {
        patch.nextStep = clean(body.nextStep);
      }

      if (Object.prototype.hasOwnProperty.call(body, "followUpAt")) {
        patch.followUpAt = normalizeLeadFollowUpAt(body.followUpAt);
      }

      const updated = await updateSavedLead(leadId, patch);

      if (!updated) {
        return json(res, 404, { error: "Lead not found." });
      }

      return json(res, 200, updated);
    }

    if (req.method === "POST" && url.pathname === "/api/leads") {
      const body = await readJson(req);
      const email = clean(body.email);

      if (!looksLikeEmail(email)) {
        return json(res, 400, { error: "Укажите корректный email." });
      }

      let reportData = null;
      if (body.report && typeof body.report === "object") {
        if (body.report.reportId) {
          const safeId = validateReportId(body.report.reportId);
          if (safeId) {
            const savedReport = await readSavedReport(safeId);
            if (savedReport) {
               let sourceUrl = savedReport.report?.meta?.extraction?.finalUrl || savedReport.report?.meta?.extraction?.url || "";
               if (sourceUrl) {
                 try {
                   const parsed = new URL(sourceUrl);
                   if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                     sourceUrl = "";
                   }
                 } catch {
                   sourceUrl = "";
                 }
               }
               reportData = {
                 total: savedReport.report?.total ?? null,
                 diagnosis: savedReport.report?.diagnosis || "",
                 provider: savedReport.report?.meta?.provider || savedReport.report?.source || "unknown",
                 reportId: safeId,
                 extraction: sourceUrl ? { finalUrl: sourceUrl } : null
               };
            }
          }
        }
        
        if (!reportData) {
          reportData = {
            total: body.report.total,
            diagnosis: clean(body.report.diagnosis),
            provider: clean(body.report.provider) || "unknown",
            reportId: null,
            extraction: null
          };
        }
      }

      const leadRecord = {
        id: buildLeadId(),
        createdAt: new Date().toISOString(),
        updatedAt: null,
        status: "new",
        name: clean(body.name),
        email,
        note: clean(body.note),
        crmNote: "",
        nextStep: "",
        followUpAt: "",
        niche: clean(body.niche),
        audience: clean(body.audience),
        goal: clean(body.goal),
        report: reportData,
      };

      await mkdir(dataDir, { recursive: true });
      await appendFile(leadsFile, `${JSON.stringify(leadRecord)}\n`, "utf8");

      const telegramStatus = await notifyTelegramAboutLead(leadRecord);
      if (!telegramStatus.ok && !telegramStatus.skipped) {
        console.warn("Telegram lead notification failed:", telegramStatus.error);
      }

      return json(res, 200, {
        ok: true,
        lead: summarizeLeadRecord(leadRecord),
        message: "Лид сохранен. Можно связываться с пользователем.",
      });
    }

    return serveStatic(res, url.pathname);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Payload Too Large") {
        return json(res, 413, { error: "Запрос слишком большой." });
      }
      if (error.message === "Invalid JSON") {
        return json(res, 400, { error: "Ошибка формата JSON." });
      }
      if (error.message === "Доступ к внутренним ресурсам запрещен.") {
        return json(res, 403, { error: error.message });
      }
      const isUrlError = [
        "URL страницы некорректен.",
        "Поддерживаются только http и https ссылки.",
        "По ссылке нет HTML-страницы для анализа.",
        "Страница слишком большая для анализа.",
        "Не удалось извлечь достаточно текста со страницы.",
        "Слишком много редиректов."
      ].includes(error.message) || error.message.startsWith("Не удалось загрузить страницу:");
      if (isUrlError) {
        return json(res, 400, { error: error.message });
      }
    }
    console.error(error);
    return json(res, 500, {
      error: "Что-то пошло не так на сервере.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, () => {
    console.log(`Offer Doctor running on http://127.0.0.1:${port}`);
  });
}

export { server };

async function buildReport(input, extractionMeta = null) {
  const fallback = heuristicAudit(input);

  if (aiProvider === "gemini") {
    return buildGeminiReport(input, fallback, extractionMeta);
  }

  if (aiProvider === "openai") {
    return buildOpenAiReport(input, fallback, extractionMeta);
  }

  return {
    ...fallback,
    meta: {
      provider: "heuristic",
      model: null,
      note: "AI-провайдер не настроен, поэтому используется локальный эвристический аудит.",
      extraction: extractionMeta,
    },
  };
}

async function buildOpenAiReport(input, fallback, extractionMeta) {
  if (!openAiClient) {
    return {
      ...fallback,
      meta: {
        provider: "heuristic",
        model: null,
        note: "OPENAI_API_KEY не задан, поэтому используется локальный эвристический аудит.",
        extraction: extractionMeta,
      },
    };
  }

  try {
    const response = await openAiClient.responses.create({
      model: openAiModel,
      instructions: buildAuditInstruction(),
      input: JSON.stringify(buildAuditPayload(input), null, 2),
    });

    const parsed = safeJsonParse(response.output_text);

    return {
      ...normalizeAiReport(parsed, input),
      meta: {
        provider: "openai",
        model: openAiModel,
        requestId: response._request_id || null,
        extraction: extractionMeta,
      },
    };
  } catch (error) {
    return {
      ...fallback,
      meta: {
        provider: "heuristic-fallback",
        model: openAiModel,
        note: error instanceof Error ? error.message : String(error),
        extraction: extractionMeta,
      },
    };
  }
}

async function buildGeminiReport(input, fallback, extractionMeta) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      ...fallback,
      meta: {
        provider: "heuristic",
        model: null,
        note: "GEMINI_API_KEY не задан, поэтому используется локальный эвристический аудит.",
        extraction: extractionMeta,
      },
    };
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
          "x-goog-api-client": "offer-doctor/0.1.0",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: JSON.stringify(buildAuditPayload(input), null, 2),
                },
              ],
            },
          ],
          systemInstruction: {
            parts: [{ text: buildAuditInstruction() }],
          },
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseJsonSchema: buildGeminiSchema(),
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || `Gemini error ${response.status}`;
      throw new Error(message);
    }

    const text = extractGeminiText(data);
    const parsed = safeJsonParse(text);

    return {
      ...normalizeAiReport(parsed, input),
      meta: {
        provider: "gemini",
        model: data?.modelVersion || geminiModel,
        extraction: extractionMeta,
      },
    };
  } catch (error) {
    return {
      ...fallback,
      meta: {
        provider: "heuristic-fallback",
        model: geminiModel,
        note: error instanceof Error ? error.message : String(error),
        extraction: extractionMeta,
      },
    };
  }
}

async function extractAuditInputFromUrl(rawUrl) {
  let currentUrl;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    throw new Error("URL страницы некорректен.");
  }

  const initialUrl = currentUrl;
  let redirects = 0;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    while (redirects <= MAX_REDIRECTS) {
      if (!(await isSafeUrl(currentUrl))) {
        throw new Error("Доступ к внутренним ресурсам запрещен.");
      }

      const response = await fetch(currentUrl, {
        headers: {
          "User-Agent": "OfferDoctorBot/0.1",
          Accept: "text/html",
        },
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        currentUrl = new URL(location, currentUrl);
        redirects++;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Не удалось загрузить страницу: ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        throw new Error("По ссылке нет HTML-страницы для анализа.");
      }

      const chunks = [];
      let totalLength = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          totalLength += chunk.length;
          if (totalLength > MAX_HTML_SIZE) {
            throw new Error("Страница слишком большая для анализа.");
          }
          chunks.push(chunk);
        }
      }

      const html = Buffer.concat(chunks).toString("utf8");
      const extracted = extractLandingText(html);

      if (!extracted.copy) {
        throw new Error("Не удалось извлечь достаточно текста со страницы.");
      }

      return {
        copy: extracted.copy,
        meta: {
          used: true,
          source: "url",
          url: initialUrl.toString(),
          finalUrl: currentUrl.toString(),
          title: extracted.title,
          description: extracted.description,
          extractedChars: extracted.copy.length,
          extractedBlocks: extracted.blockCount,
          previewLines: extracted.previewLines,
        },
      };
    }
    throw new Error("Слишком много редиректов.");
  } finally {
    clearTimeout(timeout);
  }
}

async function isSafeUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const hostname = url.hostname;
  if (isPrivateIp(hostname)) return false;

  try {
    const addresses = await dns.resolve(hostname).catch(() => []);
    if (addresses.some(isPrivateIp)) return false;
    
    const lookup = await dns.lookup(hostname).catch(() => null);
    if (lookup && isPrivateIp(lookup.address)) return false;
  } catch {
    // If resolution fails, we proceed but fetch will likely fail too.
  }

  return true;
}

function isPrivateIp(ip) {
  ip = ip.replace(/^\[|\]$/g, "");

  if (ip.toLowerCase().startsWith("::ffff:")) {
    const rest = ip.substring(7);
    if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(rest)) {
      const parts = rest.split(":");
      const p1 = parseInt(parts[0], 16);
      const p2 = parseInt(parts[1], 16);
      ip = `${p1 >> 8}.${p1 & 0xff}.${p2 >> 8}.${p2 & 0xff}`;
    } else {
      ip = rest;
    }
  }

  if (
    ip === "localhost" ||
    ip === "::1" ||
    ip === "0.0.0.0" ||
    ip === "::"
  ) {
    return true;
  }

  // IPv4 Private Ranges
  if (/^127\./.test(ip)) return true; // Loopback
  if (/^10\./.test(ip)) return true; // Private
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true; // Private
  if (/^192\.168\./.test(ip)) return true; // Private
  if (/^169\.254\./.test(ip)) return true; // Link-local
  if (/^0\./.test(ip)) return true; // Unspecified

  // IPv6 Private Ranges
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true; // Link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // Unique local
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return true; // Multicast

  return false;
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const target = path.normalize(path.join(__dirname, safePath));

  if (!target.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const fileInfo = await stat(target);

    if (fileInfo.isDirectory()) {
      return serveStatic(res, path.join(pathname, "index.html"));
    }

    const ext = path.extname(target);
    const content = await readFile(target);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function saveReportRecord(input, report) {
  await mkdir(reportsDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const id = buildReportId();
  const record = {
    id,
    createdAt,
    favorite: false,
    note: "",
    tags: [],
    input,
    report,
  };

  await writeFile(reportFilePath(id), JSON.stringify(record, null, 2), "utf8");
  return record;
}

async function listSavedReports(limit) {
  try {
    await mkdir(reportsDir, { recursive: true });
    const entries = await readdir(reportsDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

    const records = (await Promise.all(
      files.map(async (file) => {
        try {
          const raw = await readFile(path.join(reportsDir, file.name), "utf8");
          const record = JSON.parse(raw);
          return summarizeReportRecord(record);
        } catch {
          return null;
        }
      })
    )).filter(Boolean);

    return records
      .sort((a, b) => {
        if (a.favorite !== b.favorite) {
          return a.favorite ? -1 : 1;
        }

        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      })
      .slice(0, Math.max(1, Math.min(limit, 50)));
  } catch {
    return [];
  }
}

async function readSavedReport(id) {
  try {
    const raw = await readFile(reportFilePath(id), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function updateSavedReport(id, patch) {
  const current = await readSavedReport(id);

  if (!current) {
    return null;
  }

  const updated = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await writeFile(reportFilePath(id), JSON.stringify(updated, null, 2), "utf8");
  return summarizeReportRecord(updated);
}

async function deleteSavedReport(id) {
  try {
    await rm(reportFilePath(id), { force: false });
    return true;
  } catch {
    return false;
  }
}

function buildAuditInstruction() {
  return [
    "Ты senior growth-маркетолог и conversion copywriter.",
    "Анализируй только переданный текст лендинга и явно указанные поля input.",
    "Ничего не выдумывай: не добавляй новые факты, цифры, сроки, гарантии, метрики, каналы, отрасль, продуктовую категорию или боли, если их нет во входных данных.",
    "Если чего-то не хватает в тексте, прямо укажи, что этого нет или это не доказано, вместо догадок.",
    "Если во входе есть числа, сроки или метрики, не меняй их смысл и единицы измерения.",
    "rewrite должен быть безопасным переписыванием исходного оффера, а не новым выдуманным предложением.",
    "Не подменяй нишу или продукт. Если ниша неясна, используй нейтральные формулировки.",
    "issues и actions должны ссылаться только на наблюдаемую проблему в тексте или на отсутствие важного элемента.",
    "Верни только JSON без markdown и без пояснений.",
    "Сохрани структуру полей: total, diagnosis, rawScores, issues, actions, rewrite.",
    "rawScores должен содержать числа по ключам clarity, pain, value, trust, cta, structure.",
    "issues максимум 4 коротких пункта. actions максимум 3 коротких пункта.",
    "rewrite должен содержать headline, subhead, cta.",
    "Пиши по-русски, коротко, без воды, максимально прикладно.",
  ].join(" ");
}

function buildAuditPayload(input) {
  return {
    task: "Проведи коммерческий аудит лендинга и предложи приоритетные правки.",
    nonNegotiables: [
      "Используй только факты из input и evidence.",
      "Если подтверждения нет, не придумывай его.",
      "Не меняй существующие цифры, сроки и единицы измерения.",
      "Не добавляй в rewrite новые обещания, которых нет в тексте.",
      "Если niche или audience не заданы, не угадывай их узко.",
    ],
    rules: {
      totalRange: "0-100",
      weights: {
        clarity: 24,
        pain: 16,
        value: 18,
        trust: 14,
        cta: 16,
        structure: 12,
      },
    },
    evidence: buildAuditEvidence(input),
    input,
  };
}

function summarizeReportRecord(record) {
  const provider = record.report?.meta?.provider || record.report?.source || "";
  const mode = record.report?.meta?.extraction?.used ? "url" : "text";

  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || null,
    favorite: Boolean(record.favorite),
    note: record.note || "",
    tags: Array.isArray(record.tags) ? record.tags : [],
    niche: record.input?.niche || "",
    audience: record.input?.audience || "",
    goal: record.input?.goal || "",
    url: record.input?.url || "",
    score: record.report?.total ?? null,
    diagnosis: record.report?.diagnosis || "",
    provider,
    mode,
    title:
      record.report?.meta?.extraction?.title ||
      record.input?.niche ||
      record.input?.audience ||
      record.input?.url ||
      "Offer Doctor report",
  };
}

function buildReportId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildLeadId() {
  return `lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  return [];
}

function normalizeLeadStatus(value) {
  const normalized = clean(value).toLowerCase();

  if (["contacted", "won", "lost"].includes(normalized)) {
    return normalized;
  }

  return "new";
}

function normalizeLeadFollowUpAt(value) {
  const normalized = clean(value);

  if (!normalized) {
    return "";
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

async function listSavedLeads(limit) {
  const records = await readLeadRecords();

  return records
    .map(summarizeLeadRecord)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, Math.max(1, Math.min(limit, 50)));
}

async function readLeadRecords() {
  try {
    const raw = await readFile(leadsFile, "utf8");

    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((record, index) => ({
        ...record,
        id: record.id || buildLegacyLeadId(record, index),
        updatedAt: record.updatedAt || null,
        status: normalizeLeadStatus(record.status),
        crmNote: clean(record.crmNote),
        nextStep: clean(record.nextStep),
        followUpAt: normalizeLeadFollowUpAt(record.followUpAt),
      }));
  } catch {
    return [];
  }
}

async function writeLeadRecords(records) {
  await mkdir(dataDir, { recursive: true });
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(leadsFile, content ? `${content}\n` : "", "utf8");
}

async function updateSavedLead(id, patch) {
  const records = await readLeadRecords();
  const index = records.findIndex((record) => record.id === id);

  if (index === -1) {
    return null;
  }

  records[index] = {
    ...records[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await writeLeadRecords(records);
  return summarizeLeadRecord(records[index]);
}

function summarizeLeadRecord(record) {
  let sourceUrl = record.report?.extraction?.finalUrl || record.report?.extraction?.url || "";
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        sourceUrl = "";
      }
    } catch {
      sourceUrl = "";
    }
  }

  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || null,
    status: normalizeLeadStatus(record.status),
    name: record.name || "",
    email: record.email || "",
    note: record.note || "",
    crmNote: record.crmNote || "",
    nextStep: record.nextStep || "",
    followUpAt: record.followUpAt || "",
    niche: record.niche || "",
    audience: record.audience || "",
    goal: record.goal || "",
    score: record.report?.total ?? null,
    diagnosis: record.report?.diagnosis || "",
    provider: record.report?.provider || "",
    reportId: record.report?.reportId || null,
    sourceUrl,
  };
}

function buildLegacyLeadId(record, index) {
  return `legacy-${record.createdAt || "lead"}-${index}`;
}

async function notifyTelegramAboutLead(leadRecord) {
  const botToken = clean(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(process.env.TELEGRAM_CHAT_ID);

  if (!botToken || !chatId) {
    return {
      ok: false,
      skipped: true,
      error: "Telegram is not configured.",
    };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        disable_web_page_preview: true,
        text: buildTelegramLeadMessage(leadRecord),
      }),
    });

    const data = await response.json();

    if (!response.ok || data?.ok === false) {
      return {
        ok: false,
        skipped: false,
        error: data?.description || `Telegram error ${response.status}`,
      };
    }

    return {
      ok: true,
      skipped: false,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildTelegramLeadMessage(leadRecord) {
  const lines = [
    "New lead for Offer Doctor",
    `Time: ${leadRecord.createdAt}`,
    `Status: ${normalizeLeadStatus(leadRecord.status)}`,
    `Email: ${leadRecord.email || "-"}`,
  ];

  if (leadRecord.name) {
    lines.push(`Name: ${truncateForTelegram(leadRecord.name, 160)}`);
  }

  if (leadRecord.niche) {
    lines.push(`Niche: ${truncateForTelegram(leadRecord.niche, 160)}`);
  }

  if (leadRecord.audience) {
    lines.push(`Audience: ${truncateForTelegram(leadRecord.audience, 160)}`);
  }

  if (leadRecord.goal) {
    lines.push(`Goal: ${truncateForTelegram(leadRecord.goal, 80)}`);
  }

  if (leadRecord.report?.total != null) {
    lines.push(`Score: ${leadRecord.report.total}/100`);
  }

  if (leadRecord.report?.provider) {
    lines.push(`Provider: ${truncateForTelegram(leadRecord.report.provider, 80)}`);
  }

  if (leadRecord.report?.reportId) {
    lines.push(`Report ID: ${truncateForTelegram(leadRecord.report.reportId, 80)}`);
  }

  if (leadRecord.report?.diagnosis) {
    lines.push(`Diagnosis: ${truncateForTelegram(leadRecord.report.diagnosis, 280)}`);
  }

  const sourceUrl = leadRecord.report?.extraction?.finalUrl || leadRecord.report?.extraction?.url;
  if (sourceUrl) {
    lines.push(`Source URL: ${truncateForTelegram(sourceUrl, 300)}`);
  }

  if (leadRecord.note) {
    lines.push(`Comment: ${truncateForTelegram(leadRecord.note, 500)}`);
  }

  return lines.join("\n");
}

function truncateForTelegram(value, maxLength) {
  const text = normalizeWhitespace(String(value || ""));

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function buildAuditEvidence(input) {
  const lines = input.copy
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const numberedClaims = lines.filter((line) => /\d/.test(line)).slice(0, 6);
  const ctaHints = lines
    .filter((line) => /(заяв|созвон|демо|куп|получ|запис|заказ)/i.test(line))
    .slice(0, 6);

  return {
    firstScreen: lines.slice(0, 4),
    numberedClaims,
    ctaHints,
    factsMissingAreNotFacts: true,
  };
}

function extractLandingText(html) {
  const sanitized = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");

  const title = decodeHtmlEntities(firstMatch(sanitized, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const description = decodeHtmlEntities(
    firstMatch(
      sanitized,
      /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
    ) ||
      firstMatch(
        sanitized,
        /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i
      )
  );

  const blocks = [
    ...matchTags(sanitized, "h1"),
    ...matchTags(sanitized, "h2"),
    ...matchTags(sanitized, "h3"),
    ...matchTags(sanitized, "p"),
    ...matchTags(sanitized, "li"),
    ...matchTags(sanitized, "button"),
    ...matchTags(sanitized, "a"),
  ]
    .map((item) => normalizeWhitespace(decodeHtmlEntities(stripTags(item))))
    .filter(Boolean)
    .filter((item) => item.length >= 18)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 80);

  const segments = [title, description, ...blocks]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000)
    .trim();

  return {
    title: title || null,
    description: description || null,
    copy: segments,
    blockCount: blocks.length,
    previewLines: blocks.slice(0, 6),
  };
}

function buildGeminiSchema() {
  return {
    type: "object",
    properties: {
      total: {
        type: "integer",
        minimum: 0,
        maximum: 100,
      },
      diagnosis: {
        type: "string",
      },
      rawScores: {
        type: "object",
        properties: {
          clarity: { type: "integer", minimum: 0, maximum: 24 },
          pain: { type: "integer", minimum: 0, maximum: 16 },
          value: { type: "integer", minimum: 0, maximum: 18 },
          trust: { type: "integer", minimum: 0, maximum: 14 },
          cta: { type: "integer", minimum: 0, maximum: 16 },
          structure: { type: "integer", minimum: 0, maximum: 12 },
        },
        required: ["clarity", "pain", "value", "trust", "cta", "structure"],
        propertyOrdering: ["clarity", "pain", "value", "trust", "cta", "structure"],
      },
      issues: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 4,
      },
      actions: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 3,
      },
      rewrite: {
        type: "object",
        properties: {
          headline: { type: "string" },
          subhead: { type: "string" },
          cta: { type: "string" },
        },
        required: ["headline", "subhead", "cta"],
        propertyOrdering: ["headline", "subhead", "cta"],
      },
    },
    required: ["total", "diagnosis", "rawScores", "issues", "actions", "rewrite"],
    propertyOrdering: ["total", "diagnosis", "rawScores", "issues", "actions", "rewrite"],
  };
}

function extractGeminiText(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim() || ""
  );
}

function matchTags(html, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const matches = [];

  for (const match of html.matchAll(pattern)) {
    matches.push(match[1]);
  }

  return matches;
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match?.[1] ? normalizeWhitespace(match[1]) : "";
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function validateReportId(id) {
  if (typeof id !== "string" || !/^\d+-[a-z0-9]{6}$/.test(id)) {
    return null;
  }
  return id;
}

function reportFilePath(id) {
  const safeId = validateReportId(id);
  if (!safeId) {
    throw new Error("Invalid report ID");
  }
  return path.join(reportsDir, `${safeId}.json`);
}

async function readJson(req) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > MAX_JSON_SIZE) {
      throw new Error("Payload Too Large");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON");
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function checkAdminAuth(req) {
  if (!process.env.ADMIN_TOKEN) return true;
  return req.headers.authorization === `Bearer ${process.env.ADMIN_TOKEN}`;
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function resolveProvider() {
  const forced = process.env.AI_PROVIDER?.trim().toLowerCase();

  if (forced === "gemini" || forced === "openai" || forced === "heuristic") {
    return forced;
  }

  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "heuristic";
}

function safeJsonParse(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const withoutFence = trimmed.replace(/^```json\s*|\s*```$/g, "");

  try {
    return JSON.parse(withoutFence);
  } catch {
    return null;
  }
}
