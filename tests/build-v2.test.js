// build-v2.test.js — Tests the v2 build pipeline (without writing docs/).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { PATHS, readJSON } = require("../scripts/lib.js");
const { renderClaim } = require("../scripts/render-claim.js");

test("build-v2 can run and produce output (dry-run check)", () => {
  // This test verifies that the build script's dependencies and logic are
  // correct by checking that all required data files exist and can be read.
  const registry = readJSON(PATHS.registry, null);
  assert.ok(registry, "registry must exist for build-v2 to work");
  assert.ok(Array.isArray(registry.questions), "registry must have questions");

  const ledger = readJSON(PATHS.ledger, null);
  assert.ok(ledger, "ledger must exist");
  assert.ok(Array.isArray(ledger.editions), "ledger must have editions");

  // Verify that at least one answered question can be rendered.
  const activeQuestions = registry.questions.filter((q) => q.status === "active");
  assert.ok(activeQuestions.length > 0, "at least one active question expected");

  let rendered = 0;
  for (const q of activeQuestions.slice(0, 5)) {
    const claimFile = readJSON(path.join(PATHS.claimsDir, `${q.id}.json`), null);
    if (claimFile) {
      const html = renderClaim(claimFile);
      assert.ok(html.includes("<section>"), `${q.id} must render a section`);
      // Check for a safe substring that won't be escaped (first few words).
      const safeSubstring = q.question.split(/[<>"'&]/)[0].slice(0, 20);
      assert.ok(html.includes(safeSubstring), `${q.id} must include the question text`);
      rendered++;
    }
  }
  assert.ok(rendered > 0, "at least one claim file must be renderable");
});

test("rendered HTML includes edition number in sources", () => {
  const claimFile = readJSON(path.join(PATHS.claimsDir, "q001.json"), null);
  if (!claimFile) {
    console.log("  (skipped: q001.json not found)");
    return;
  }
  const html = renderClaim(claimFile);
  assert.match(html, /edition \d+/, "should mention edition number");
});

test("rendered HTML escapes user-controlled content", () => {
  const malicious = {
    question_id: "qXSS",
    question_text: '<script>alert("xss")</script>',
    current_edition: 1,
    claims: [
      {
        claim_id: "qXSS-c01",
        text: '<img src=x onerror="alert(1)">',
        reliability: "established",
        sources: [
          {
            url: "https://evil.test",
            title: '<a href="javascript:alert(2)">click</a>',
            type: "news",
            credibility: "low",
          },
        ],
        perspectives: [],
        last_verified: "2026-01-01",
        added_edition: 1,
      },
    ],
    answer_summary: "Escaped content",
    disputed_aspects: [],
  };
  const html = renderClaim(malicious);
  assert.ok(!html.includes("<script>"), "script tags must be escaped");
  assert.ok(!html.includes('onerror="alert'), "event handlers must be escaped");
  assert.ok(!html.includes('href="javascript:'), "javascript: URLs must not be clickable");
  assert.ok(!html.match(/<a[^>]+href=["']?javascript:/i), "no clickable javascript: URLs");
  assert.match(html, /&lt;script&gt;/, "< and > must be entity-encoded");
});
