const crypto = require("node:crypto");
const admin = require("firebase-admin");
const OpenAI = require("openai");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

admin.initializeApp();
const db = admin.firestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const OPENAI_MODEL = "gpt-5.2";
const ADMIN_EMAIL = "alain.sc2@gmail.com";
const API_USER_AGENT = "SwipeKnowledgePrototype/0.1 (admin-local; alain.sc2@gmail.com)";
const FULL_EXTRACT_LIMIT = 60000;

const ALLOWED_MAIN_CATEGORIES = ["geschichte","wissenschaft","geografie","politik","gesellschaft","religion","philosophie","technik","wirtschaft","kultur","sport","biografie","natur","medizin","mythologie","allgemeinwissen"];
const ALLOWED_TOPIC_TYPES = ["person","historical_event","historical_period","place","country","organization","concept","scientific_concept","religion","ideology","technology","invention","conflict","treaty","natural_object","cultural_work","sport_event","other"];
const ALLOWED_DIFFICULTIES = ["beginner","intermediate","advanced"];
const REQUIRED_PAIRS = ["de_short","de_medium","de_long","en_short","en_medium","en_long"];

function safeString(v){return v == null ? "" : String(v);}
function sanitize(value){
  if (Array.isArray(value)) return value.map(sanitize).filter((v) => v !== undefined);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const sv = sanitize(v);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  }
  return value === undefined ? undefined : value;
}

