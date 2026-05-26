const crypto = require("node:crypto");
const admin = require("firebase-admin");
const OpenAI = require("openai");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

admin.initializeApp();
const db = admin.firestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const ADMIN_EMAIL = "alain.sc2@gmail.com";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MODEL_LONG = process.env.OPENAI_MODEL_LONG || process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_USER_AGENT = "SwipeKnowledgePrototype/0.1 (admin-local; alain.sc2@gmail.com)";
const FULL_EXTRACT_LIMIT = 60000;
const LONG_CARD_MIN_WORDS = 1200;

const ALLOWED_MAIN_CATEGORIES = ["geschichte","wissenschaft","geografie","politik","gesellschaft","religion","philosophie","technik","wirtschaft","kultur","sport","biografie","natur","medizin","mythologie","allgemeinwissen"];
const ALLOWED_TOPIC_TYPES = ["person","historical_event","historical_period","place","country","organization","concept","scientific_concept","religion","ideology","technology","invention","conflict","treaty","natural_object","cultural_work","sport_event","other"];
const REQUIRED_CARD_KEYS = ["de_short", "de_medium", "de_long", "en_short", "en_medium", "en_long"];
const PREVIEW_MAX_CHARS = 3000;

const topicMetaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["wikidataId", "mainCategory", "topicType", "tags", "suggestedRelatedTopics", "factualLimitations", "qualityNotes"],
  properties: {
    wikidataId: { type: "string" },
    mainCategory: { type: "string", enum: ALLOWED_MAIN_CATEGORIES },
    topicType: { type: "string", enum: ALLOWED_TOPIC_TYPES },
    tags: { type: "array", items: { type: "string" } },
    suggestedRelatedTopics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "reason"],
        properties: {
          title: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    factualLimitations: { type: "array", items: { type: "string" } },
    qualityNotes: { type: "string" },
  },
};

const cardItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["language", "length", "cardType", "title", "hook", "body", "needsMoreSourceMaterial", "sourceBasis", "sourceIds", "sourceLimitations"],
  properties: {
    language: { type: "string", enum: ["de", "en"] },
    length: { type: "string", enum: ["short", "medium", "long"] },
    cardType: { type: "string", enum: ["intro", "fact", "timeline", "deep_dive", "comparison", "myth_buster"] },
    title: { type: "string" },
    hook: { type: "string" },
    body: { type: "string" },
    needsMoreSourceMaterial: { type: "boolean" },
    sourceBasis: { type: "array", items: { type: "string", enum: ["wikidata", "wikipedia_de", "wikipedia_en"] } },
    sourceIds: { type: "array", items: { type: "string" } },
    sourceLimitations: { type: "array", items: { type: "string" } },
  },
};

// Used for final combined-output validation (6 cards)
const swipeCardsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topicMeta", "cards"],
  properties: {
    topicMeta: topicMetaSchema,
    cards: { type: "array", minItems: 6, maxItems: 6, items: cardItemSchema },
  },
};

// Call 1: short + medium cards (4 cards) + topicMeta
const shortMediumCardsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topicMeta", "cards"],
  properties: {
    topicMeta: topicMetaSchema,
    cards: { type: "array", minItems: 4, maxItems: 4, items: cardItemSchema },
  },
};

// Call 2: long cards only (2 cards, dedicated full token budget)
const longCardsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: { type: "array", minItems: 2, maxItems: 2, items: cardItemSchema },
  },
};


function safeString(v) { return v == null ? "" : String(v); }
function removeUndefinedDeep(v) {
  if (Array.isArray(v)) return v.map(removeUndefinedDeep).filter((x) => x !== undefined);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const clean = removeUndefinedDeep(val);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  return v === undefined ? undefined : v;
}

function extractWikipediaTitleFromUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname || "";
    const idx = path.indexOf("/wiki/");
    if (idx === -1) return null;
    const rawTitle = path.slice(idx + 6).trim();
    if (!rawTitle) return null;
    return decodeURIComponent(rawTitle);
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const tryFetch = async (headers) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  try {
    return await tryFetch({ "Api-User-Agent": API_USER_AGENT });
  } catch (_) {
    return tryFetch({});
  }
}

async function fetchWikipediaSummaryByUrl(url, language) {
  const title = extractWikipediaTitleFromUrl(url);
  if (!title) return null;
  const encodedTitle = encodeURIComponent(title);
  const data = await fetchJson(`https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`);
  return { title: safeString(data?.title), extract: safeString(data?.extract) };
}

async function fetchWikipediaFullExtractByUrl(url, language) {
  const title = extractWikipediaTitleFromUrl(url);
  if (!title) return { fullExtract: "", fullExtractLoaded: false, fullExtractTruncated: false, fullExtractCharCount: 0 };
  const encodedTitle = encodeURIComponent(title);
  const data = await fetchJson(`https://${language}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exintro=0&redirects=1&format=json&origin=*&titles=${encodedTitle}`);
  const page = Object.values(data?.query?.pages || {})[0] || {};
  const extract = safeString(page?.extract);
  return {
    fullExtract: extract.slice(0, FULL_EXTRACT_LIMIT),
    fullExtractLoaded: extract.length > 0,
    fullExtractTruncated: extract.length > FULL_EXTRACT_LIMIT,
    fullExtractCharCount: extract.length,
  };
}

