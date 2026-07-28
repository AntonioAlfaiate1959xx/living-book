// orchestrate.test.js — Tests the orchestrator in mock mode only.
// No network and no real API key are ever used. persist:false keeps the
// real data/ and editions/ files untouched.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { orchestrate, mockAnswer } = require("../scripts/orchestrate.js");
const { PATHS, readJSON } = require("../scripts/lib.js");

// Pick a question id that the migration is known to have produced.
const SAMPLE_ID = "q001";

test("mockAnswer is deterministic and references the question", () => {
  const a = mockAnswer("q001", "What is the purpose of education?");
  assert.match(a.text, /MOCK REFRESH/);
  assert.match(a.text, /q001/);
  assert.ok(a.sources.length >= 1);
  assert.strictEqual(a.model, "mock");
});

test("orchestrate rejects an invalid question id", async () => {
  await assert.rejects(
    () => orchestrate("not-an-id", { mock: true, persist: false }),
    /Invalid --question-id/
  );
});

test("orchestrate rejects an unknown question id", async () => {
  await assert.rejects(
    () => orchestrate("q999", { mock: true, persist: false }),
    /not in the registry/
  );
});

test("orchestrate (mock) produces a new claim and bumps the edition", async () => {
  const before = readJSON(PATHS.ledger, { editions: [] });
  const maxBefore = before.editions.reduce(
    (m, e) => Math.max(m, e.edition_number),
    0
  );

  const res = await orchestrate(SAMPLE_ID, { mock: true, persist: false });

  assert.strictEqual(res.questionId, SAMPLE_ID);
  assert.strictEqual(res.edition, maxBefore + 1, "edition must increment");
  assert.match(res.claim.claim_id, /^q001-c\d{2}$/);
  assert.match(res.claim.text, /MOCK REFRESH/);
  assert.strictEqual(res.claim.added_edition, maxBefore + 1);
  assert.ok(res.claim.sources.length >= 1);
  // The in-memory claim file must have the new claim appended.
  assert.strictEqual(
    res.claimFile.current_edition,
    maxBefore + 1,
    "claim file edition must match"
  );

  // persist:false must NOT have written anything to disk.
  const after = readJSON(PATHS.ledger, { editions: [] });
  const maxAfter = after.editions.reduce(
    (m, e) => Math.max(m, e.edition_number),
    0
  );
  assert.strictEqual(maxAfter, maxBefore, "ledger on disk must be unchanged");
});

test("orchestrate (mock) accepts an injected provider", async () => {
  let called = false;
  const provider = async (qid, qtext) => {
    called = true;
    assert.strictEqual(qid, SAMPLE_ID);
    assert.ok(typeof qtext === "string" && qtext.length > 0);
    return {
      text: "Injected provider answer for testing.",
      sources: [{ title: "T", url: "https://example.org/x" }],
      model: "test-provider",
    };
  };
  const res = await orchestrate(SAMPLE_ID, { provider, persist: false });
  assert.ok(called, "provider must be invoked");
  assert.match(res.claim.text, /Injected provider answer/);
  assert.strictEqual(res.claim.sources[0].url, "https://example.org/x");
});
