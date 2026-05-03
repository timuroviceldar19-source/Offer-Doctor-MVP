export const buckets = [
  {
    key: "clarity",
    title: "Ясность оффера",
    weight: 24,
  },
  {
    key: "pain",
    title: "Попадание в боль",
    weight: 16,
  },
  {
    key: "value",
    title: "Конкретность ценности",
    weight: 18,
  },
  {
    key: "trust",
    title: "Доверие",
    weight: 14,
  },
  {
    key: "cta",
    title: "Сила CTA",
    weight: 16,
  },
  {
    key: "structure",
    title: "Структура страницы",
    weight: 12,
  },
];

const keywordGroups = {
  pain: [
    "проблем",
    "теря",
    "дорог",
    "хаос",
    "долго",
    "сложно",
    "не успева",
    "ошиб",
    "ручн",
    "потер",
  ],
  value: [
    "рост",
    "увелич",
    "сниз",
    "эконом",
    "за ",
    "за 7",
    "за 14",
    "за 30",
    "%",
    "x",
    "в 2 раза",
    "результат",
  ],
  trust: [
    "кейс",
    "отзыв",
    "клиент",
    "нам доверяют",
    "пример",
    "цифр",
    "команд",
    "бренд",
    "гарант",
    "рейтинг",
  ],
  cta: [
    "оставить заявку",
    "получить",
    "записаться",
    "забронировать",
    "начать",
    "получить аудит",
    "запросить",
    "посмотреть демо",
  ],
  structure: [
    "как это работает",
    "для кого",
    "что внутри",
    "почему мы",
    "faq",
    "вопрос",
    "этап",
    "процесс",
  ],
};

export function heuristicAudit({ niche, audience, goal, url, copy }) {
  const normalized = normalize(copy);
  const firstScreen = copy
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const sentenceCount = copy.split(/[.!?]+/).filter((item) => item.trim().length > 2).length;

  const clarity = scoreClarity(firstScreen, audience);
  const pain = scoreKeywordCoverage(normalized, keywordGroups.pain, 16);
  const value = scoreValue(normalized);
  const trust = scoreKeywordCoverage(normalized, keywordGroups.trust, 14);
  const cta = scoreCta(normalized, goal);
  const structure = scoreStructure(normalized, sentenceCount, wordCount);

  const rawScores = { clarity, pain, value, trust, cta, structure };
  const total = Math.max(
    22,
    Math.min(
      98,
      Math.round(
        Object.entries(rawScores).reduce((sum, [key, value]) => {
          const bucket = buckets.find((item) => item.key === key);
          return sum + Math.min(bucket.weight, value);
        }, 0)
      )
    )
  );

  return {
    total,
    diagnosis: buildDiagnosis(total),
    toneClass: buildToneClass(total),
    rawScores,
    issues: buildIssues(rawScores, audience, goal),
    actions: buildActions(rawScores, audience, goal),
    rewrite: buildRewrite({ niche, audience, goal, firstScreen, url }),
    source: "heuristic",
  };
}

export function normalizeAiReport(candidate, input) {
  const fallback = heuristicAudit(input);
  const report = candidate && typeof candidate === "object" ? candidate : {};
  const rawScores = sanitizeRawScores(report.rawScores, fallback.rawScores);
  const total =
    typeof report.total === "number"
      ? clamp(Math.round(report.total), 0, 100)
      : recomputeTotal(rawScores);
  const issues = sanitizeStringList(report.issues, fallback.issues, 4);
  const actions = sanitizeStringList(report.actions, fallback.actions, 3);
  const rewrite = sanitizeRewrite(report.rewrite, fallback.rewrite);
  const diagnosis = typeof report.diagnosis === "string" ? report.diagnosis.trim() : buildDiagnosis(total);

  return {
    total,
    diagnosis,
    toneClass: buildToneClass(total),
    rawScores,
    issues,
    actions,
    rewrite,
    source: "ai",
  };
}

export function goalLabel(goal) {
  switch (goal) {
    case "call":
      return "записи на созвон";
    case "demo":
      return "запросу демо";
    case "sale":
      return "прямой продаже";
    default:
      return "получению заявки";
  }
}