async function loadWikipediaForTopic(topic, warnings) {
  const result = {
    de: { url: safeString(topic?.sitelinks?.dewiki), summary: null, full: { fullExtract: "", fullExtractLoaded: false, fullExtractTruncated: false, fullExtractCharCount: 0 } },
    en: { url: safeString(topic?.sitelinks?.enwiki), summary: null, full: { fullExtract: "", fullExtractLoaded: false, fullExtractTruncated: false, fullExtractCharCount: 0 } },
  };

  for (const lang of ["de", "en"]) {
    if (!result[lang].url) continue;
    try { result[lang].summary = await fetchWikipediaSummaryByUrl(result[lang].url, lang); } catch (e) { warnings.push(`Wikipedia ${lang.toUpperCase()} Summary fehlgeschlagen: ${e.message}`); }
    try { result[lang].full = await fetchWikipediaFullExtractByUrl(result[lang].url, lang); } catch (e) { warnings.push(`Wikipedia ${lang.toUpperCase()} Fulltext fehlgeschlagen: ${e.message}`); }
  }
  return result;
}

function buildSourcePack(topic, wikiDe, wikiEn) {
  const wikidataId = safeString(topic.wikidataId || topic.id);
  return removeUndefinedDeep({
    topic: {
      wikidataId,
      title: { de: safeString(topic?.title?.de), en: safeString(topic?.title?.en) },
      description: { de: safeString(topic?.description?.de), en: safeString(topic?.description?.en) },
      aliases: { de: Array.isArray(topic?.aliases?.de) ? topic.aliases.de : [], en: Array.isArray(topic?.aliases?.en) ? topic.aliases.en : [] },
      mainCategory: safeString(topic?.mainCategory),
      topicType: safeString(topic?.topicType),
      tags: Array.isArray(topic?.tags) ? topic.tags : [],
      sitelinks: topic?.sitelinks || {},
      claimsMeta: topic?.claimsMeta || {},
    },
    sources: {
      wikidata: { id: `wikidata_${wikidataId}`, url: `https://www.wikidata.org/wiki/${wikidataId}`, license: "CC0", available: true },
      wikipediaDe: {
        id: `wikipedia_de_${wikidataId}`,
        url: safeString(topic?.sitelinks?.dewiki),
        license: "CC BY-SA 4.0",
        summaryTitle: safeString(wikiDe?.summary?.title),
        summaryExtract: safeString(wikiDe?.summary?.extract),
        fullExtract: safeString(wikiDe?.full?.fullExtract),
        fullExtractLoaded: !!wikiDe?.full?.fullExtractLoaded,
        fullExtractTruncated: !!wikiDe?.full?.fullExtractTruncated,
        fullExtractCharCount: Number(wikiDe?.full?.fullExtractCharCount || 0),
        available: !!(wikiDe?.summary?.extract || wikiDe?.full?.fullExtractLoaded),
      },
      wikipediaEn: {
        id: `wikipedia_en_${wikidataId}`,
        url: safeString(topic?.sitelinks?.enwiki),
        license: "CC BY-SA 4.0",
        summaryTitle: safeString(wikiEn?.summary?.title),
        summaryExtract: safeString(wikiEn?.summary?.extract),
        fullExtract: safeString(wikiEn?.full?.fullExtract),
        fullExtractLoaded: !!wikiEn?.full?.fullExtractLoaded,
        fullExtractTruncated: !!wikiEn?.full?.fullExtractTruncated,
        fullExtractCharCount: Number(wikiEn?.full?.fullExtractCharCount || 0),
        available: !!(wikiEn?.summary?.extract || wikiEn?.full?.fullExtractLoaded),
      },
    },
  });
}

function buildOpenAIPromptShortMedium(sourcePack) {
  return `Du bist ein redaktioneller Wissensassistent für eine Swipe-Lernapp.
Gib AUSSCHLIESSLICH ein JSON-Objekt in dieser Top-Level-Struktur zurück:
{"topicMeta": {...}, "cards": [...]}
Kein Markdown, keine Backticks, keine Erklärungen außerhalb des JSON.

ALLGEMEINE REGELN:
- Nutze ausschliesslich Informationen aus dem SOURCE PACK. Erfinde keine Fakten, keine externen Quellen.
- Erstelle exakt 4 Cards: de-short, de-medium, en-short, en-medium.
- length MUSS exakt "short" oder "medium" sein (KEIN "long" in diesem Aufruf).
- Jede Card MUSS das Feld body verwenden (niemals text).
- Jede Card MUSS sourceBasis und sourceIds enthalten.
- language MUSS exakt "de" oder "en" sein.
- Sprache: de-Cards auf Deutsch, en-Cards auf Englisch.
- Wenn Quellenmaterial nicht ausreicht: needsMoreSourceMaterial=true, body trotzdem so gut wie möglich aus verfügbarem Material.

SHORT (80–150 Wörter):
- Genau 2–4 prägnante, dichte Sätze, die den absoluten Kerninhalt des Themas auf den Punkt bringen.
- Teasercharakter: Der Leser erhält sofort die wichtigsten Informationen und wird neugierig auf mehr.
- Kein "Lies mehr", kein "In der langen Version", keine Aufforderung zum Weiterlesen.
- Trotz Kürze eine stichhaltige, faktisch korrekte Zusammenfassung – kein Fülltext.
- Der hook darf eine direkte Frage oder eine überraschende Aussage sein.

MEDIUM (400–900 Wörter):
- Deutlich ausführlicher als Short: mehrere gut strukturierte Absätze.
- Enthält Kontext, Hintergrund, historische oder wissenschaftliche Bedeutung sowie die wichtigsten Details.
- Nutze primär den Wikipedia-Volltext aus dem SOURCE PACK; gehe über die Kurzbeschreibung hinaus.
- Keine Kapitelüberschriften nötig, aber klare Absatztrennung und logischer Aufbau.
- Sachlich, informativ und verständlich für ein breites Publikum ohne Vorkenntnisse.

SOURCE PACK:
${JSON.stringify(sourcePack)}`;
}

