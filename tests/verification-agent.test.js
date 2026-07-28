// verification-agent.test.js — Mock-only tests. No network is ever touched.

const test = require("node:test");
const assert = require("node:assert");
const {
  verificationAgent,
  reliabilityFromCredibility,
  detectConflicts,
} = require("../scripts/agents/verification-agent.js");
const { RELIABILITY } = require("../scripts/lib.js");

test("reliabilityFromCredibility maps credibility to a valid grade", () => {
  assert.strictEqual(reliabilityFromCredibility("high"), "established");
  assert.strictEqual(reliabilityFromCredibility("medium"), "emerging");
  assert.ok(RELIABILITY.includes(reliabilityFromCredibility("low")));
});

test("verificationAgent classifies sources and assigns reliability", async () => {
  const findings = [
    { text: "Academic finding", source: { url: "https://arxiv.org/abs/1", title: "A" } },
    { text: "Blog finding", source: { url: "https://example.com/blog/x", title: "B" } },
  ];
  const res = await verificationAgent({ questionId: "q001", findings, mock: true });
  assert.strictEqual(res.verifiedFindings.length, 2);
  // Academic source → high credibility → established.
  const academic = res.verifiedFindings[0];
  assert.strictEqual(academic.source.type, "academic");
  assert.strictEqual(academic.source.credibility, "high");
  assert.strictEqual(academic.reliability, "established");
  assert.ok(academic.verified);
  // Every reliability must be a valid enum value.
  for (const f of res.verifiedFindings) {
    assert.ok(RELIABILITY.includes(f.reliability));
  }
});

test("a finding with no source cannot be established and is not verified", async () => {
  const findings = [{ text: "Unsourced claim", source: { url: "", title: "none" } }];
  const res = await verificationAgent({ questionId: "q002", findings, mock: true });
  assert.notStrictEqual(res.verifiedFindings[0].reliability, "established");
  assert.strictEqual(res.verifiedFindings[0].verified, false);
});

test("detectConflicts flags opposing-polarity findings sharing a topic", () => {
  const findings = [
    { text: "Adaptive tutoring improves outcomes for disadvantaged students." },
    { text: "However, adaptive tutoring does not improve outcomes reliably." },
  ];
  const idx = detectConflicts(findings);
  assert.ok(idx.has(0) && idx.has(1), "both conflicting findings flagged");
});

test("conflicting findings are marked disputed", async () => {
  const findings = [
    {
      text: "Detection tools accurately identify AI-written essays.",
      source: { url: "https://arxiv.org/abs/a", title: "A" },
    },
    {
      text: "However, detection tools do not accurately identify essays.",
      source: { url: "https://arxiv.org/abs/b", title: "B" },
    },
  ];
  const res = await verificationAgent({ questionId: "q003", findings, mock: true });
  assert.ok(res.disputed.length >= 1, "at least one disputed record");
  assert.ok(res.verifiedFindings.some((f) => f.reliability === "disputed"));
});
