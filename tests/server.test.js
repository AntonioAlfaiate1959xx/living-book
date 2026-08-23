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

const {
  getStatus,
  listQuestions,
  getQuestion,
  listClaims,
  listDisputes,
  listReports,
  canonTotals,
  resolveDispute,
} = require("../scripts/server.js");

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
    // Stage 6.5 Canon fields
    "claimNodes",
    "suspectedClaims",
    "openDisputes",
  ]) {
    assert.strictEqual(
      typeof s.totals[key],
      "number",
      `totals.${key} is a number`
    );
  }
  assert.strictEqual(typeof s.apiKeyConfigured, "boolean");
});

// ── Stage 6.5 — Canon & Consistency Review helpers ───────────────────
test("listClaims groups claim nodes by question with numeric totals", () => {
  const r = listClaims();
  assert.strictEqual(r.ok, true);
  assert.ok(r.totals && typeof r.totals.nodes === "number", "totals.nodes numeric");
  assert.ok(Array.isArray(r.questions), "questions is an array");
  if (r.questions.length) {
    const q = r.questions[0];
    for (const key of ["questionId", "nodeCount", "suspected", "openDisputes"]) {
      assert.ok(key in q, `claim group has ${key}`);
    }
  }
});

test("listDisputes returns an array and honours a status filter", () => {
  const all = listDisputes();
  assert.strictEqual(all.ok, true);
  assert.ok(Array.isArray(all.disputes));
  const open = listDisputes("open");
  assert.ok(Array.isArray(open.disputes));
  // Every returned dispute must actually match the filter.
  assert.ok(open.disputes.every((d) => (d.status || "open") === "open"));
});

test("listReports returns dated reports newest-first", () => {
  const r = listReports();
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.reports));
  if (r.reports.length > 1) {
    assert.ok(r.reports[0].date >= r.reports[1].date, "sorted desc by date");
  }
});

test("canonTotals exposes the four headline counters", () => {
  const t = canonTotals();
  for (const key of ["claimNodes", "suspectedClaims", "openDisputes"]) {
    assert.strictEqual(typeof t[key], "number", `${key} numeric`);
  }
  assert.ok("latestReport" in t, "latestReport present");
});

test("resolveDispute rejects a missing id without mutating anything", () => {
  const r = resolveDispute({ disputeId: "dsp-does-not-exist", resolution: "resolved" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found|No disputes/i);
});

test("resolveDispute rejects an unknown resolution value", () => {
  const r = resolveDispute({ disputeId: "dsp-x", resolution: "banana" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Unknown resolution/i);
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

test("HTTP: Stage 6.5 GET endpoints (claims, disputes, reports) respond OK", async () => {
  const server = await startEphemeral();
  const port = server.address().port;
  try {
    const claims = await get(port, "/api/claims");
    assert.strictEqual(claims.status, 200);
    assert.strictEqual(claims.json.ok, true);
    assert.ok(Array.isArray(claims.json.questions));

    const disputes = await get(port, "/api/disputes");
    assert.strictEqual(disputes.status, 200);
    assert.ok(Array.isArray(disputes.json.disputes));

    const openOnly = await get(port, "/api/disputes?status=open");
    assert.strictEqual(openOnly.status, 200);
    assert.ok(Array.isArray(openOnly.json.disputes));

    const reports = await get(port, "/api/reports");
    assert.strictEqual(reports.status, 200);
    assert.ok(Array.isArray(reports.json.reports));

    // If a report exists, its detail endpoint must return markdown.
    if (reports.json.reports.length) {
      const date = reports.json.reports[0].date;
      const one = await get(port, "/api/reports/" + date);
      assert.strictEqual(one.status, 200);
      assert.strictEqual(one.json.ok, true);
      assert.ok(typeof one.json.markdown === "string" && one.json.markdown.length > 0);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
