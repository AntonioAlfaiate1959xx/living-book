#!/usr/bin/env node
/**
 * Living Book v2 — Back Office server.
 *
 * A dependency-free admin dashboard for operating every change and action:
 *   • Browse questions and their claims/sources
 *   • Propose new questions
 *   • Refresh a question (single-shot orchestrator or multi-agent ensemble;
 *     mock or live mode)
 *   • Run the cross-question consistency check
 *   • Build the v2 site (docs/index.html)
 *   • Inspect the edition ledger, consistency graph and orchestration logs
 *
 * Built on Node's built-in `http` module — no new dependencies, in keeping
 * with the project's design principles.
 *
 * Usage:
 *   node scripts/server.js               # listens on 0.0.0.0:3000
 *   PORT=4000 node scripts/server.js     # custom port
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
  PATHS,
  readJSON,
} = require("./lib.js");
const { orchestrate } = require("./orchestrate.js");
const { proposeQuestion } = require("./propose-question.js");
const consistency = require("./consistency-check.js");
const { renderClaim } = require("./render-claim.js");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = path.join(PATHS.root, "admin");

// ── Stage 6.5 (Canon & Consistency Review) locations ──────────────────
// The Canon layer written by scripts/consistency-review.mjs lives outside
// the paths declared in lib.js, so we resolve them here. These are the
// versioned claim-node store, the dispute records and the run reports.
const CANON = {
  claimsDir: path.join(PATHS.root, "claims"), // claims/<qid>/<clm>.json
  disputesDir: path.join(PATHS.root, "claims", "disputes"),
  reportsDir: path.join(PATHS.root, "reports"),
  reviewScript: path.join(PATHS.root, "scripts", "consistency-review.mjs"),
};

// Non-question directory names that live under claims/ but are not question
// folders (so we skip them when enumerating claim-node stores).
const CANON_SKIP = new Set(["disputes", "versions"]);

// ── Small helpers ────────────────────────────────────────────────────
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { ok: false, error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return reject(new Error("Request body too large."));
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  // Prevent path traversal.
  const safe = path
    .normalize(rel)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    return sendError(res, 403, "Forbidden");
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}

// ── Data assembly ────────────────────────────────────────────────────
function getStatus() {
  const registry = readJSON(PATHS.registry, { questions: [], total_questions: 0 });
  const ledger = readJSON(PATHS.ledger, { editions: [] });
  const graph = readJSON(PATHS.graph, { nodes: [], edges: [], contradictions: [] });

  const questions = registry.questions || [];
  const active = questions.filter((q) => q.status === "active");
  const proposed = questions.filter((q) => q.status === "proposed");
  const deprecated = questions.filter((q) => q.status === "deprecated");
  const answered = questions.filter((q) => q.added_in_edition !== null && q.status === "active");

  const claimFileCount = fs.existsSync(PATHS.claimsDir)
    ? fs.readdirSync(PATHS.claimsDir).filter((f) => f.endsWith(".json")).length
    : 0;

  const editions = ledger.editions || [];
  const latestEdition = editions.length
    ? editions[editions.length - 1].edition_number
    : 0;

  return {
    ok: true,
    totals: {
      questions: registry.total_questions || questions.length,
      active: active.length,
      answered: answered.length,
      proposed: proposed.length,
      deprecated: deprecated.length,
      claimFiles: claimFileCount,
      editions: editions.length,
      latestEdition,
      graphNodes: (graph.nodes || []).length,
      graphEdges: (graph.edges || []).length,
      contradictions: (graph.contradictions || []).length,
      disputed: (graph.disputed || []).length,
      ...canonTotals(), // claimNodes, suspectedClaims, openDisputes, latestReport
    },
    apiKeyConfigured: Boolean(process.env.ABACUS_API_KEY),
    generatedAt: new Date().toISOString(),
  };
}

function listQuestions() {
  const registry = readJSON(PATHS.registry, { questions: [] });
  const questions = (registry.questions || []).map((q) => {
    const claimFile = path.join(PATHS.claimsDir, `${q.id}.json`);
    let claimCount = 0;
    let sourceCount = 0;
    let disputedCount = 0;
    if (fs.existsSync(claimFile)) {
      try {
        const cf = readJSON(claimFile);
        claimCount = (cf.claims || []).length;
        const urls = new Set();
        (cf.claims || []).forEach((c) =>
          (c.sources || []).forEach((s) => s.url && urls.add(s.url))
        );
        sourceCount = urls.size;
        disputedCount = (cf.disputed_aspects || []).length;
      } catch (_) {}
    }
    return {
      id: q.id,
      status: q.status,
      chapter: q.chapter,
      chapter_number: q.chapter_number,
      question: q.question,
      rationale: q.rationale,
      added_in_edition: q.added_in_edition,
      claimCount,
      sourceCount,
      disputedCount,
      hasAnswer: claimCount > 0,
    };
  });
  return { ok: true, questions };
}

function getQuestion(id) {
  const registry = readJSON(PATHS.registry, { questions: [] });
  const entry = (registry.questions || []).find((q) => q.id === id);
  if (!entry) return { ok: false, error: `Question ${id} not found.` };
  const claimFile = path.join(PATHS.claimsDir, `${id}.json`);
  let claim = null;
  let html = null;
  if (fs.existsSync(claimFile)) {
    claim = readJSON(claimFile);
    try {
      html = renderClaim(claim);
    } catch (e) {
      html = `<p>Render error: ${e.message}</p>`;
    }
  }
  return { ok: true, entry, claim, html };
}

function tailLog(lines = 200) {
  if (!fs.existsSync(PATHS.orchestrationLog)) return { ok: true, log: "" };
  const content = fs.readFileSync(PATHS.orchestrationLog, "utf8");
  const arr = content.split("\n");
  return { ok: true, log: arr.slice(-lines).join("\n") };
}

// ── Stage 6.5 — Canon & Consistency Review data assembly ─────────────
// All read-only enumerations below are defensive: a missing directory or a
// malformed file is skipped rather than throwing, so the Back Office keeps
// working even before the first review has run.

// List the question folders that hold versioned claim nodes.
function canonQuestionDirs() {
  if (!fs.existsSync(CANON.claimsDir)) return [];
  return fs
    .readdirSync(CANON.claimsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !CANON_SKIP.has(d.name))
    .map((d) => d.name)
    .sort();
}

// Read every claim node for one question (top-level *.json only; archived
// versions live in a versions/ subfolder and are excluded).
function readClaimNodes(qid) {
  const dir = path.join(CANON.claimsDir, qid);
  if (!fs.existsSync(dir)) return [];
  const nodes = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const node = readJSON(path.join(dir, f), null);
    if (node && node.claimId) nodes.push(node);
  }
  return nodes.sort((a, b) => String(a.claimId).localeCompare(String(b.claimId)));
}

// Summary of claim nodes grouped by question (for the Canon browser list).
function listClaims() {
  const questions = canonQuestionDirs().map((qid) => {
    const nodes = readClaimNodes(qid);
    return {
      questionId: qid,
      questionText: (nodes[0] && nodes[0].meta && nodes[0].meta.questionText) || "",
      nodeCount: nodes.length,
      suspected: nodes.filter((n) => n.contradictionStatus === "suspected").length,
      openDisputes: nodes.filter((n) => n.disputeStatus === "open").length,
    };
  });
  const totals = questions.reduce(
    (acc, q) => {
      acc.nodes += q.nodeCount;
      acc.suspected += q.suspected;
      acc.openDisputes += q.openDisputes;
      return acc;
    },
    { nodes: 0, suspected: 0, openDisputes: 0 }
  );
  return { ok: true, totals, questions };
}

// Full claim-node detail for one question.
function getClaims(qid) {
  const nodes = readClaimNodes(qid);
  if (!nodes.length) {
    return { ok: false, error: `No claim nodes for ${qid}. Run the Canon review first.` };
  }
  return {
    ok: true,
    questionId: qid,
    questionText: (nodes[0].meta && nodes[0].meta.questionText) || "",
    nodes,
  };
}

// Read every dispute record. Newest first.
function listDisputes(statusFilter) {
  if (!fs.existsSync(CANON.disputesDir)) return { ok: true, disputes: [] };
  const disputes = [];
  for (const f of fs.readdirSync(CANON.disputesDir)) {
    if (!f.endsWith(".json")) continue;
    const d = readJSON(path.join(CANON.disputesDir, f), null);
    if (d && d.disputeId) {
      d.__file = f; // relative filename so the UI can reference it
      disputes.push(d);
    }
  }
  disputes.sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt)));
  const filtered = statusFilter
    ? disputes.filter((d) => (d.status || "open") === statusFilter)
    : disputes;
  return { ok: true, disputes: filtered };
}

// List the run reports (markdown + summary sidecar), newest first.
function listReports() {
  if (!fs.existsSync(CANON.reportsDir)) return { ok: true, reports: [] };
  const reports = fs
    .readdirSync(CANON.reportsDir)
    .filter((f) => /^consistency-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => {
      const date = f.slice("consistency-".length, -".md".length);
      const summary = readJSON(
        path.join(CANON.reportsDir, `consistency-${date}.summary.json`),
        null
      );
      return { date, file: f, summary };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  return { ok: true, reports };
}

// Read one report's markdown + summary.
function getReport(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return { ok: false, error: "Invalid report date." };
  }
  const mdFile = path.join(CANON.reportsDir, `consistency-${date}.md`);
  if (!fs.existsSync(mdFile)) return { ok: false, error: `No report for ${date}.` };
  const markdown = fs.readFileSync(mdFile, "utf8");
  const summary = readJSON(
    path.join(CANON.reportsDir, `consistency-${date}.summary.json`),
    null
  );
  return { ok: true, date, markdown, summary };
}

// Stage 6.5 headline counts for the dashboard/status.
function canonTotals() {
  const claims = listClaims().totals;
  const openDisputes = listDisputes("open").disputes.length;
  const reports = listReports().reports;
  return {
    claimNodes: claims.nodes,
    suspectedClaims: claims.suspected,
    openDisputes,
    latestReport: reports.length ? reports[0].date : null,
  };
}

// Human-in-the-loop resolution of a dispute. Additive and non-destructive:
// it stamps the dispute record with a resolution and flips the two claim
// nodes' contradiction/dispute status. Nothing is ever deleted.
function resolveDispute({ disputeId, resolution, note, resolvedBy }) {
  if (!disputeId) return { ok: false, error: "disputeId is required." };
  const decision = String(resolution || "resolved");
  const allowed = new Set(["resolved", "not_a_conflict", "dismissed", "reopened"]);
  if (!allowed.has(decision)) {
    return { ok: false, error: `Unknown resolution "${decision}".` };
  }
  if (!fs.existsSync(CANON.disputesDir)) {
    return { ok: false, error: "No disputes directory yet." };
  }
  // Locate the dispute file.
  let file = null;
  let dispute = null;
  for (const f of fs.readdirSync(CANON.disputesDir)) {
    if (!f.endsWith(".json")) continue;
    const d = readJSON(path.join(CANON.disputesDir, f), null);
    if (d && d.disputeId === disputeId) {
      file = path.join(CANON.disputesDir, f);
      dispute = d;
      break;
    }
  }
  if (!dispute) return { ok: false, error: `Dispute ${disputeId} not found.` };

  const reopening = decision === "reopened";
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  dispute.status = reopening ? "open" : "resolved";
  dispute.resolution = reopening
    ? null
    : {
        decision,
        note: note ? String(note) : "",
        resolvedBy: resolvedBy ? String(resolvedBy) : "back-office",
        resolvedAt: now,
      };
  writeJSONFile(file, dispute);

  // Reflect the decision on the linked claim nodes.
  const nodeDisputeStatus = reopening ? "open" : "resolved";
  const nodeContradictionStatus = reopening
    ? "suspected"
    : decision === "not_a_conflict"
    ? "none"
    : "resolved";
  const touched = [];
  for (const c of dispute.claims || []) {
    const node = findClaimNodeFile(dispute.questionId, c.claimId);
    if (!node) continue;
    node.obj.disputeStatus = nodeDisputeStatus;
    node.obj.contradictionStatus = nodeContradictionStatus;
    node.obj.meta = { ...(node.obj.meta || {}), lastReviewed: now };
    writeJSONFile(node.file, node.obj);
    touched.push(c.claimId);
  }
  return { ok: true, disputeId, status: dispute.status, resolution: dispute.resolution, touched };
}

// Find the on-disk file + parsed object for a claim node in a question.
function findClaimNodeFile(qid, claimId) {
  const dir = path.join(CANON.claimsDir, qid);
  const file = path.join(dir, `${claimId}.json`);
  if (fs.existsSync(file)) {
    const obj = readJSON(file, null);
    if (obj) return { file, obj };
  }
  // Fallback: scan the folder in case the filename differs from the id.
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(dir, f);
      const obj = readJSON(p, null);
      if (obj && obj.claimId === claimId) return { file: p, obj };
    }
  }
  return null;
}

// Minimal JSON writer (mirrors lib.js writeJSON but kept local to the server).
function writeJSONFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

// Run Stage 6.5 (consistency-review.mjs) as a child process and return the
// resulting summary. Non-blocking by design: the script always exits 0.
function runConsistencyReview(env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CANON.reviewScript], {
      cwd: PATHS.root,
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ ok: false, code: -1, output: e.message }));
    child.on("close", (code) => {
      // Attach the latest summary so the UI has structured numbers.
      const reports = listReports().reports;
      const summary = reports.length ? reports[0].summary : null;
      resolve({
        ok: code === 0,
        code,
        output: (out + err).trim(),
        summary,
        latestReport: reports.length ? reports[0].date : null,
      });
    });
  });
}

// ── Git commit + push after a successful refresh ─────────────────────
// Runs an arbitrary command, capturing stdout/stderr. Never throws — it
// resolves with { ok, code, output } so callers can decide what to do.
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: PATHS.root, ...opts });
    } catch (e) {
      return resolve({ ok: false, code: -1, output: e.message });
    }
    let out = "";
    let err = "";
    if (child.stdout) child.stdout.on("data", (d) => (out += d));
    if (child.stderr) child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ ok: false, code: -1, output: e.message }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, code, output: (out + err).trim() })
    );
  });
}

// Fetch a fresh GitHub access token from the Abacus VM metadata service so
// that pushes keep working even after any token embedded in the remote URL
// expires. Best-effort: resolves to a token string or null on any failure.
async function getFreshGitHubToken() {
  // Prefer an already-exported key; otherwise pull it from VM metadata.
  // Every curl is bounded with --max-time so a missing/blocked metadata
  // service can never hang the server.
  const script = `
set -e
API_KEY="\${ABACUS_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  MD_TOKEN=$(curl -s --max-time 5 -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-abacus-vm-metadata-token-ttl-seconds: 21600")
  API_KEY=$(curl -s --max-time 5 -H "X-abacus-vm-metadata-token: $MD_TOKEN" \
    http://169.254.169.254/latest/user-data \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['abacus_api_key'])")
fi
curl -s --max-time 15 "https://api.abacus.ai/api/getUserConnectorAuth?service=GITHUBUSER" \
  -H "apiKey: $API_KEY" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['auth']['accessToken'])"
`;
  try {
    const r = await runCmd("bash", ["-c", script], { env: process.env });
    const token = (r.output || "").trim().split("\n").pop().trim();
    if (r.ok && token && /^gh[a-z]_/.test(token)) return token;
  } catch (_) {}
  return null;
}

// Commit the files touched by a refresh and push them to origin/main so the
// public GitHub Pages site reflects the change. Fully non-blocking: any
// failure is caught and returned as a warning rather than crashing the server.
async function gitCommitAndPush(questionId, edition) {
  const log = [];
  const add = (m) => log.push(m);
  try {
    // Ensure a git identity exists for the commit.
    await runCmd("git", ["config", "user.name", "Living Book Bot"]);
    await runCmd("git", ["config", "user.email", "bot@living-book.local"]);

    // Try to refresh credentials with a fresh token. If this fails we still
    // attempt the push using whatever credentials the remote already has.
    const token = await getFreshGitHubToken();
    if (token) {
      await runCmd("git", ["config", "credential.helper", "store"]);
      try {
        fs.writeFileSync(
          path.join(process.env.HOME || "/home/ubuntu", ".git-credentials"),
          `https://oauth2:${token}@github.com\n`,
          { mode: 0o600 }
        );
        add("Refreshed GitHub credentials.");
      } catch (e) {
        add(`Could not write git credentials: ${e.message}`);
      }
    } else {
      add("Warning: could not fetch a fresh GitHub token; using existing credentials.");
    }

    // Stage the files a refresh can touch.
    const targets = [
      "data/claims",
      "editions/ledger.json",
      "data/graph.json",
      "data/question-registry.json",
      "docs/index.html",
      "logs/orchestration.log",
    ];
    await runCmd("git", ["add", "--", ...targets]);

    // Anything actually staged?
    const staged = await runCmd("git", ["diff", "--cached", "--name-only"]);
    if (!staged.output) {
      add("Nothing to commit — working tree clean after refresh.");
      return { ok: true, pushed: false, log: log.join(" ") };
    }

    const msg = `chore: refresh answer for ${questionId} via Back Office${
      edition != null ? ` (edition ${edition})` : ""
    }`;
    const commit = await runCmd("git", ["commit", "-m", msg]);
    if (!commit.ok) {
      add(`Commit failed: ${commit.output}`);
      return { ok: false, pushed: false, log: log.join(" ") };
    }
    add(`Committed: ${msg}`);

    const push = await runCmd("git", ["push", "origin", "HEAD:main"]);
    if (!push.ok) {
      add(`Push failed: ${push.output}`);
      return { ok: false, pushed: false, log: log.join(" ") };
    }
    add("Pushed to origin/main — public site will update shortly.");
    return { ok: true, pushed: true, log: log.join(" ") };
  } catch (e) {
    add(`Git sync error: ${e.message}`);
    return { ok: false, pushed: false, log: log.join(" ") };
  }
}

// Commit + push an explicit set of paths to origin/main. Used by the Canon
// endpoints (which touch claims/ and reports/, outside the refresh target
// set). Fully non-blocking: any failure is returned as a warning.
async function gitCommitPaths(targets, message) {
  const log = [];
  const add = (m) => log.push(m);
  try {
    await runCmd("git", ["config", "user.name", "Living Book Bot"]);
    await runCmd("git", ["config", "user.email", "bot@living-book.local"]);

    const token = await getFreshGitHubToken();
    if (token) {
      await runCmd("git", ["config", "credential.helper", "store"]);
      try {
        fs.writeFileSync(
          path.join(process.env.HOME || "/home/ubuntu", ".git-credentials"),
          `https://oauth2:${token}@github.com\n`,
          { mode: 0o600 }
        );
        add("Refreshed GitHub credentials.");
      } catch (e) {
        add(`Could not write git credentials: ${e.message}`);
      }
    } else {
      add("Warning: could not fetch a fresh GitHub token; using existing credentials.");
    }

    await runCmd("git", ["add", "--", ...targets]);
    const staged = await runCmd("git", ["diff", "--cached", "--name-only"]);
    if (!staged.output) {
      add("Nothing to commit — Canon store unchanged.");
      return { ok: true, pushed: false, log: log.join(" ") };
    }
    const commit = await runCmd("git", ["commit", "-m", message]);
    if (!commit.ok) {
      add(`Commit failed: ${commit.output}`);
      return { ok: false, pushed: false, log: log.join(" ") };
    }
    add(`Committed: ${message}`);
    const push = await runCmd("git", ["push", "origin", "HEAD:main"]);
    if (!push.ok) {
      add(`Push failed: ${push.output}`);
      return { ok: false, pushed: false, log: log.join(" ") };
    }
    add("Pushed to origin/main.");
    return { ok: true, pushed: true, log: log.join(" ") };
  } catch (e) {
    add(`Git sync error: ${e.message}`);
    return { ok: false, pushed: false, log: log.join(" ") };
  }
}

// Run the v2 build as a child process so we capture its output.
function runBuild() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PATHS.root, "scripts", "build-v2.js")], {
      cwd: PATHS.root,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      resolve({ ok: code === 0, code, output: (out + err).trim() });
    });
  });
}

// ── Router ───────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ['api', ...]
  const resource = parts[1];

  // GET endpoints
  if (req.method === "GET") {
    switch (resource) {
      case "status":
        return sendJSON(res, 200, getStatus());
      case "questions": {
        if (parts[2]) return sendJSON(res, 200, getQuestion(parts[2]));
        return sendJSON(res, 200, listQuestions());
      }
      case "editions":
        return sendJSON(res, 200, {
          ok: true,
          ...readJSON(PATHS.ledger, { editions: [] }),
        });
      case "graph":
        return sendJSON(res, 200, {
          ok: true,
          ...readJSON(PATHS.graph, { nodes: [], edges: [], contradictions: [] }),
        });
      case "logs":
        return sendJSON(res, 200, tailLog(300));

      // ── Stage 6.5 — Canon & Consistency Review (read) ───────────────
      case "claims": {
        if (parts[2]) return sendJSON(res, 200, getClaims(parts[2]));
        return sendJSON(res, 200, listClaims());
      }
      case "disputes":
        // Optional ?status=open|resolved filter.
        return sendJSON(res, 200, listDisputes(url.searchParams.get("status") || null));
      case "reports": {
        if (parts[2]) return sendJSON(res, 200, getReport(parts[2]));
        return sendJSON(res, 200, listReports());
      }

      default:
        return sendError(res, 404, `Unknown endpoint: ${url.pathname}`);
    }
  }

  // POST endpoints
  if (req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendError(res, 400, e.message);
    }

    switch (resource) {
      case "propose": {
        const { question, chapter, rationale } = body;
        try {
          const result = proposeQuestion(
            { question, chapter, rationale },
            { persist: true }
          );
          if (!result.ok) return sendJSON(res, 400, result);
          return sendJSON(res, 200, { ok: true, entry: result.entry });
        } catch (e) {
          return sendError(res, 500, e.message);
        }
      }

      case "refresh": {
        const { questionId, mock = true, ensemble = false } = body;
        if (!questionId) return sendError(res, 400, "questionId is required.");
        if (!mock && !process.env.ABACUS_API_KEY) {
          return sendError(
            res,
            400,
            "Live mode requires ABACUS_API_KEY to be set on the server. Use mock mode or set the key."
          );
        }
        try {
          const result = await orchestrate(questionId, {
            mock: Boolean(mock),
            ensemble: Boolean(ensemble),
            persist: true,
          });
          // Automatically rebuild docs/index.html so the book site reflects
          // the refreshed answer immediately.
          let buildLog = "";
          try {
            const buildResult = await runBuild();
            buildLog = buildResult.ok
              ? "Site rebuilt successfully."
              : `Site rebuild warning: ${buildResult.error || "unknown"}`;
          } catch (be) {
            buildLog = `Site rebuild failed: ${be.message}`;
          }
          // Commit + push the refreshed data so the public GitHub Pages site
          // reflects the change. Non-blocking: failures surface as a warning
          // in the summary rather than aborting the refresh.
          let gitLog = "";
          let gitPushed = false;
          try {
            const gitResult = await gitCommitAndPush(result.questionId, result.edition);
            gitLog = gitResult.log;
            gitPushed = Boolean(gitResult.pushed);
          } catch (ge) {
            gitLog = `Git sync failed: ${ge.message}`;
          }
          // Normalize into a compact summary the UI can display directly.
          const summary = {
            questionId: result.questionId,
            edition: result.edition,
            claims: Array.isArray(result.claims) ? result.claims.length : 0,
            sources:
              result.claim && Array.isArray(result.claim.sources)
                ? result.claim.sources.length
                : 0,
            lastClaimId: result.claim ? result.claim.claim_id : null,
            buildLog,
            gitLog,
            gitPushed,
          };
          return sendJSON(res, 200, { ok: true, result: summary });
        } catch (e) {
          return sendError(res, 500, e.message);
        }
      }

      case "consistency": {
        try {
          const result = consistency.run({ persist: true });
          return sendJSON(res, 200, {
            ok: true,
            nodeCount: result.nodeCount,
            edgeCount: result.edgeCount,
            disputed: result.disputed,
            contradictions: result.contradictions,
          });
        } catch (e) {
          return sendError(res, 500, e.message);
        }
      }

      case "build": {
        const result = await runBuild();
        return sendJSON(res, result.ok ? 200 : 500, result);
      }

      // ── Stage 6.5 — run the Canon & Consistency Review pipeline ──────
      case "consistency-review": {
        try {
          const env = {};
          if (body.gate != null) env.CONSISTENCY_GATE = String(body.gate);
          if (body.maxClaims != null) env.CONSISTENCY_MAX_CLAIMS = String(body.maxClaims);
          const result = await runConsistencyReview(env);
          // Optionally commit + push the regenerated Canon store + report so
          // the change is versioned. Defaults to true; caller can opt out.
          let gitLog = "";
          let gitPushed = false;
          if (body.commit !== false) {
            const g = await gitCommitPaths(
              ["claims", "reports"],
              `chore: run Canon & Consistency Review (Stage 6.5) via Back Office`
            );
            gitLog = g.log;
            gitPushed = Boolean(g.pushed);
          }
          return sendJSON(res, 200, {
            ok: result.ok,
            summary: result.summary,
            latestReport: result.latestReport,
            output: result.output,
            gitLog,
            gitPushed,
          });
        } catch (e) {
          return sendError(res, 500, e.message);
        }
      }

      // ── Stage 6.5 — resolve (or reopen) a dispute ───────────────────
      case "disputes": {
        // Only the /api/disputes/resolve action is supported for POST.
        if (parts[2] !== "resolve") {
          return sendError(res, 404, `Unknown endpoint: ${url.pathname}`);
        }
        try {
          const result = resolveDispute({
            disputeId: body.disputeId,
            resolution: body.resolution,
            note: body.note,
            resolvedBy: body.resolvedBy,
          });
          if (!result.ok) return sendJSON(res, 400, result);
          // Version the resolution so it is not lost on the next review run.
          let gitPushed = false;
          if (body.commit !== false) {
            const g = await gitCommitPaths(
              ["claims"],
              `chore: resolve dispute ${result.disputeId} via Back Office`
            );
            gitPushed = Boolean(g.pushed);
            result.gitLog = g.log;
          }
          result.gitPushed = gitPushed;
          return sendJSON(res, 200, result);
        } catch (e) {
          return sendError(res, 500, e.message);
        }
      }

      default:
        return sendError(res, 404, `Unknown endpoint: ${url.pathname}`);
    }
  }

  return sendError(res, 405, "Method not allowed");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((e) => sendError(res, 500, e.message));
    return;
  }
  serveStatic(res, url.pathname);
});

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Living Book back office running at http://localhost:${PORT}`);
    console.log(`  API key configured: ${Boolean(process.env.ABACUS_API_KEY)}`);
  });
}

module.exports = {
  server,
  getStatus,
  listQuestions,
  getQuestion,
  gitCommitAndPush,
  getFreshGitHubToken,
  runCmd,
  // Stage 6.5 — Canon & Consistency Review
  listClaims,
  getClaims,
  listDisputes,
  listReports,
  getReport,
  canonTotals,
  resolveDispute,
  runConsistencyReview,
};
