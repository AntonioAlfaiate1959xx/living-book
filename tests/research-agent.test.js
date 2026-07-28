// research-agent.test.js — Mock-only tests. No network is ever touched.

const test = require("node:test");
const assert = require("node:assert");
const { researchAgent, mockFindings } = require("../scripts/agents/research-agent.js");

test("mockFindings is deterministic and references the question id", () => {
  const a = mockFindings("q001", "What is AI in education?");
  const b = mockFindings("q001", "What is AI in education?");
  assert.deepStrictEqual(a, b, "mock output must be stable");
  assert.ok(a.length >= 2, "should return multiple findings");
  for (const f of a) {
    assert.match(f.text, /q001/);
    assert.ok(f.source && typeof f.source.url === "string");
    assert.ok(f.source.title && f.source.title.length > 0);
  }
});

test("researchAgent (mock) returns a well-shaped envelope", async () => {
  const res = await researchAgent({
    questionId: "q042",
    questionText: "Sample question",
    mock: true,
  });
  assert.strictEqual(res.questionId, "q042");
  assert.ok(Array.isArray(res.findings) && res.findings.length >= 2);
  assert.ok(typeof res.generatedAt === "string");
});

test("researchAgent requires a questionId", async () => {
  await assert.rejects(() => researchAgent({ mock: true }), /questionId/);
});

test("researchAgent uses an injected apiCall instead of the network", async () => {
  let called = false;
  const apiCall = async (qtext, qid) => {
    called = true;
    assert.strictEqual(qid, "q007");
    return [{ text: "injected", source: { url: "https://x.test", title: "X" } }];
  };
  const res = await researchAgent({
    questionId: "q007",
    questionText: "Q",
    apiCall,
  });
  assert.ok(called, "injected apiCall must be used");
  assert.strictEqual(res.findings[0].text, "injected");
});
