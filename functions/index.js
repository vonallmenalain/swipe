const crypto = require("node:crypto");
const admin = require("firebase-admin");
const OpenAI = require("openai");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

admin.initializeApp();
const db = admin.firestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const ADMIN_EMAIL = "alain.sc2@gmail.com";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const API_USER_AGENT = "SwipeKnowledgePrototype/0.1 (admin-local; alain.sc2@gmail.com)";
const FULL_EXTRACT_LIMIT = 60000;

const ALLOWED_MAIN_CATEGORIES = ["geschichte","wissenschaft","geografie","politik","gesellschaft","religion","philosophie","technik","wirtschaft","kultur","sport","biografie","natur","medizin","mythologie","allgemeinwissen"];
const ALLOWED_TOPIC_TYPES = ["person","historical_event","historical_period","place","country","organization","concept","scientific_concept","religion","ideology","technology","invention","conflict","treaty","natural_object","cultural_work","sport_event","other"];
const ALLOWED_DIFFICULTIES = ["beginner", "intermediate", "advanced"];
const REQUIRED_CARD_KEYS = ["de_short", "de_medium", "de_long", "en_short", "en_medium", "en_long"];

const swipeCardsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topicMeta", "cards"],
  properties: {
    topicMeta: {
      type: "object",
      additionalProperties: false,
      required: ["wikidataId", "mainCategory", "topicType", "tags", "difficulty", "suggestedRelatedTopics", "factualLimitations", "qualityNotes"],
      properties: {
        wikidataId: { type: "string" },
        mainCategory: { type: "string", enum: ALLOWED_MAIN_CATEGORIES },
        topicType: { type: "string", enum: ALLOWED_TOPIC_TYPES },
        tags: { type: "array", items: { type: "string" } },
        difficulty: { type: "string", enum: ALLOWED_DIFFICULTIES },
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
    },
    cards: {
      type: "array",
      minItems: 6,
      maxItems: 6,
      items: {
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
      },
    },
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

function buildOpenAIPrompt(sourcePack) { return `Du bist ein redaktioneller Wissensassistent für eine Swipe-Lernapp.\nAbsolute Regeln: Verwende ausschliesslich SOURCE PACK Informationen; erfinde keine Fakten; keine externen Quellen; keine anderen Wikipedia-Artikel; fehlende Infos weglassen; DE auf Deutsch, EN auf Englisch; übersetzen nur aus SOURCE PACK; medium/long bevorzugt Full Extract; neu formulieren; nur JSON gemäss Schema.\nLängen: short 50-120 Wörter, medium 400-900, long 1800-3000 wenn Material reicht, sonst needsMoreSourceMaterial=true.\nmainCategory/topicType dürfen nicht unknown sein.\nSOURCE PACK:\n${JSON.stringify(sourcePack)}`; }
function validateAIOutput(output) {
  if (!output || typeof output !== "object") throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: Kein Objekt.");
  if (!output.topicMeta || typeof output.topicMeta !== "object") throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: topicMeta fehlt.");
  if (!Array.isArray(output.cards)) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: cards fehlt oder ist kein Array.");
  if (output.cards.length !== 6) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: Es müssen genau 6 Cards sein.");

  if (!ALLOWED_MAIN_CATEGORIES.includes(output.topicMeta.mainCategory)) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: mainCategory ungültig.");
  if (!ALLOWED_TOPIC_TYPES.includes(output.topicMeta.topicType)) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: topicType ungültig.");
  if (!ALLOWED_DIFFICULTIES.includes(output.topicMeta.difficulty)) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: difficulty ungültig.");
  if (!Array.isArray(output.topicMeta.tags)) throw new HttpsError("failed-precondition", "Ungültige KI-Antwort: tags muss ein Array sein.");

  const seen = new Set();
  for (const card of output.cards) {
    const key = `${safeString(card?.language).trim()}_${safeString(card?.length).trim()}`;
    if (!REQUIRED_CARD_KEYS.includes(key)) {
      throw new HttpsError("failed-precondition", `Ungültige Karten-Kombination: ${key}`);
    }
    if (seen.has(key)) {
      throw new HttpsError("failed-precondition", `Karten-Kombination doppelt: ${key}`);
    }
    seen.add(key);
    if (!safeString(card?.title).trim()) throw new HttpsError("failed-precondition", `Leerer title in ${key}.`);
    if (!safeString(card?.hook).trim()) throw new HttpsError("failed-precondition", `Leerer hook in ${key}.`);
    if (!safeString(card?.body).trim()) throw new HttpsError("failed-precondition", `Leerer body in ${key}.`);
    if (!Array.isArray(card?.sourceBasis) || !card.sourceBasis.length) throw new HttpsError("failed-precondition", `sourceBasis fehlt in ${key}.`);
    if (!Array.isArray(card?.sourceIds)) throw new HttpsError("failed-precondition", `sourceIds fehlt in ${key}.`);
  }
  for (const requiredKey of REQUIRED_CARD_KEYS) {
    if (!seen.has(requiredKey)) throw new HttpsError("failed-precondition", `Fehlende Karten-Kombination: ${requiredKey}`);
  }
}
function calculateReadingStats(text) { const wordCount = safeString(text).trim().split(/\s+/).filter(Boolean).length; return { wordCount, readingTimeSec: Math.max(5, Math.ceil((wordCount / 200) * 60)) }; }
function buildAvailableSourceIds(sp) { const ids = [sp.sources.wikidata.id]; if (sp.sources.wikipediaDe.available) ids.push(sp.sources.wikipediaDe.id); if (sp.sources.wikipediaEn.available) ids.push(sp.sources.wikipediaEn.id); return ids; }
function buildAvailableSources(sp) { const out = [{ type: "wikidata", title: safeString(sp.topic?.title?.de || sp.topic?.title?.en), url: sp.sources.wikidata.url, license: "CC0", publisher: "Wikidata" }]; if (sp.sources.wikipediaDe.available) out.push({ type: "wikipedia", language: "de", title: sp.sources.wikipediaDe.summaryTitle || safeString(sp.topic?.title?.de), url: sp.sources.wikipediaDe.url, license: "CC BY-SA 4.0", publisher: "Wikipedia" }); if (sp.sources.wikipediaEn.available) out.push({ type: "wikipedia", language: "en", title: sp.sources.wikipediaEn.summaryTitle || safeString(sp.topic?.title?.en), url: sp.sources.wikipediaEn.url, license: "CC BY-SA 4.0", publisher: "Wikipedia" }); return out; }

exports.generateSwipeCardsForTopic = onCall({ region: "europe-west1", timeoutSeconds: 300, memory: "1GiB", maxInstances: 2, concurrency: 1, secrets: [OPENAI_API_KEY] }, async (request) => {
  const warnings = []; const cardIds = []; let topicId = ""; let wikidataId = ""; let sourceAvailability = null;
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
    let response;
    try {
      response = await client.responses.create({
        model: OPENAI_MODEL,
        input: [
          {
            role: "system",
            content: "Du bist ein redaktioneller Wissensassistent für eine Swipe-Lernapp. Verwende ausschliesslich Informationen aus dem SOURCE PACK. Erfinde keine Fakten. Gib ausschliesslich gültiges JSON gemäss Schema zurück.",
          },
          {
            role: "user",
            content: buildOpenAIPrompt(sourcePack),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "swipe_cards_generation",
            schema: swipeCardsSchema,
            strict: true,
          },
        },
      });
    } catch (e) {
      throw new HttpsError("failed-precondition", `OpenAI-Aufruf fehlgeschlagen: ${e.message}`, { model: OPENAI_MODEL, sourceAvailability });
    }

    try {
      output = JSON.parse(response.output_text);
    } catch (parseError) {
      throw new HttpsError("failed-precondition", "OpenAI hat keine gültige JSON-Antwort geliefert.", {
        originalError: parseError.message,
        outputPreview: String(response.output_text || "").slice(0, 1000),
      });
    }

    validateAIOutput(output);

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
        tags: Array.isArray(output?.topicMeta?.tags) ? output.topicMeta.tags : [], mainCategory: output.topicMeta.mainCategory, topicType: output.topicMeta.topicType, difficulty: output.topicMeta.difficulty,
        generation: { method: "openai_cloud_function", aiGenerated: true, sourceRestricted: true, noNewFactsInstruction: true, sourcePackHash, model: OPENAI_MODEL, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
        status: "draft", reviewStatus: "needs_review", qualityScore: 0, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }));
    }

    batch.set(db.collection("sourceDocs").doc(`wikidata_${wikidataId}`), { sourceType: "wikidata", wikidataId, title: safeString(topic?.title?.de || topic?.title?.en), url: `https://www.wikidata.org/wiki/${wikidataId}`, license: "CC0", publisher: "Wikidata", fetchedAt: admin.firestore.FieldValue.serverTimestamp(), trustLevel: "high" }, { merge: true });
    if (sourcePack.sources.wikipediaDe.available) batch.set(db.collection("sourceDocs").doc(`wikipedia_de_${wikidataId}`), { sourceType: "wikipedia", wikidataId, title: safeString(sourcePack.sources.wikipediaDe.summaryTitle || topic?.title?.de), url: safeString(sourcePack.sources.wikipediaDe.url), license: "CC BY-SA 4.0", publisher: "Wikipedia", language: "de", fetchedAt: admin.firestore.FieldValue.serverTimestamp(), trustLevel: "medium-high" }, { merge: true });
    if (sourcePack.sources.wikipediaEn.available) batch.set(db.collection("sourceDocs").doc(`wikipedia_en_${wikidataId}`), { sourceType: "wikipedia", wikidataId, title: safeString(sourcePack.sources.wikipediaEn.summaryTitle || topic?.title?.en), url: safeString(sourcePack.sources.wikipediaEn.url), license: "CC BY-SA 4.0", publisher: "Wikipedia", language: "en", fetchedAt: admin.firestore.FieldValue.serverTimestamp(), trustLevel: "medium-high" }, { merge: true });

    batch.set(topicRef, { mainCategory: output.topicMeta.mainCategory, topicType: output.topicMeta.topicType, tags: output.topicMeta.tags || [], activeGenerationRunId: generationRunId, activeCardGroupId: cardGroupId, "contentStatus.hasShortCard": true, "contentStatus.hasMediumCard": true, "contentStatus.hasLongCard": true, "contentStatus.reviewStatus": "cards_generated", status: "ready", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    batch.set(runRef, { type: "openai_swipe_cards_generation", topicId, wikidataId, generationRunId, cardGroupId, status: "success", cardsCreated: 6, cardIds, model: OPENAI_MODEL, sourceAvailability, warnings, errorMessage: null, sourcePackHash, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await batch.commit();
    return { success: true, topicId, cardsCreated: 6, cardIds, topicMeta: output.topicMeta, warnings, sourceAvailability, generationRunId };
  } catch (error) {
    const message = error instanceof HttpsError ? error.message : safeString(error?.message || "Unbekannter Fehler");
    try { await db.collection("generationRuns").add({ type: "openai_swipe_cards_generation", topicId, wikidataId, status: "error", cardsCreated: cardIds.length || 0, cardIds, model: OPENAI_MODEL, sourceAvailability, warnings, errorMessage: message, createdAt: admin.firestore.FieldValue.serverTimestamp() }); } catch (_) {}
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", message, { topicId, wikidataId, sourceAvailability, warnings });
  }
});


exports.publishCardsForTopic = onCall({ region: "europe-west1" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Bitte zuerst einloggen.");
  if (request.auth?.token?.email !== ADMIN_EMAIL) throw new HttpsError("permission-denied", "Nur Admins dürfen veröffentlichen.");
  const topicId = safeString(request.data?.topicId).trim();
  if (!topicId) throw new HttpsError("invalid-argument", "topicId muss gesetzt sein.");
  const snap = await db.collection("swipeCards").where("topicId", "==", topicId).get();
  const batch = db.batch();
  let updatedCards = 0;
  snap.forEach((d) => {
    const data = d.data() || {};
    if (["de_short","de_medium","de_long","en_short","en_medium","en_long"].includes(`${safeString(data.language)}_${safeString(data.length)}`)) {
      batch.update(d.ref, { status: "published", reviewStatus: "approved", publishedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      updatedCards += 1;
    }
  });
  batch.set(db.collection("topics").doc(topicId), { status: "ready", "contentStatus.reviewStatus": "approved", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
  return { success: true, topicId, updatedCards };
});