export function goalCta(goal) {
  switch (goal) {
    case "call":
      return "Забронировать разбор на 15 минут";
    case "demo":
      return "Получить демо с разбором страницы";
    case "sale":
      return "Получить предложение и стартовать";
    default:
      return "Получить разбор и точки роста";
  }
}

function scoreClarity(firstScreen, audience) {
  let score = 8;
  const text = normalize(firstScreen);
  const words = text.split(/\s+/).filter(Boolean).length;

  if (words >= 8 && words <= 24) score += 6;
  if (/\d/.test(firstScreen)) score += 3;
  if (audience && text.includes(normalize(audience).split(" ")[0])) score += 4;
  if (/(для|помогаем|увелич|снижа|получите|рост|заяв)/.test(text)) score += 3;

  return clamp(score, 0, 24);
}

function scoreKeywordCoverage(text, keywords, max) {
  const found = keywords.filter((keyword) => text.includes(keyword)).length;
  return clamp(4 + found * 2, 0, max);
}

function scoreValue(text) {
  let score = 5;

  if (/\d/.test(text)) score += 4;
  if (/%|x|раза|дней|недель|месяц/.test(text)) score += 4;
  if (/(результат|рост|эконом|конверс|заяв|лид)/.test(text)) score += 3;
  if (/(без|вместо|автомат|быстр|точн)/.test(text)) score += 2;

  return clamp(score, 0, 18);
}

function scoreCta(text, goal) {
  let score = scoreKeywordCoverage(text, keywordGroups.cta, 14);

  if (
    (goal === "lead" && text.includes("заяв")) ||
    (goal === "call" && text.includes("созвон")) ||
    (goal === "demo" && text.includes("демо")) ||
    (goal === "sale" && text.includes("куп"))
  ) {
    score += 2;
  }

  return clamp(score, 0, 16);
}

function scoreStructure(text, sentenceCount, wordCount) {
  let score = 4;
  const found = keywordGroups.structure.filter((keyword) => text.includes(keyword)).length;

  score += found * 2;
  if (sentenceCount >= 8) score += 2;
  if (wordCount >= 120) score += 2;

  return clamp(score, 0, 12);
}

function buildIssues(scores, audience, goal) {
  const items = [];

  if (scores.clarity < 15) {
    items.push(
      `Первый экран не доносит ценность достаточно быстро. Пользователь должен понять за 3 секунды, что вы делаете для ${audience || "своей аудитории"}.`
    );
  }

  if (scores.pain < 10) {
    items.push("В тексте мало напряжения и боли клиента. Пока это больше описание услуги, чем удар в проблему.");
  }

  if (scores.value < 11) {
    items.push("Недостаточно конкретики: мало цифр, сроков или обещанного результата. Без этого оффер воспринимается как общий.");
  }

  if (scores.trust < 9) {
    items.push("Слабый слой доверия. Нужны кейсы, примеры, цифры, знакомые бренды или гарантия.");
  }

  if (scores.cta < 10) {
    items.push(`CTA не ведет к цели страницы. Пользователю должно быть очевидно, как сделать следующий шаг: ${goalLabel(goal)}.`);
  }

  if (scores.structure < 8) {
    items.push("Страница выглядит недостаточно собранной: не хватает блоков «как это работает», FAQ или последовательной логики прогрева.");
  }

  if (items.length === 0) {
    items.push(
      `Страница уже выглядит собранной, но я бы еще проверил, насколько первый экран сильнее конкурентов в сегменте ${audience || "вашей аудитории"}.`
    );
    items.push(`Проверьте, действительно ли главный CTA ведет к ${goalLabel(goal).toLowerCase()} без лишних отвлечений.`);
  }

  return items.slice(0, 4);
}