function truncateText(text, maxChars = FULL_EXTRACT_LIMIT) {
  const raw = safeString(text);
  const truncated = raw.length > maxChars;
  return {
    text: truncated ? raw.slice(0, maxChars) : raw,
    truncated,
    charCount: raw.length,
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "Api-User-Agent": API_USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function wikipediaTitleFromUrl(url){
  try { const u = new URL(url); const part = u.pathname.split("/wiki/")[1] || ""; return decodeURIComponent(part); } catch { return ""; }
}

async function fetchWikiData(url, lang, warnings) {
  if (!url) return { summary: null, fullExtract: "", fullExtractTruncated: false, fullExtractLoaded: false };
  const title = wikipediaTitleFromUrl(url);
  if (!title) return { summary: null, fullExtract: "", fullExtractTruncated: false, fullExtractLoaded: false };

  let summary = null;
  let fullExtract = "";
  let fullExtractLoaded = false;
  let fullExtractTruncated = false;
  try {
    summary = await fetchJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  } catch (e) {
    warnings.push(`Wikipedia ${lang} summary failed: ${e.message}`);
  }
  try {
    const data = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exintro=0&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`);
    const page = Object.values(data?.query?.pages || {})[0] || {};
    const tr = truncateText(page?.extract || "", FULL_EXTRACT_LIMIT);
    fullExtract = tr.text;
    fullExtractTruncated = tr.truncated;
    fullExtractLoaded = !!fullExtract;
  } catch (e) {
    warnings.push(`Wikipedia ${lang} full extract failed: ${e.message}`);
  }

  return { summary, fullExtract, fullExtractLoaded, fullExtractTruncated };
}

function buildPrompt(sourcePack){
  return `Du bist ein redaktioneller Wissensassistent für eine Swipe-Lernapp.\n\nAbsolute Regeln:\n- Verwende ausschliesslich Informationen aus dem SOURCE PACK.\n- Erfinde keine Fakten.\n- Füge keine externen Quellen hinzu.\n- Wenn Informationen fehlen, lasse sie weg.\n- Die deutsche Version ist Deutsch.\n- Die englische Version ist Englisch.\n- Falls eine Sprache weniger Quellenmaterial hat, darfst du übersetzen, aber nur Informationen verwenden, die im Source Pack stehen.\n- Für Medium und Long darfst du den vollständigen Wikipedia-Plaintext-Extract detailliert zusammenfassen.\n- Nicht grosse Passagen 1:1 kopieren.\n- Neu formulieren, strukturieren, verständlich erklären.\n- Alle Fakten müssen aus dem Source Pack stammen.\n- Gib ausschliesslich JSON gemäss Schema zurück.\n\nLängenvorgaben:\nshort: 50-120 Wörter\nmedium: 400-900 Wörter\nlong: ideal 1800-3000 Wörter (bei wenig Material needsMoreSourceMaterial=true)\n\nLiefer exakt 6 Cards für de/en × short/medium/long.\n\nSOURCE PACK:\n${JSON.stringify(sourcePack)}`;
}

function validateOutput(output){
  if (!output || typeof output !== "object") throw new Error("Output is not an object");
  if (!output.topicMeta) throw new Error("topicMeta missing");
  if (!Array.isArray(output.cards)) throw new Error("cards missing");
  if (output.cards.length !== 6) throw new Error("cards must have exactly 6 items");
  if (!ALLOWED_MAIN_CATEGORIES.includes(output.topicMeta.mainCategory)) throw new Error("invalid mainCategory");
  if (!ALLOWED_TOPIC_TYPES.includes(output.topicMeta.topicType)) throw new Error("invalid topicType");
  if (!ALLOWED_DIFFICULTIES.includes(output.topicMeta.difficulty)) throw new Error("invalid difficulty");

  const seen = new Set();
  for (const card of output.cards) {
    if (!["de", "en"].includes(card.language)) throw new Error("invalid card language");
    if (!["short", "medium", "long"].includes(card.length)) throw new Error("invalid card length");
    if (!safeString(card.title).trim() || !safeString(card.hook).trim() || !safeString(card.body).trim()) throw new Error("empty title/hook/body");
    const key = `${card.language}_${card.length}`;
    seen.add(key);
  }
  for (const pair of REQUIRED_PAIRS) if (!seen.has(pair)) throw new Error(`missing combination ${pair}`);
}

exports.generateSwipeCardsForTopic = onCall({
  region: "europe-west1",
  timeoutSeconds: 300,
  memory: "1GiB",
  maxInstances: 2,
  concurrency: 1,
  secrets: [OPENAI_API_KEY],
}, async (request) => {
  const warnings = [];
  const nowTs = Math.floor(Date.now() / 1000);
  const input = request.data || {};
  const topicId = safeString(input.topicId).trim();
  const saveMode = safeString(input.saveMode || "draft") || "draft";

  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  if (request.auth?.token?.email !== ADMIN_EMAIL) throw new HttpsError("permission-denied", "Admin only");
  if (!topicId) throw new HttpsError("invalid-argument", "topicId is required");

  let generationRunRef = null;
  const cardIds = [];
  try {
    const topicRef = db.collection("topics").doc(topicId);
    const topicSnap = await topicRef.get();
    if (!topicSnap.exists) throw new HttpsError("not-found", `Topic ${topicId} not found`);
    const topic = topicSnap.data() || {};

    const wikiDe = await fetchWikiData(topic?.sitelinks?.dewiki, "de", warnings);
    const wikiEn = await fetchWikiData(topic?.sitelinks?.enwiki, "en", warnings);

    const sourceAvailability = {
      wikidata: true,
      wikipediaDeSummary: !!wikiDe.summary,
      wikipediaDeFull: !!wikiDe.fullExtractLoaded,
      wikipediaEnSummary: !!wikiEn.summary,
      wikipediaEnFull: !!wikiEn.fullExtractLoaded,
    };

    const sourcePack = sanitize({
      topic: {
        wikidataId: safeString(topic.wikidataId || topicId),
        title: topic.title || {},
        description: topic.description || {},
        aliases: topic.aliases || {},
        mainCategory: safeString(topic.mainCategory),
        topicType: safeString(topic.topicType),
        tags: Array.isArray(topic.tags) ? topic.tags : [],
        sitelinks: topic.sitelinks || {},
        claimsMeta: topic.claimsMeta || {},
        claimsRaw: topic.claimsRaw ? JSON.stringify(topic.claimsRaw).slice(0, 30000) : "",
      },
      wikipedia: {
        de: {
          url: topic?.sitelinks?.dewiki || "",
          summary: wikiDe.summary?.extract || "",
          fullExtract: wikiDe.fullExtract,
          fullExtractTruncated: wikiDe.fullExtractTruncated,
        },
        en: {
          url: topic?.sitelinks?.enwiki || "",
          summary: wikiEn.summary?.extract || "",
          fullExtract: wikiEn.fullExtract,
          fullExtractTruncated: wikiEn.fullExtractTruncated,
        },
      },
    });
    const sourcePackHash = crypto.createHash("sha256").update(JSON.stringify(sourcePack)).digest("hex");

    const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["topicMeta", "cards"],
      properties: {
        topicMeta: {
          type: "object",
          required: ["wikidataId", "mainCategory", "topicType", "tags", "difficulty", "suggestedRelatedTopics", "factualLimitations", "qualityNotes"],
          properties: {
            wikidataId: { type: "string" },
            mainCategory: { type: "string", enum: ALLOWED_MAIN_CATEGORIES },
            topicType: { type: "string", enum: ALLOWED_TOPIC_TYPES },
            tags: { type: "array", items: { type: "string" } },
            difficulty: { type: "string", enum: ALLOWED_DIFFICULTIES },
            suggestedRelatedTopics: { type: "array", items: { type: "object", required: ["title", "reason"], properties: { title: { type: "string" }, reason: { type: "string" } }, additionalProperties: false } },
            factualLimitations: { type: "array", items: { type: "string" } },
            qualityNotes: { type: "string" }
          },
          additionalProperties: false,
        },
        cards: { type: "array", minItems: 6, maxItems: 6, items: { type: "object", required: ["language", "length", "cardType", "title", "hook", "body", "needsMoreSourceMaterial", "sourceBasis", "sourceLimitations"], properties: {
          language: { type: "string", enum: ["de", "en"] },
          length: { type: "string", enum: ["short", "medium", "long"] },
          cardType: { type: "string" }, title: { type: "string" }, hook: { type: "string" }, body: { type: "string" }, needsMoreSourceMaterial: { type: "boolean" }, sourceBasis: { type: "array", items: { type: "string" } }, sourceLimitations: { type: "array", items: { type: "string" } }
        }, additionalProperties: false } }
      }
    };

    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: buildPrompt(sourcePack),
      text: { format: { type: "json_schema", name: "swipe_cards", schema, strict: true } },
    });
    const output = JSON.parse(response.output_text);
    validateOutput(output);

    const sourceIds = [
      `wikidata_${topicId}`,
      sourceAvailability.wikipediaDeSummary || sourceAvailability.wikipediaDeFull ? `wikipedia_de_${topicId}` : null,
      sourceAvailability.wikipediaEnSummary || sourceAvailability.wikipediaEnFull ? `wikipedia_en_${topicId}` : null,
    ].filter(Boolean);

    for (const c of output.cards) {
      const wordCount = safeString(c.body).trim().split(/\s+/).filter(Boolean).length;
      const readingTimeSec = Math.max(5, Math.ceil((wordCount / 200) * 60));
      const cardId = `${topicId}_${c.language}_${c.length}_${c.cardType}_${nowTs}`;
      cardIds.push(cardId);
      await db.collection("swipeCards").doc(cardId).set(sanitize({
        cardId, topicId, wikidataId: topic.wikidataId || topicId, cardGroupId: `${topicId}_ai_intro`, language: c.language, length: c.length, readingTimeSec, wordCount,
        cardType: c.cardType, title: c.title, hook: c.hook, body: c.body,
        topicTitle: { de: safeString(topic?.title?.de), en: safeString(topic?.title?.en) },
        sourceIds, sources: sourceIds,
        sourceBasis: c.sourceBasis, sourceLimitations: c.sourceLimitations, needsMoreSourceMaterial: !!c.needsMoreSourceMaterial,
        tags: output.topicMeta.tags || [], mainCategory: output.topicMeta.mainCategory, topicType: output.topicMeta.topicType, difficulty: output.topicMeta.difficulty,
        generation: { method: "openai_cloud_function", aiGenerated: true, sourceRestricted: true, noNewFactsInstruction: true, sourcePackHash, model: OPENAI_MODEL, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
        status: saveMode || "draft", reviewStatus: "needs_review", qualityScore: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }));
    }

    await db.collection("sourceDocs").doc(`wikidata_${topicId}`).set({ sourceType: "wikidata", wikidataId: topic.wikidataId || topicId, fetchedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    if (topic?.sitelinks?.dewiki) await db.collection("sourceDocs").doc(`wikipedia_de_${topicId}`).set({ sourceType: "wikipedia", wikidataId: topic.wikidataId || topicId, title: wikiDe.summary?.title || safeString(topic?.title?.de), url: topic.sitelinks.dewiki, license: "CC BY-SA 4.0", publisher: "Wikipedia", language: "de", fetchedAt: admin.firestore.FieldValue.serverTimestamp(), trustLevel: "medium-high", fullExtractLoaded: wikiDe.fullExtractLoaded, fullExtractTruncated: wikiDe.fullExtractTruncated }, { merge: true });
    if (topic?.sitelinks?.enwiki) await db.collection("sourceDocs").doc(`wikipedia_en_${topicId}`).set({ sourceType: "wikipedia", wikidataId: topic.wikidataId || topicId, title: wikiEn.summary?.title || safeString(topic?.title?.en), url: topic.sitelinks.enwiki, license: "CC BY-SA 4.0", publisher: "Wikipedia", language: "en", fetchedAt: admin.firestore.FieldValue.serverTimestamp(), trustLevel: "medium-high", fullExtractLoaded: wikiEn.fullExtractLoaded, fullExtractTruncated: wikiEn.fullExtractTruncated }, { merge: true });

    await topicRef.set({
      mainCategory: output.topicMeta.mainCategory,
      topicType: output.topicMeta.topicType,
      tags: output.topicMeta.tags || [],
      contentStatus: { hasShortCard: true, hasMediumCard: true, hasLongCard: true, reviewStatus: "cards_generated" },
      status: "ready",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    generationRunRef = await db.collection("generationRuns").add({
      type: "openai_swipe_cards_generation", topicId, wikidataId: topic.wikidataId || topicId, status: "success", cardsCreated: cardIds.length, cardIds, model: OPENAI_MODEL,
      sourceAvailability, warnings, errorMessage: null, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, topicId, cardsCreated: 6, cardIds, topicMeta: output.topicMeta, warnings, sourceAvailability, generationRunId: generationRunRef.id };
  } catch (error) {
    try {
      generationRunRef = await db.collection("generationRuns").add({
        type: "openai_swipe_cards_generation", topicId, wikidataId: topicId, status: "error", cardsCreated: cardIds.length, cardIds, model: OPENAI_MODEL,
        sourceAvailability: null, warnings, errorMessage: error.message || "Unknown error", createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_e) {}
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", `Generation failed: ${error.message}`);
  }
});
