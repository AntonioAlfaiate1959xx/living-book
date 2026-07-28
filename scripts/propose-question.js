// propose-question.js — Adaptive question registry CLI.
//
// Proposes a NEW question for the Living Book. The proposal is appended to
// data/question-registry.json with status "proposed". It is deliberately
// NOT added to data/claims/ — a proposed question carries no answer until a
// human approves it and the orchestrator generates its first claim.
//
// Usage:
//   node scripts/propose-question.js \
//     --question "How should universities assess AI-assisted work?" \
//     --chapter "Chapter 11: Measurement and Evaluation" \
//     --rationale "New assessment guidance emerged in 2026."
//
// Exit codes: 0 = proposed, 1 = validation error / duplicate.

const {
  PATHS,
  readJSON,
  writeJSON,
  nowISO,
  padId,
  validateRegistryEntry,
} = require("./lib.js");

// ── Argument parsing (tiny, dependency-free) ────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true; // boolean flag
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

// Normalise a question for duplicate comparison.
function normalise(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Compute the next question id (qNNN) from the existing registry.
function nextQuestionId(questions) {
  let max = 0;
  for (const q of questions) {
    const m = /^q(\d+)$/.exec(q.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return padId(max + 1);
}

// Core logic, exported for tests. Returns { ok, entry?, error? }.
// `registryData` may be passed in for testing; otherwise it is read from disk.
function proposeQuestion(
  { question, chapter, rationale },
  { registryData, persist = true } = {}
) {
  if (!question || typeof question !== "string" || !question.trim()) {
    return { ok: false, error: "A non-empty --question is required." };
  }
  if (!chapter || typeof chapter !== "string" || !chapter.trim()) {
    return { ok: false, error: "A non-empty --chapter is required." };
  }

  const data =
    registryData ||
    readJSON(PATHS.registry, null) || {
      schema_version: 2,
      generated_at: nowISO(),
      current_edition: 1,
      total_questions: 0,
      questions: [],
    };

  if (!Array.isArray(data.questions)) data.questions = [];

  // Duplicate detection: reject if an existing question matches exactly
  // (after normalisation), regardless of status.
  const target = normalise(question);
  const dup = data.questions.find((q) => normalise(q.question) === target);
  if (dup) {
    return {
      ok: false,
      error: `Duplicate of existing question ${dup.id} (status: ${dup.status}).`,
    };
  }

  const entry = {
    id: nextQuestionId(data.questions),
    status: "proposed",
    chapter: chapter.trim(),
    chapter_number: null,
    position: null,
    question: question.trim(),
    rationale: (rationale && String(rationale).trim()) || "Proposed via CLI.",
    added_in_edition: null, // set when approved & first answered
    deprecated_in_edition: null,
    superseded_by: null,
    proposed_at: nowISO(),
  };

  const schemaErrors = validateRegistryEntry(entry, entry.id);
  if (schemaErrors.length) {
    return { ok: false, error: "Schema error: " + schemaErrors.join("; ") };
  }

  data.questions.push(entry);
  data.total_questions = data.questions.length;

  if (persist) writeJSON(PATHS.registry, data);

  return { ok: true, entry, registryData: data };
}

// ── CLI entry point ─────────────────────────────────────────────────
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const result = proposeQuestion({
    question: args.question,
    chapter: args.chapter,
    rationale: args.rationale,
  });

  if (!result.ok) {
    console.error("✗ Proposal rejected: " + result.error);
    process.exit(1);
  }

  const e = result.entry;
  console.log("✓ Question proposed and added to the registry.");
  console.log(`  id       : ${e.id}`);
  console.log(`  status   : ${e.status}`);
  console.log(`  chapter  : ${e.chapter}`);
  console.log(`  question : ${e.question}`);
  console.log(`  rationale: ${e.rationale}`);
  console.log(
    "\nNext step: review this proposal, then run the orchestrator to " +
      "generate its first answer once approved."
  );
}

module.exports = { proposeQuestion, parseArgs, normalise, nextQuestionId };