function buildOpenAIPromptLong(sourcePack) {
  const deTitle = safeString(sourcePack?.topic?.title?.de || sourcePack?.topic?.title?.en);
  const enTitle = safeString(sourcePack?.topic?.title?.en || sourcePack?.topic?.title?.de);
  return `Du bist ein redaktioneller Wissensassistent für eine Swipe-Lernapp.
Gib AUSSCHLIESSLICH ein JSON-Objekt zurück: {"cards": [...]}
Kein Markdown, keine Backticks, keine Erklärungen außerhalb des JSON.

Erstelle GENAU 2 Long-Deep-Dive-Cards: de-long (auf Deutsch) und en-long (auf Englisch).
- language MUSS exakt "de" bzw. "en" sein.
- length MUSS exakt "long" sein.
- cardType MUSS "deep_dive" sein.
- Jede Card MUSS das Feld body verwenden (niemals text).
- Jede Card MUSS sourceBasis und sourceIds enthalten.
- Nutze ausschliesslich Informationen aus dem SOURCE PACK. Erfinde keine Fakten.

LONG DEEP DIVE – PFLICHTANFORDERUNGEN (KRITISCH):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. MINDESTLÄNGE: Der body MUSS mindestens 1800 Wörter enthalten. 2000–3000 Wörter sind das Ziel.
2. STRUKTUR: Verwende ## für Kapitelüberschriften. Mindestens 4 Unterkapitel, je mindestens 300 Wörter.
3. INHALT: Nutze den gesamten Wikipedia-Volltext aus dem SOURCE PACK. Strukturiere, fasse zusammen
   und erkläre didaktisch – nicht Satz für Satz kopieren, aber ALLE Fakten aus dem SOURCE PACK verwenden.
4. TIEFE: Jedes Unterkapitel soll in die Tiefe gehen. Kein Fülltext – echter Inhalt aus dem SOURCE PACK.
5. Wenn Quellenmaterial begrenzt ist: needsMoreSourceMaterial=true, aber vorhandenes Material maximal ausschöpfen.

PFLICHTSTRUKTUR für de-long body (Thema: "${deTitle}"):
## Überblick
[Mindestens 300 Wörter: Das Thema vorstellen, seine zentrale Bedeutung erklären, historischen Kontext einbetten]

## [Themenspezifisches Kapitel 1 aus Wikipedia-Inhalt]
[Mindestens 350 Wörter: Wichtigste Aspekte, Details, Zusammenhänge aus Wikipedia-Volltext]

## [Themenspezifisches Kapitel 2 aus Wikipedia-Inhalt]
[Mindestens 350 Wörter: Weitere wichtige Aspekte aus Wikipedia-Volltext]

## [Themenspezifisches Kapitel 3 aus Wikipedia-Inhalt]
[Mindestens 300 Wörter: Kontext, Hintergründe, Auswirkungen aus Wikipedia-Volltext]

## Bedeutung und Nachwirkung
[Mindestens 300 Wörter: Historische oder gesellschaftliche Bedeutung, Rezeption, Einfluss bis heute]

PFLICHTSTRUKTUR für en-long body (Topic: "${enTitle}"):
[Gleiche Struktur auf Englisch, mit Kapiteln in Englisch basierend auf dem englischen Wikipedia-Material]

SOURCE PACK (Wikipedia-Volltext ist der primäre Inhalt für die Long-Cards):
${JSON.stringify(sourcePack)}`;
}
function preview(value) { return safeString(value).slice(0, PREVIEW_MAX_CHARS); }
function stripJsonFences(text) { return safeString(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(); }
function safeJsonParse(text) { try { return { ok: true, value: JSON.parse(text), error: null }; } catch (error) { return { ok: false, value: null, error: error.message }; } }
function extractFirstJsonObject(text) {
  const input = safeString(text).trim();
  const start = input.indexOf("{");
  if (start < 0) return "";
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return "";
}
function extractOpenAIText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const parts = [];

  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
      if (typeof content?.json === "object" && content.json) {
        parts.push(JSON.stringify(content.json));
      }
      if (typeof content?.parsed === "object" && content.parsed) {
        parts.push(JSON.stringify(content.parsed));
      }
      if (typeof content?.refusal === "string" && content.refusal.trim()) {
        parts.push(JSON.stringify({ refusal: content.refusal.trim() }));
      }
    }
  }

  return parts.join("\n").trim();
}
function unwrapAIOutput(parsed) {
  if (parsed && typeof parsed === "object" && parsed.topicMeta && parsed.cards) return parsed;
  for (const key of ["data", "result", "output"]) {
    const nested = parsed?.[key];
    if (nested && typeof nested === "object" && nested.topicMeta && nested.cards) return nested;
  }
  return parsed;
}
function normalizeLanguage(value) {
  const key = safeString(value).trim().toLowerCase();
  if (["de", "deutsch", "german"].includes(key)) return "de";
  if (["en", "english", "englisch"].includes(key)) return "en";
  return safeString(value).trim();
}
function normalizeLength(value) {
  const key = safeString(value).trim().toLowerCase();
  if (["short", "kurz"].includes(key)) return "short";
  if (["medium", "mittel"].includes(key)) return "medium";
  if (["long", "lang"].includes(key)) return "long";
  return safeString(value).trim();
}
function normalizeAIOutput(output, warnings = [], context = {}) {
  const sourceAvailability = context?.sourceAvailability || {};
  const topicId = safeString(context?.topicId).trim();
  const wikidataId = safeString(context?.wikidataId).trim();
  if (!output || typeof output !== "object" || !Array.isArray(output.cards)) return output;
  const availableSourceBasis = ["wikidata"];
  if (sourceAvailability?.wikipediaDeSummary || sourceAvailability?.wikipediaDeFull) availableSourceBasis.push("wikipedia_de");
  if (sourceAvailability?.wikipediaEnSummary || sourceAvailability?.wikipediaEnFull) availableSourceBasis.push("wikipedia_en");
  const sourceKey = safeString(wikidataId || topicId).trim();
  const derivedSourceIds = availableSourceBasis.map((source) => `${source}_${sourceKey}`);
  output.cards = output.cards.map((card) => {
    const next = { ...(card || {}) };
    next.language = normalizeLanguage(next.language);
    next.length = normalizeLength(next.length);
    const cardKey = `${next.language || "unknown"}_${next.length || "unknown"}`;
    if (!safeString(next.body).trim() && safeString(next.text).trim()) {
      next.body = safeString(next.text);
      warnings.push(`text wurde in ${cardKey} zu body normalisiert`);
    }
    if (typeof next.sourceBasis === "string") next.sourceBasis = [next.sourceBasis];
    if (!Array.isArray(next.sourceBasis) || !next.sourceBasis.length) {
      next.sourceBasis = [...availableSourceBasis];
      warnings.push(`sourceBasis fehlte in ${cardKey} und wurde aus verfügbaren Quellen ergänzt`);
    }
    if (typeof next.sourceIds === "string") next.sourceIds = [next.sourceIds];
    if (!Array.isArray(next.sourceIds) || !next.sourceIds.length) {
      next.sourceIds = [...derivedSourceIds];
      warnings.push(`sourceIds fehlte in ${cardKey} und wurde aus topicId/wikidataId ergänzt`);
    }
    return next;
  });
  return output;
}
function validateAIOutput(output, warnings = []) {
  if (!output || typeof output !== "object") throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: Kein Objekt.");
  if (!output.topicMeta || typeof output.topicMeta !== "object") throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: topicMeta fehlt.");
  if (output.cards == null) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: cards fehlt.");
  if (!Array.isArray(output.cards)) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: cards ist kein Array.");
  if (output.cards.length !== 6) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: Es müssen genau 6 Cards sein.");

  if (!ALLOWED_MAIN_CATEGORIES.includes(output.topicMeta.mainCategory)) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: mainCategory ungültig.");
  if (!ALLOWED_TOPIC_TYPES.includes(output.topicMeta.topicType)) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: topicType ungültig.");
  if (!Array.isArray(output.topicMeta.tags)) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: tags muss ein Array sein.");

  const seen = new Set();
  for (const card of output.cards) {
    const key = `${card?.language || "unknown"}_${card?.length || "unknown"}`;
    if (!REQUIRED_CARD_KEYS.includes(key)) {
      throw new HttpsError("failed-precondition", `Ungültige Karten-Kombination: ${key}`);
    }
    if (seen.has(key)) {
      throw new HttpsError("failed-precondition", `Karten-Kombination doppelt: ${key}`);
    }
    seen.add(key);
    if (!safeString(card?.title).trim()) throw new HttpsError("failed-precondition", `Leerer title in ${key}.`);
    if (!safeString(card?.hook).trim()) throw new HttpsError("failed-precondition", `Leerer hook in ${key}.`);
    if (!safeString(card?.body).trim()) throw new HttpsError("failed-precondition", `Card hat kein body: ${key}.`);
    if (!Array.isArray(card?.sourceBasis) || !card.sourceBasis.length) throw new HttpsError("failed-precondition", `sourceBasis fehlt in ${key}.`);
    if (!Array.isArray(card?.sourceIds)) throw new HttpsError("failed-precondition", `sourceIds fehlt oder falscher Typ in ${key}.`);
    if (!["de", "en"].includes(safeString(card?.language))) throw new HttpsError("failed-precondition", `language ungültig in ${key}.`);
    if (!["short", "medium", "long"].includes(safeString(card?.length))) throw new HttpsError("failed-precondition", `length ungültig in ${key}.`);
  }
  for (const requiredKey of REQUIRED_CARD_KEYS) {
    if (!seen.has(requiredKey)) throw new HttpsError("failed-precondition", `Fehlende Karten-Kombination: ${requiredKey}`);
  }
}
function buildResponseDebugSummary(response, rawOpenAIText = "") {
  const output = Array.isArray(response?.output) ? response.output : [];
  return removeUndefinedDeep({
    responseStatus: response?.status || null,
    responseError: response?.error || null,
    incompleteDetails: response?.incomplete_details || null,
    responseModel: response?.model || null,
    usage: response?.usage || null,
    outputTypes: output.map((item) => item?.type || null).filter(Boolean),
    outputItemPreview: preview(JSON.stringify(output)),
    outputTextLength: safeString(response?.output_text).length,
    rawOpenAITextPreview: preview(rawOpenAIText),
    responseKeys: Object.keys(response || {}),
  });
}