function buildActions(scores, audience, goal) {
  const actions = [];
  const sorted = Object.entries(scores)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([key]) => key);

  if (sorted.includes("clarity")) {
    actions.push(
      `Перепишите заголовок в формате «что вы делаете + для кого + какой результат». Сразу назовите ${audience || "сегмент"} и выгоду.`
    );
  }

  if (sorted.includes("pain")) {
    actions.push("Добавьте 2-3 фразы, которые отражают хаос, потери времени или денег до работы с вами.");
  }

  if (sorted.includes("value")) {
    actions.push("Вынесите конкретику на первый экран: сроки, проценты, диапазон результата или понятный deliverable.");
  }

  if (sorted.includes("trust")) {
    actions.push("Поднимите доверие выше по странице: мини-кейс, социальное доказательство, цифры или гарантия.");
  }

  if (sorted.includes("cta")) {
    actions.push(`Оставьте один главный CTA и свяжите его с целью страницы: ${goalLabel(goal)}.`);
  }

  if (sorted.includes("structure")) {
    actions.push("Соберите страницу в четкую воронку: боль, решение, выгода, доверие, CTA, FAQ.");
  }

  if (actions.length === 0) {
    actions.push("Запустите 2 варианта первого экрана и сравните, какой оффер лучше двигает клик по CTA.");
    actions.push("Поднимите один сильный кейс выше сгиба и посмотрите, меняется ли глубина просмотра.");
    actions.push(`Сведите страницу к одному следующему шагу: ${goalLabel(goal)}.`);
  }

  return actions.slice(0, 3);
}

function buildRewrite({ niche, audience, goal, firstScreen, url }) {
  const audienceLabel = audience || "целевой аудитории";
  const nicheLabel = niche || "вашей ниши";
  const sourceHint = url ? `по мотивам страницы ${url}` : "на основе введенного текста";

  const headline = `Помогаем ${audienceLabel} быстрее получать больше заявок без перегруза команды`;
  const subhead = `Offer Doctor заметит, где оффер на лендинге звучит общо, не вызывает доверия и не подводит к действию. Первая версия аудита собирается ${sourceHint} и показывает, что править в первую очередь для ${nicheLabel}.`;
  const cta = `CTA для теста: ${goalCta(goal)}.`;

  if (firstScreen.length > 0 && normalize(firstScreen).includes("аудит")) {
    return {
      headline: `Покажем, почему ваш аудит не продает, и превратим его в оффер, который двигает к ${goalLabel(goal).toLowerCase()}`,
      subhead,
      cta,
    };
  }

  return { headline, subhead, cta };
}

function sanitizeRawScores(candidate, fallback) {
  const output = {};

  for (const bucket of buckets) {
    const rawValue = candidate?.[bucket.key];
    output[bucket.key] =
      typeof rawValue === "number"
        ? clamp(Math.round(rawValue), 0, bucket.weight)
        : fallback[bucket.key];
  }

  return output;
}

function sanitizeStringList(candidate, fallback, limit) {
  const normalized = Array.isArray(candidate)
    ? candidate
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];

  return normalized.length > 0 ? normalized : fallback.slice(0, limit);
}

function sanitizeRewrite(candidate, fallback) {
  if (!candidate || typeof candidate !== "object") return fallback;

  return {
    headline:
      typeof candidate.headline === "string" && candidate.headline.trim()
        ? candidate.headline.trim()
        : fallback.headline,
    subhead:
      typeof candidate.subhead === "string" && candidate.subhead.trim()
        ? candidate.subhead.trim()
        : fallback.subhead,
    cta:
      typeof candidate.cta === "string" && candidate.cta.trim() ? candidate.cta.trim() : fallback.cta,
  };
}

function recomputeTotal(rawScores) {
  return clamp(
    Math.round(
      Object.entries(rawScores).reduce((sum, [key, value]) => {
        const bucket = buckets.find((item) => item.key === key);
        return sum + Math.min(bucket.weight, value);
      }, 0)
    ),
    0,
    100
  );
}

function buildDiagnosis(total) {
  if (total >= 80) return "Сильная база. Уже можно тестировать трафик и шлифовать отдельные узкие места.";
  if (total >= 62) return "Нормальный каркас, но оффер пока не дожимает конверсию. Есть несколько явных точек роста.";
  return "Слабая упаковка. До закупки трафика или активного SEO страницу лучше переписать.";
}

function buildToneClass(total) {
  if (total >= 80) return "tone-good";
  if (total >= 62) return "tone-mid";
  return "tone-bad";
}

function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
