// synthesis-agent.test.js — Mock-only tests. No network is ever touched.

const test = require("node:test");
const assert = require("node:assert");
const { synthesisAgent } = require("../scripts/agents/synthesis-agent.js");
const { validateClaimFile } = require("../scripts/lib.js");

const verifiedFindings = [
  {
    text: "Established finding.",
    source: {
      url: "https://arxiv.org/abs/1",
      title: "A",
      type: "academic",
      credibility: "high",
    },
    reliability: "established",
    credibility: "high",
    verified: true,
  },
  {
    text: "Emerging finding.",
    source: {
      url: "https://example.com/x",
      title: "B",
      type: "practitioner",
      credibility: "medium",
    },
    reliability: "emerging",
    credibility: "medium",
    verified: true,
  },
  {
    text: "Unverified finding that must be excluded.",
    source: { url: "", title: "none", type: "practitioner", credibility: "low" },
    reliability: "emerging",
    credibility: "low",
    verified: false,
  },
];

test("synthesis output conforms to the claim-file schema", async () => {
  const out = await synthesisAgent({
    questionId: "q001",
    questionText: "Sample?",
    verifiedFindings,
    edition: 5,
    mock: true,
  });
  const errors = validateClaimFile(out, "synth");
  assert.deepStrictEqual(errors, [], "should be schema-valid: " + errors.join("; "));
  assert.strictEqual(out.current_edition, 5);
});

test("synthesis excludes unverified findings", async () => {
  const out = await synthesisAgent({
    questionId: "q001",
    questionText: "Sample?",
    verifiedFindings,
    edition: 1,
    mock: true,
  });
  // New architecture: all verified findings are synthesised into exactly ONE canonical c01 claim.
  assert.strictEqual(out.claims.length, 1, "should produce exactly one synthesised claim");
  // The unverified finding must not appear in the essay text.
  assert.ok(!out.claims[0].text.includes("must be excluded"), "unverified finding must be excluded");
});

test("synthesis surfaces disputed findings under disputed_aspects", async () => {
  const disputedFindings = [
    {
      text: "Contested claim.",
      source: {
        url: "https://arxiv.org/abs/z",
        title: "Z",
        type: "academic",
        credibility: "high",
      },
      reliability: "disputed",
      credibility: "high",
      verified: true,
    },
  ];
  const out = await synthesisAgent({
    questionId: "q009",
    questionText: "Contested?",
    verifiedFindings: disputedFindings,
    edition: 2,
    mock: true,
  });
  // Disputed findings appear in disputed_aspects; the consolidated essay has reliability "emerging".
  assert.strictEqual(out.disputed_aspects.length, 1, "disputed finding must appear in disputed_aspects");
  assert.strictEqual(out.claims.length, 1, "still exactly one synthesised claim");
  assert.strictEqual(out.claims[0].reliability, "emerging", "disputed inputs make the claim 'emerging'");
});

test("claim ids are unique and well-formed", async () => {
  const out = await synthesisAgent({
    questionId: "q001",
    questionText: "Sample?",
    verifiedFindings,
    edition: 1,
    mock: true,
  });
  const ids = out.claims.map((c) => c.claim_id);
  assert.strictEqual(new Set(ids).size, ids.length, "ids must be unique");
  for (const id of ids) assert.match(id, /^q001-c\d{2}$/);
});
