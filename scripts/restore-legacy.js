// restore-legacy.js — Data-restoration script.
//
// The v2 data store (data/claims/qNNN.json) was overwritten with mock
// "[MOCK REFRESH]" content at edition 112. This script restores REAL prose
// from the legacy answers/ store (matching each question by id) using the
// same v2 schema that migrate.js produces, and writes an honest
// "Answer pending" placeholder for questions that have no legacy answer.
//
// It NEVER writes mock text. Run: node scripts/restore-legacy.js

const fs = require("fs");
const path = require("path");
const {
  PATHS,
  readJSON,
  writeJSON,
  today,
  classifySource,
  summarise,
} = require("./lib.js");

// The restoration edition number. Editions 112-212 in the ledger are all
// mock-corruption entries (author "orchestrator(mock)", "[MOCK REFRESH]"
// text) created when the mock orchestrator overwrote the store. The ledger
// is being truncated back to its last-good state (edition 111), so this
// restoration becomes the next real edition after 111.
const RESTORE_EDITION = 112;

const PENDING_TEXT =
  "Answer pending — no researched answer exists yet for this question. " +
  "It will be populated by a future live research run.";

function restore() {
  const registry = readJSON(PATHS.registry, null);
  if (!registry) throw new Error("Registry not found at " + PATHS.registry);

  let restored = 0;
  let pending = 0;
  const restoredIds = [];
  const pendingIds = [];

  for (const q of registry.questions) {
    const qid = q.id;
    const legacyFile = path.join(PATHS.legacyAnswersDir, `${qid}.json`);
    const legacy = readJSON(legacyFile, null);
    const existing = readJSON(path.join(PATHS.claimsDir, `${qid}.json`), null);
    const questionText =
      (legacy && legacy.question) || (existing && existing.question_text) || q.question;

    let claimFile;

    if (legacy && typeof legacy.answer === "string" && legacy.answer.trim()) {
      // ── Restore real content from the legacy answer ──────────────
      const retrieved = legacy.lastChecked || legacy.lastUpdated || today();
      const sources = (legacy.sources || []).map((s) => {
        const { type, credibility } = classifySource(s.url);
        return {
          url: s.url,
          title: s.title || s.url,
          type,
          retrieved,
          credibility,
        };
      });

      const claim = {
        claim_id: `${qid}-c01`,
        text: legacy.answer,
        reliability: "established",
        sources,
        perspectives: [],
        last_verified: legacy.lastChecked || legacy.lastUpdated || today(),
        added_edition: 1, // originally introduced at the initial migration
      };

      claimFile = {
        question_id: qid,
        question_text: questionText,
        current_edition: RESTORE_EDITION,
        claims: [claim],
        answer_summary: summarise(legacy.answer),
        disputed_aspects: [],
        legacy: {
          lastUpdated: legacy.lastUpdated || null,
          lastChecked: legacy.lastChecked || null,
          history: legacy.history || [],
        },
      };
      restored++;
      restoredIds.push(qid);
    } else {
      // ── Honest placeholder for questions with no legacy answer ────
      claimFile = {
        question_id: qid,
        question_text: questionText,
        current_edition: RESTORE_EDITION,
        claims: [],
        answer_summary: PENDING_TEXT,
        disputed_aspects: [],
        legacy: {
          lastUpdated: (existing && existing.legacy && existing.legacy.lastUpdated) || null,
          lastChecked: (existing && existing.legacy && existing.legacy.lastChecked) || null,
          history: (existing && existing.legacy && existing.legacy.history) || [],
        },
      };
      pending++;
      pendingIds.push(qid);
    }

    writeJSON(path.join(PATHS.claimsDir, `${qid}.json`), claimFile);
  }

  return { restored, pending, restoredIds, pendingIds };
}

if (require.main === module) {
  const r = restore();
  console.log("Restoration complete.");
  console.log(`  Restored from legacy : ${r.restored}`);
  console.log(`  Pending placeholders : ${r.pending}`);
  console.log(`  Pending ids          : ${r.pendingIds.join(", ")}`);
}

module.exports = { restore, RESTORE_EDITION, PENDING_TEXT };
