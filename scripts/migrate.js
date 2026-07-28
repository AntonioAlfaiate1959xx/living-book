// migrate.js — One-time migration from the legacy format into the
// Living Book v2 "Claim + Source + Edition" schema.
//
// Reads:
//   questions/questions.json   (all 100 questions, chapter groupings)
//   answers/qNNN.json          (existing essay answers + sources)
//
// Writes:
//   data/question-registry.json   (registry of every question)
//   data/claims/qNNN.json         (one claim file per answered question)
//   editions/ledger.json          (edition 1 = initial migration) if absent
//
// This script is idempotent: re-running it regenerates the registry and
// claim files from the legacy data without duplicating ledger entries.

const fs = require("fs");
const path = require("path");
const {
  PATHS,
  readJSON,
  writeJSON,
  today,
  nowISO,
  classifySource,
  summarise,
} = require("./lib.js");

function migrate() {
  const questions = readJSON(PATHS.legacyQuestions, []);
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("No legacy questions found at " + PATHS.legacyQuestions);
  }

  const EDITION = 1;
  const registry = [];
  let claimFilesWritten = 0;
  const answeredIds = [];

  // Reading order: chapter, then position (matches the site build).
  const ordered = [...questions].sort(
    (a, b) => a.chapter - b.chapter || a.position - b.position
  );

  for (const q of ordered) {
    const chapterLabel = `Chapter ${q.chapter}: ${q.chapterTitle}`;

    // ── Registry entry (every question, answered or not) ────────────
    registry.push({
      id: q.id,
      status: "active",
      chapter: chapterLabel,
      chapter_number: q.chapter,
      position: q.position,
      question: q.question,
      rationale: "Migrated from legacy questions.json (initial 100-question set).",
      added_in_edition: EDITION,
      deprecated_in_edition: null,
      superseded_by: null,
    });

    // ── Claim file (only for questions that already have an answer) ──
    const answerFile = path.join(PATHS.legacyAnswersDir, `${q.id}.json`);
    const legacy = readJSON(answerFile, null);
    if (!legacy) continue;

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

    // Each legacy essay answer becomes a single "established" claim that
    // carries the full text and all of its cited sources. Future edits can
    // split this into finer-grained claims as knowledge evolves.
    const claim = {
      claim_id: `${q.id}-c01`,
      text: legacy.answer || "",
      reliability: "established",
      sources,
      perspectives: [],
      last_verified: legacy.lastChecked || legacy.lastUpdated || today(),
      added_edition: EDITION,
    };

    const claimFile = {
      question_id: q.id,
      question_text: legacy.question || q.question,
      current_edition: EDITION,
      claims: [claim],
      answer_summary: summarise(legacy.answer || ""),
      disputed_aspects: [],
      // Preserve legacy provenance so nothing is lost in the migration.
      legacy: {
        lastUpdated: legacy.lastUpdated || null,
        lastChecked: legacy.lastChecked || null,
        history: legacy.history || [],
      },
    };

    writeJSON(path.join(PATHS.claimsDir, `${q.id}.json`), claimFile);
    claimFilesWritten++;
    answeredIds.push(q.id);
  }

  // ── Write the registry ────────────────────────────────────────────
  writeJSON(PATHS.registry, {
    schema_version: 2,
    generated_at: nowISO(),
    current_edition: EDITION,
    total_questions: registry.length,
    questions: registry,
  });

  // ── Seed the edition ledger (only if it does not already exist) ────
  let ledger = readJSON(PATHS.ledger, null);
  if (!ledger) {
    ledger = {
      editions: [
        {
          edition_number: EDITION,
          created_at: nowISO(),
          description:
            "Initial migration from legacy format (questions.json + answers/).",
          questions_updated: [],
          questions_added: answeredIds,
          questions_deprecated: [],
          author: "migration-script",
        },
      ],
    };
    writeJSON(PATHS.ledger, ledger);
  }

  return {
    registryEntries: registry.length,
    claimFilesWritten,
    answeredIds,
  };
}

// Run when invoked directly; export for tests.
if (require.main === module) {
  const result = migrate();
  console.log("Migration complete.");
  console.log(`  Registry entries : ${result.registryEntries}`);
  console.log(`  Claim files      : ${result.claimFilesWritten}`);
  console.log(`  Registry         : ${path.relative(PATHS.root, PATHS.registry)}`);
  console.log(`  Claims dir       : ${path.relative(PATHS.root, PATHS.claimsDir)}`);
  console.log(`  Ledger           : ${path.relative(PATHS.root, PATHS.ledger)}`);
}

module.exports = { migrate };
