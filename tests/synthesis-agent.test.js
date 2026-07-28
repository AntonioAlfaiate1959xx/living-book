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
  // Only the 2 verified findings should become claims.
  assert.strictEqual(out.claims.length, 2);
  assert.ok(!out.claims.some((c) => c.text.includes("must be excluded")));
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
  assert.strictEqual(out.disputed_aspects.length, 1);
  assert.strictEqual(out.claims[0].reliability, "disputed");
  assert.ok(out.claims[0].perspectives.length >= 1);
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
