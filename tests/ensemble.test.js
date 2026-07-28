// ensemble.test.js — Full pipeline in mock mode. No network, no disk writes.

const test = require("node:test");
const assert = require("node:assert");
const { runEnsemble } = require("../scripts/agents/ensemble.js");
const { orchestrate } = require("../scripts/orchestrate.js");
const { PATHS, readJSON, validateClaimFile } = require("../scripts/lib.js");

// Use a question the migration is known to have registered.
const SAMPLE_ID = "q001";

function registryStub() {
  return {
    questions: [
      { id: SAMPLE_ID, status: "active", question: "What is AI in education?" },
    ],
  };
}

test("runEnsemble (mock) returns a schema-valid claim object", async () => {
  const res = await runEnsemble({
    questionId: SAMPLE_ID,
    mock: true,
    edition: 3,
    registryData: registryStub(),
  });
  const errors = validateClaimFile(res.claimFile, "ensemble");
  assert.deepStrictEqual(errors, [], "claim file must be valid: " + errors.join("; "));
  assert.strictEqual(res.claimFile.current_edition, 3);
  assert.ok(res.claimFile.claims.length >= 1);
  assert.ok(res.stages.research.findings.length >= 2);
  assert.ok(Array.isArray(res.stages.verification.verifiedFindings));
});

test("runEnsemble rejects an invalid question id", async () => {
  await assert.rejects(
    () => runEnsemble({ questionId: "bad", mock: true, registryData: registryStub() }),
    /Invalid questionId/
  );
});

test("runEnsemble uses injected apiCall(s) and makes no network call", async () => {
  const calls = [];
  const apiCall = {
    research: async (qtext, qid) => {
      calls.push("research");
      return [
        { text: "Injected research.", source: { url: "https://arxiv.org/abs/inj", title: "R" } },
      ];
    },
    verification: async (finding) => {
      calls.push("verification");
      return { reliability: "established" };
    },
    synthesis: async () => {
      calls.push("synthesis");
      return "Injected synthesis summary.";
    },
  };
  const res = await runEnsemble({
    questionId: SAMPLE_ID,
    mock: false, // live path, but every stage is injected → no real network
    edition: 1,
    apiCall,
    registryData: registryStub(),
  });
  assert.ok(calls.includes("research"), "research caller used");
  assert.ok(calls.includes("synthesis"), "synthesis caller used");
  assert.match(res.claimFile.answer_summary, /Injected synthesis/);
});

test("orchestrate --ensemble (mock) appends claims without touching disk", async () => {
  const before = readJSON(PATHS.ledger, { editions: [] });
  const maxBefore = before.editions.reduce((m, e) => Math.max(m, e.edition_number), 0);

  const res = await orchestrate(SAMPLE_ID, {
    mock: true,
    ensemble: true,
    persist: false,
  });

  assert.strictEqual(res.edition, maxBefore + 1);
  assert.ok(res.claims.length >= 1);
  const errors = validateClaimFile(res.claimFile, "merged");
  assert.deepStrictEqual(errors, [], "merged claim file must stay valid");

  // persist:false must leave the on-disk ledger unchanged.
  const after = readJSON(PATHS.ledger, { editions: [] });
  const maxAfter = after.editions.reduce((m, e) => Math.max(m, e.edition_number), 0);
  assert.strictEqual(maxAfter, maxBefore, "ledger on disk must be unchanged");
});
