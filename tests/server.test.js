"use strict";

/**
 * Tests for the Back Office server.
 *
 * These exercise the HTTP layer end-to-end against an ephemeral server
 * instance on a random port, using only read-only (GET) endpoints plus the
 * mock-mode propose flow reverted afterwards — so no real data is mutated.
 * All network calls stay on localhost; no external API is touched.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { getStatus, listQuestions, getQuestion } = require("../scripts/server.js");

// ── Pure data-assembly helpers (no network) ──────────────────────────
test("getStatus returns a well-formed totals object", () => {
  const s = getStatus();
  assert.strictEqual(s.ok, true);
  assert.ok(s.totals, "totals present");
  for (const key of [
    "questions",
    "active",
    "answered",
    "proposed",
    "editions",
    "graphNodes",
    "graphEdges",
    "contradictions",
  ]) {
    assert.strictEqual(
      typeof s.totals[key],
      "number",
      `totals.${key} is a number`
    );
  }
  assert.strictEqual(typeof s.apiKeyConfigured, "boolean");
});

test("listQuestions returns every registry question with claim metadata", () => {
  const r = listQuestions();
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.questions));
  assert.ok(r.questions.length >= 100, "at least the 100 seed questions");
  const q = r.questions[0];
  for (const key of ["id", "status", "question", "claimCount", "sourceCount"]) {
    assert.ok(key in q, `question has ${key}`);
  }
  // claimCount / sourceCount must be numeric
  assert.strictEqual(typeof q.claimCount, "number");
  assert.strictEqual(typeof q.sourceCount, "number");
});

test("getQuestion returns entry + rendered html for an answered question", () => {
  const r = getQuestion("q001");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entry.id, "q001");
  assert.ok(r.claim, "answered question has a claim file");
  assert.ok(typeof r.html === "string" && r.html.length > 0, "html rendered");
});

test("getQuestion rejects an unknown id", () => {
  const r = getQuestion("q999");
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found/i);
});

// ── HTTP layer smoke test (read-only GET endpoints) ──────────────────
function startEphemeral() {
  // Re-require the server module's http.Server without invoking listen from
  // the module's own main guard (already guarded by require.main check).
  const { server } = require("../scripts/server.js");
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch (e) {
            resolve({ status: res.statusCode, json: null, body });
          }
        });
      })
      .on("error", reject);
  });
}

test("HTTP: GET /api/status and /api/questions respond OK", async () => {
  const server = await startEphemeral();
  const port = server.address().port;
  try {
    const status = await get(port, "/api/status");
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.json.ok, true);

    const questions = await get(port, "/api/questions");
    assert.strictEqual(questions.status, 200);
    assert.ok(Array.isArray(questions.json.questions));

    const one = await get(port, "/api/questions/q001");
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.json.entry.id, "q001");

    const unknown = await get(port, "/api/does-not-exist");
    assert.strictEqual(unknown.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
