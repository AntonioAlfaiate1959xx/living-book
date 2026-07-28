// propose-question.test.js — Unit tests for the proposal logic.
// Runs entirely in-memory (persist: false) so it never mutates real files.

const test = require("node:test");
const assert = require("node:assert");
const {
  proposeQuestion,
  normalise,
  nextQuestionId,
  parseArgs,
} = require("../scripts/propose-question.js");

function freshRegistry() {
  return {
    schema_version: 2,
    generated_at: "2026-07-28T00:00:00Z",
    current_edition: 1,
    total_questions: 2,
    questions: [
      {
        id: "q001",
        status: "active",
        chapter: "Chapter 1: Foundations",
        question: "What is the purpose of education?",
        rationale: "seed",
        added_in_edition: 1,
        deprecated_in_edition: null,
        superseded_by: null,
      },
      {
        id: "q002",
        status: "active",
        chapter: "Chapter 1: Foundations",
        question: "What does it mean to learn?",
        rationale: "seed",
        added_in_edition: 1,
        deprecated_in_edition: null,
        superseded_by: null,
      },
    ],
  };
}

test("parseArgs parses --key value and boolean flags", () => {
  const args = parseArgs(["--question", "Hello?", "--mock"]);
  assert.strictEqual(args.question, "Hello?");
  assert.strictEqual(args.mock, true);
});

test("normalise strips punctuation and case", () => {
  assert.strictEqual(
    normalise("What IS  Learning??"),
    normalise("what is learning")
  );
});

test("nextQuestionId increments the max id", () => {
  assert.strictEqual(
    nextQuestionId([{ id: "q001" }, { id: "q009" }, { id: "q003" }]),
    "q010"
  );
  assert.strictEqual(nextQuestionId([]), "q001");
});

test("a valid new question is accepted and gets status 'proposed'", () => {
  const reg = freshRegistry();
  const res = proposeQuestion(
    {
      question: "How should schools assess AI-assisted work?",
      chapter: "Chapter 11: Measurement",
      rationale: "New guidance in 2026.",
    },
    { registryData: reg, persist: false }
  );
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.entry.status, "proposed");
  assert.strictEqual(res.entry.id, "q003");
  assert.strictEqual(res.entry.added_in_edition, null);
  assert.strictEqual(reg.questions.length, 3);
  assert.strictEqual(reg.total_questions, 3);
});

test("an exact duplicate question is rejected", () => {
  const reg = freshRegistry();
  const res = proposeQuestion(
    {
      question: "  what is the PURPOSE of education??  ",
      chapter: "Chapter 1: Foundations",
    },
    { registryData: reg, persist: false }
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Duplicate/);
  assert.strictEqual(reg.questions.length, 2, "registry must be unchanged");
});

test("missing question is rejected", () => {
  const res = proposeQuestion(
    { question: "", chapter: "Chapter 1" },
    { registryData: freshRegistry(), persist: false }
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /question/);
});

test("missing chapter is rejected", () => {
  const res = proposeQuestion(
    { question: "A brand new question?", chapter: "" },
    { registryData: freshRegistry(), persist: false }
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /chapter/);
});
