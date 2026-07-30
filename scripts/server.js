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

module.exports = { server, getStatus, listQuestions, getQuestion };
