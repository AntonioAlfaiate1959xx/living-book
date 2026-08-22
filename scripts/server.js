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
};