function createFailedPrecondition(type, message, details = {}) {
  return new HttpsError("failed-precondition", message, removeUndefinedDeep({ errorType: type, ...details }));
}

function calculateReadingStats(text) { const wordCount = safeString(text).trim().split(/\s+/).filter(Boolean).length; return { wordCount, readingTimeSec: Math.max(5, Math.ceil((wordCount / 200) * 60)) }; }
function buildAvailableSourceIds(sp) { const ids = [sp.sources.wikidata.id]; if (sp.sources.wikipediaDe.available) ids.push(sp.sources.wikipediaDe.id); if (sp.sources.wikipediaEn.available) ids.push(sp.sources.wikipediaEn.id); return ids; }
function buildAvailableSources(sp) { const out = [{ type: "wikidata", title: safeString(sp.topic?.title?.de || sp.topic?.title?.en), url: sp.sources.wikidata.url, license: "CC0", publisher: "Wikidata" }]; if (sp.sources.wikipediaDe.available) out.push({ type: "wikipedia", language: "de", title: sp.sources.wikipediaDe.summaryTitle || safeString(sp.topic?.title?.de), url: sp.sources.wikipediaDe.url, license: "CC BY-SA 4.0", publisher: "Wikipedia" }); if (sp.sources.wikipediaEn.available) out.push({ type: "wikipedia", language: "en", title: sp.sources.wikipediaEn.summaryTitle || safeString(sp.topic?.title?.en), url: sp.sources.wikipediaEn.url, license: "CC BY-SA 4.0", publisher: "Wikipedia" }); return out; }

