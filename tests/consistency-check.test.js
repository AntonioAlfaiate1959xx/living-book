// consistency-check.test.js — Pure, offline graph/contradiction tests.

const test = require("node:test");
const assert = require("node:assert");
const {
  buildGraph,
  keywords,
  jaccard,
  run,
} = require("../scripts/consistency-check.js");
const { PATHS, readJSON } = require("../scripts/lib.js");

test("keywords drops stopwords/short tokens and jaccard is bounded", () => {
  const kw = keywords("Adaptive tutoring platforms improve measurable outcomes");
  assert.ok(kw.has("adaptive") || kw.has("tutoring") || kw.has("platforms"));
  assert.ok(!kw.has("the") && !kw.has("ai"));
  const j = jaccard(new Set(["a", "b"]), new Set(["b", "c"]));
  assert.ok(j > 0 && j < 1);
});

test("buildGraph links cross-question claims sharing a source", () => {
  const nodes = [
    {
      claim_id: "q001-c01",
      question_id: "q001",
      reliability: "established",
      sources: ["https://arxiv.org/abs/shared"],
      keywords: keywords("adaptive tutoring outcomes disadvantaged"),
      negation: false,
    },
    {
      claim_id: "q002-c01",
      question_id: "q002",
      reliability: "established",
      sources: ["https://arxiv.org/abs/shared"],
      keywords: keywords("adaptive tutoring results students"),
      negation: false,
    },
  ];
  const { edges } = buildGraph(nodes);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].relation, "shared-source");
  assert.deepStrictEqual(edges[0].shared_sources, ["https://arxiv.org/abs/shared"]);
});

test("buildGraph flags a contradiction on opposing polarity", () => {
  const nodes = [
    {
      claim_id: "q001-c01",
      question_id: "q001",
      reliability: "established",
      sources: ["https://arxiv.org/abs/shared"],
      keywords: keywords("detection tools accurately identify essays"),
      negation: false,
    },
    {
      claim_id: "q002-c01",
      question_id: "q002",
      reliability: "established",
      sources: ["https://arxiv.org/abs/shared"],
      keywords: keywords("detection tools accurately identify essays"),
      negation: true,
    },
  ];
  const { contradictions } = buildGraph(nodes);
  assert.strictEqual(contradictions.length, 1);
  assert.deepStrictEqual(contradictions[0].questions.sort(), ["q001", "q002"]);
});

test("same-question claims are never linked to each other", () => {
  const nodes = [
    {
      claim_id: "q001-c01",
      question_id: "q001",
      reliability: "established",
      sources: ["https://arxiv.org/abs/shared"],
      keywords: keywords("adaptive tutoring outcomes"),
      negation: false,
    },
    {
      claim_id: "q001-c02",
      question_id: "q001",
      reliability: "established",
      sources: ["https://arxiv.org/abs/shared"],
      keywords: keywords("adaptive tutoring outcomes"),
      negation: false,
    },
  ];
  const { edges } = buildGraph(nodes);
  assert.strictEqual(edges.length, 0);
});

test("run() over the real repo produces a graph and no crash", () => {
  const res = run({ persist: false });
  assert.ok(res.nodeCount >= 1, "should load claims from the repo");
  assert.ok(Array.isArray(res.contradictions));
  assert.ok(res.graph && Array.isArray(res.graph.edges));
});
