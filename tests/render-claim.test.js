// render-claim.test.js — Tests the claim-to-HTML rendering logic.

const test = require("node:test");
const assert = require("node:assert");
const {
  renderClaim,
  markdownToHTML,
  escapeHTML,
} = require("../scripts/render-claim.js");

test("escapeHTML prevents XSS", () => {
  const unsafe = '<script>alert("xss")</script>';
  const safe = escapeHTML(unsafe);
  assert.strictEqual(safe, "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  assert.ok(!safe.includes("<script>"));
});

test("markdownToHTML converts **bold** and *italic*", () => {
  const md = "This is **bold** and *italic* text.";
  const html = markdownToHTML(md);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<p>/);
});

test("markdownToHTML splits on blank lines into paragraphs", () => {
  const md = "Paragraph one.\n\nParagraph two.";
  const html = markdownToHTML(md);
  const pCount = (html.match(/<p>/g) || []).length;
  assert.strictEqual(pCount, 2);
});

test("renderClaim produces valid HTML with question and sources", () => {
  const claimFile = {
    question_id: "q001",
    question_text: "What is AI in education?",
    current_edition: 3,
    claims: [
      {
        claim_id: "q001-c01",
        text: "AI in education refers to...",
        reliability: "established",
        sources: [
          {
            url: "https://arxiv.org/abs/1",
            title: "Academic source",
            type: "academic",
            credibility: "high",
          },
        ],
        perspectives: [],
        last_verified: "2026-01-01",
        added_edition: 1,
      },
    ],
    answer_summary: "AI in education refers to...",
    disputed_aspects: [],
  };
  const html = renderClaim(claimFile);
  assert.match(html, /<section>/);
  assert.match(html, /<h3>What is AI in education\?<\/h3>/);
  assert.match(html, /edition 3/);
  assert.match(html, /arxiv\.org/);
  assert.match(html, /Academic source/);
  assert.match(html, /\(academic\)/);
  assert.match(html, /high credibility/);
});

test("renderClaim deduplicates sources by URL", () => {
  const claimFile = {
    question_id: "q001",
    question_text: "Test",
    current_edition: 1,
    claims: [
      {
        claim_id: "q001-c01",
        text: "Claim 1",
        reliability: "established",
        sources: [
          {
            url: "https://example.com/shared",
            title: "Shared source",
            type: "news",
            credibility: "medium",
          },
        ],
        perspectives: [],
        last_verified: "2026-01-01",
        added_edition: 1,
      },
      {
        claim_id: "q001-c02",
        text: "Claim 2",
        reliability: "emerging",
        sources: [
          {
            url: "https://example.com/shared",
            title: "Shared source duplicate",
            type: "news",
            credibility: "medium",
          },
        ],
        perspectives: [],
        last_verified: "2026-01-01",
        added_edition: 1,
      },
    ],
    answer_summary: "Test summary",
    disputed_aspects: [],
  };
  const html = renderClaim(claimFile);
  const matches = html.match(/https:\/\/example\.com\/shared/g) || [];
  assert.strictEqual(matches.length, 1, "source URL should appear exactly once");
});

test("renderClaim surfaces disputed aspects when present", () => {
  const claimFile = {
    question_id: "q001",
    question_text: "Test",
    current_edition: 1,
    claims: [],
    answer_summary: "Test",
    disputed_aspects: [
      { summary: "Conflicting claim A", source_url: "https://a.test" },
    ],
  };
  const html = renderClaim(claimFile, { includeDisputed: true });
  assert.match(html, /Disputed Aspects/);
  assert.match(html, /Conflicting claim A/);
  assert.match(html, /https:\/\/a\.test/);
});

test("renderClaim omits disputed aspects when includeDisputed is false", () => {
  const claimFile = {
    question_id: "q001",
    question_text: "Test",
    current_edition: 1,
    claims: [],
    answer_summary: "Test",
    disputed_aspects: [
      { summary: "Should not appear", source_url: "https://x.test" },
    ],
  };
  const html = renderClaim(claimFile, { includeDisputed: false });
  assert.ok(!html.includes("Disputed Aspects"));
  assert.ok(!html.includes("Should not appear"));
});