exports.generateSwipeCardsForTopic = onCall({ region: "europe-west1", timeoutSeconds: 300, memory: "1GiB", maxInstances: 2, concurrency: 1, secrets: [OPENAI_API_KEY] }, async (request) => {
  const warnings = []; const cardIds = []; let topicId = ""; let wikidataId = ""; let sourceAvailability = null; let debugDetails = {};
  try {
    if (!request.auth) throw new HttpsError("unauthenticated", "Bitte zuerst einloggen.");
    if (request.auth?.token?.email !== ADMIN_EMAIL) throw new HttpsError("permission-denied", "Nur Admins dürfen KI-Cards generieren.");
    topicId = safeString(request.data?.topicId).trim();
    if (!topicId) throw new HttpsError("invalid-argument", "topicId muss gesetzt sein.");

    const topicRef = db.collection("topics").doc(topicId); const snap = await topicRef.get();
    if (!snap.exists) throw new HttpsError("not-found", "Topic nicht gefunden.");
    const topic = snap.data() || {}; wikidataId = safeString(topic.wikidataId || topicId);

    const wiki = await loadWikipediaForTopic(topic, warnings);
    const sourcePack = buildSourcePack({ ...topic, id: topicId, wikidataId }, wiki.de, wiki.en);
    sourceAvailability = {
      wikidata: true,
      wikipediaDeSummary: !!wiki.de.summary?.extract,
      wikipediaDeFull: !!wiki.de.full.fullExtractLoaded,
      wikipediaDeFullTruncated: !!wiki.de.full.fullExtractTruncated,
      wikipediaEnSummary: !!wiki.en.summary?.extract,
      wikipediaEnFull: !!wiki.en.full.fullExtractLoaded,
      wikipediaEnFullTruncated: !!wiki.en.full.fullExtractTruncated,
    };

    const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
    let output;
    let responseDebug = {};

    // Helper: parse and clean an OpenAI response into a plain JS object
    const parseOpenAIResponse = (response, callLabel) => {
      const rawText = extractOpenAIText(response);
      const debug = buildResponseDebugSummary(response, rawText);
      if (!rawText) {
        throw createFailedPrecondition("openai_empty_response", `OpenAI (${callLabel}) hat keine Text-/JSON-Antwort geliefert.`, {
          responseStatus: debug.responseStatus || null,
          incompleteDetails: debug.incompleteDetails || null,
          outputTypes: debug.outputTypes || [],
          outputTextLength: safeString(response?.output_text).length,
          usage: debug.usage || null,
          model: debug.responseModel || OPENAI_MODEL,
        });
      }
      const cleanedText = stripJsonFences(rawText);
      let parsed = safeJsonParse(cleanedText);
      if (!parsed.ok) {
        const firstObj = extractFirstJsonObject(cleanedText);
        if (firstObj) {
          const fb = safeJsonParse(firstObj);
          if (fb.ok && fb.value && typeof fb.value === "object" && !Array.isArray(fb.value)) {
            parsed = fb;
            warnings.push(`${callLabel}: OpenAI-Antwort enthielt zusätzlichen Text; erstes JSON-Objekt wurde verwendet.`);
          }
        }
      }
      if (!parsed.ok) {
        throw createFailedPrecondition("openai_invalid_json", `OpenAI (${callLabel}) hat kein gültiges JSON geliefert.`, {
          originalError: parsed.error,
          rawOpenAITextPreview: preview(rawText),
          rawOpenAITextLength: safeString(rawText).length,
          ...debug,
        });
      }
      return { value: parsed.value, debug, rawText };
    };

    // ── Call 1: short + medium cards (4 cards) + topicMeta ───────────────────
    const callShortMedium = async (useFallback = false) => {
      const userPrompt = useFallback
        ? `${buildOpenAIPromptShortMedium(sourcePack)}\n\nReturn only valid JSON. No Markdown.`
        : buildOpenAIPromptShortMedium(sourcePack);
      return client.responses.create({
        model: OPENAI_MODEL,
        max_output_tokens: 8000,
        input: [
          {
            role: "system",
            content: "Du bist ein redaktioneller Wissensassistent für eine Swipe-Lernapp. Verwende ausschliesslich Informationen aus dem SOURCE PACK. Gib ausschliesslich gültiges JSON zurück. language MUSS exakt \"de\" oder \"en\" sein. length MUSS exakt \"short\" oder \"medium\" sein. Der Haupttext MUSS im Feld \"body\" stehen, niemals in \"text\". SHORT: 2–4 prägnante Sätze. MEDIUM: 400–900 Wörter, mehrere Absätze.",
          },
          { role: "user", content: userPrompt },
        ],
        text: useFallback
          ? { format: { type: "json_object" } }
          : { format: { type: "json_schema", name: "short_medium_cards", schema: shortMediumCardsSchema, strict: true } },
      });
    };

    // ── Call 2: long cards only (2 cards, dedicated full token budget) ────────
    const callLong = async (useFallback = false) => {
      const userPrompt = useFallback
        ? `${buildOpenAIPromptLong(sourcePack)}\n\nReturn only valid JSON. No Markdown.`
        : buildOpenAIPromptLong(sourcePack);
      return client.responses.create({
        model: OPENAI_MODEL_LONG,
        max_output_tokens: 16000,
        input: [
          {
            role: "system",
            content: "Du bist ein redaktioneller Wissensassistent für eine Swipe-Lernapp. Verwende ausschliesslich Informationen aus dem SOURCE PACK. Gib ausschliesslich gültiges JSON zurück. KRITISCH: Erstelle GENAU 2 Long-Cards (de-long und en-long). length MUSS exakt \"long\" sein. Der body MUSS MINDESTENS 1800 Wörter enthalten – das ist eine harte Anforderung. Verwende ## Kapitelüberschriften. Mindestens 4 Unterkapitel à mindestens 300 Wörter. Nutze den gesamten Wikipedia-Volltext aus dem SOURCE PACK.",
          },
          { role: "user", content: userPrompt },
        ],
        text: useFallback
          ? { format: { type: "json_object" } }
          : { format: { type: "json_schema", name: "long_cards", schema: longCardsSchema, strict: true } },
      });
    };

    let shortMediumOutput;
    let longOutput;

    // Call 1: short + medium
    let resp1;
    try {
      resp1 = await callShortMedium(false);
    } catch (e) {
      throw new HttpsError("failed-precondition", `OpenAI Netzwerkfehler (Aufruf 1 Short/Medium): ${e.message}`, removeUndefinedDeep({ errorType: "openai_call1_failed", model: OPENAI_MODEL, sourceAvailability }));
    }
    let r1 = parseOpenAIResponse(resp1, "call1-short-medium");
    if (resp1?.status === "incomplete") {
      let resp1fb;
      try { resp1fb = await callShortMedium(true); } catch (e) { throw new HttpsError("failed-precondition", `OpenAI Netzwerkfehler (Aufruf 1 Fallback): ${e.message}`, { errorType: "openai_call1_fallback_failed" }); }
      r1 = parseOpenAIResponse(resp1fb, "call1-short-medium-fallback");
      warnings.push("call1 fallback (json_object) verwendet.");
      r1.debug.fallbackUsed = true;
    }
    shortMediumOutput = unwrapAIOutput(r1.value);
    responseDebug = { call1: r1.debug };

    // Call 2: long cards
    let resp2;
    try {
      resp2 = await callLong(false);
    } catch (e) {
      throw new HttpsError("failed-precondition", `OpenAI Netzwerkfehler (Aufruf 2 Long): ${e.message}`, removeUndefinedDeep({ errorType: "openai_call2_failed", model: OPENAI_MODEL_LONG, sourceAvailability }));
    }
    let r2 = parseOpenAIResponse(resp2, "call2-long");
    if (resp2?.status === "incomplete") {
      let resp2fb;
      try { resp2fb = await callLong(true); } catch (e) { throw new HttpsError("failed-precondition", `OpenAI Netzwerkfehler (Aufruf 2 Fallback): ${e.message}`, { errorType: "openai_call2_fallback_failed" }); }
      r2 = parseOpenAIResponse(resp2fb, "call2-long-fallback");
      warnings.push("call2 fallback (json_object) verwendet.");
      r2.debug.fallbackUsed = true;
    }
    longOutput = unwrapAIOutput(r2.value);
    responseDebug = { ...responseDebug, call2: r2.debug };

    // Merge both calls into a single output object
    const longCards = Array.isArray(longOutput?.cards) ? longOutput.cards : [];
    output = {
      topicMeta: shortMediumOutput?.topicMeta,
      cards: [...(Array.isArray(shortMediumOutput?.cards) ? shortMediumOutput.cards : []), ...longCards],
    };

    // Warn if long cards are shorter than expected
    for (const card of longCards) {
      const wordCount = safeString(card?.body).trim().split(/\s+/).filter(Boolean).length;
      if (wordCount < LONG_CARD_MIN_WORDS) {
        warnings.push(`WARNUNG: ${safeString(card?.language)}_long hat nur ${wordCount} Wörter (Minimum: ${LONG_CARD_MIN_WORDS}). Quellenmaterial prüfen.`);
      }
    }

    output = normalizeAIOutput(output, warnings, { sourceAvailability, topicId, wikidataId });
    debugDetails = {
      ...responseDebug,
      outputKeys: Object.keys(output || {}),
      outputPreview: JSON.stringify(output || {}).slice(0, PREVIEW_MAX_CHARS),
    };
    if (!output?.topicMeta || !output?.cards) {
      throw createFailedPrecondition("schema_missing_topicMeta_cards", "Ungültige KI-Antwort: topicMeta/cards fehlen.", debugDetails);
    }
    try {
      validateAIOutput(output, warnings);
    } catch (e) {
      const msg = safeString(e?.message);
      const errorType = msg.includes("Fehlende Karten-Kombination") || msg.includes("Leerer") || msg.includes("Card hat kein body") ? "cards_incomplete" : "schema_validation_failed";
      throw createFailedPrecondition(errorType, msg || "Schema-Validierung fehlgeschlagen.", {
        ...debugDetails,
        validationError: msg,
        outputPreview: JSON.stringify(output || {}).slice(0, PREVIEW_MAX_CHARS),
        warnings,
      });
    }

    const sourcePackHash = crypto.createHash("sha256").update(JSON.stringify(sourcePack)).digest("hex");
    const sourceIds = buildAvailableSourceIds(sourcePack); const sources = buildAvailableSources(sourcePack);
    const runRef = db.collection("generationRuns").doc();
    const generationRunId = runRef.id;
    const cardGroupId = `${topicId}_ai_${generationRunId}`;

    const batch = db.batch();
    const existingDrafts = await db.collection("swipeCards").where("topicId", "==", topicId).where("status", "==", "draft").get();
    existingDrafts.forEach((d) => batch.update(d.ref, { status: "archived", archivedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }));

    for (const card of output.cards) {
      const stats = calculateReadingStats(card.body);
      const cardType = safeString(card.cardType || (card.length === "long" ? "deep_dive" : "intro"));
      const cardId = `${topicId}_${card.language}_${card.length}_${cardType}_${generationRunId}`; cardIds.push(cardId);
      const resolvedSourceBasis = Array.isArray(card.sourceBasis) ? card.sourceBasis : ["wikidata"];
      const resolvedSourceIds = Array.isArray(card.sourceIds) && card.sourceIds.length ? card.sourceIds.filter((id) => sourceIds.includes(id)) : sourceIds;
      batch.set(db.collection("swipeCards").doc(cardId), removeUndefinedDeep({
        cardId, topicId, wikidataId, cardGroupId, generationRunId, language: card.language, length: card.length, readingTimeSec: stats.readingTimeSec, wordCount: stats.wordCount,
        cardType, title: safeString(card.title), hook: safeString(card.hook), body: safeString(card.body),
        topicTitle: { de: safeString(topic?.title?.de), en: safeString(topic?.title?.en) },
        sourceIds: resolvedSourceIds, sources, sourceBasis: resolvedSourceBasis, sourceLimitations: Array.isArray(card.sourceLimitations) ? card.sourceLimitations : [], needsMoreSourceMaterial: !!card.needsMoreSourceMaterial,
        tags: Array.isArray(output?.topicMeta?.tags) ? output.topicMeta.tags : [], mainCategory: output.topicMeta.mainCategory, topicType: output.topicMeta.topicType,
        generation: { method: "openai_cloud_function_split", aiGenerated: true, sourceRestricted: true, noNewFactsInstruction: true, sourcePackHash, model: card.length === "long" ? OPENAI_MODEL_LONG : OPENAI_MODEL, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
        status: "draft", reviewStatus: "needs_review", qualityScore: 0, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }));
    }

    batch.set(db.collection("sourceDocs").doc(`wikidata_${wikidataId}`), { sourceType: "wikidata", wikidataId, title: safeString(topic?.title?.de || topic?.title?.en), url: `https://www.wikidata.org/wiki/${wikidataId}`, license: "CC0", publisher: "Wikidata", fetchedAt: admin.firestore.FieldValue.serverTimestamp(), trustLevel: "high" }, { merge: true });
    if (sourcePack.sources.wikipediaDe.available) batch.set(db.collection("sourceDocs").doc(`wikipedia_de_${wikidataId}`), { sourceType: "wikipedia", wikidataId, title: safeString(sourcePack.sources.wikipediaDe.summaryTitle || topic?.title?.de), url: safeString(sourcePack.sources.wikipediaDe.url), license: "CC BY-SA 4.0", publisher: "Wikipedia", language: "de", fetchedAt: admin.firestore.FieldValue.serverTimestamp(), trustLevel: "medium-high" }, { merge: true });
    if (sourcePack.sources.wikipediaEn.available) batch.set(db.collection("sourceDocs").doc(`wikipedia_en_${wikidataId}`), { sourceType: "wikipedia", wikidataId, title: safeString(sourcePack.sources.wikipediaEn.summaryTitle || topic?.title?.en), url: safeString(sourcePack.sources.wikipediaEn.url), license: "CC BY-SA 4.0", publisher: "Wikipedia", language: "en", fetchedAt: admin.firestore.FieldValue.serverTimestamp(), trustLevel: "medium-high" }, { merge: true });

    batch.set(topicRef, { mainCategory: output.topicMeta.mainCategory, topicType: output.topicMeta.topicType, tags: output.topicMeta.tags || [], activeGenerationRunId: generationRunId, activeCardGroupId: cardGroupId, "contentStatus.hasShortCard": true, "contentStatus.hasMediumCard": true, "contentStatus.hasLongCard": true, "contentStatus.reviewStatus": "cards_generated", status: "ready", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    batch.set(runRef, { type: "openai_swipe_cards_generation_split", topicId, wikidataId, generationRunId, cardGroupId, status: "success", cardsCreated: 6, cardIds, modelShortMedium: OPENAI_MODEL, modelLong: OPENAI_MODEL_LONG, sourceAvailability, warnings, errorMessage: null, sourcePackHash, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await batch.commit();
    return { success: true, topicId, cardsCreated: 6, cardIds, topicMeta: output.topicMeta, warnings, sourceAvailability, generationRunId };
  } catch (error) {
    const message = error instanceof HttpsError ? error.message : safeString(error?.message || "Unbekannter Fehler");
    const details = removeUndefinedDeep(error?.details || {});
    try { await db.collection("generationRuns").add({ type: "openai_swipe_cards_generation_split", topicId, wikidataId, status: "error", cardsCreated: cardIds.length || 0, cardIds, modelShortMedium: OPENAI_MODEL, modelLong: OPENAI_MODEL_LONG, sourceAvailability, warnings, errorMessage: message, errorCode: error?.code || null, errorDetails: details, outputKeys: debugDetails.outputKeys || details.outputKeys || null, outputPreview: preview(debugDetails.outputPreview || details.outputPreview || ""), createdAt: admin.firestore.FieldValue.serverTimestamp() }); } catch (_) {}
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", message, { topicId, wikidataId, sourceAvailability, warnings });
  }
});


exports.publishCardsForTopic = onCall({ region: "europe-west1" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Bitte zuerst einloggen.");
  if (request.auth?.token?.email !== ADMIN_EMAIL) throw new HttpsError("permission-denied", "Nur Admins dürfen veröffentlichen.");
  const topicId = safeString(request.data?.topicId).trim();
  if (!topicId) throw new HttpsError("invalid-argument", "topicId muss gesetzt sein.");
  const topicRef = db.collection("topics").doc(topicId);
  const topicSnap = await topicRef.get();
  const activeGenerationRunId = safeString(topicSnap.data()?.activeGenerationRunId).trim();
  const snap = activeGenerationRunId
    ? await db.collection("swipeCards").where("topicId", "==", topicId).where("generationRunId", "==", activeGenerationRunId).where("status", "==", "draft").get()
    : await db.collection("swipeCards").where("topicId", "==", topicId).where("status", "==", "draft").get();
  const batch = db.batch();
  let updatedCards = 0;
  const validDrafts = [];
  snap.forEach((d) => {
    const data = d.data() || {};
    if (["de_short","de_medium","de_long","en_short","en_medium","en_long"].includes(`${safeString(data.language)}_${safeString(data.length)}`)) {
      validDrafts.push(d);
    }
  });
  if (validDrafts.length !== 6) throw new HttpsError("failed-precondition", `Es sind nicht genau 6 Draft-Cards für die neueste Generation vorhanden (gefunden: ${validDrafts.length}).`);
  validDrafts.forEach((d) => { batch.update(d.ref, { status: "published", reviewStatus: "approved", publishedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }); updatedCards += 1; });
  batch.set(topicRef, { status: "ready", "contentStatus.reviewStatus": "approved", "contentStatus.cardsPublished": 6, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
  return { success: true, topicId, updatedCards };
});
