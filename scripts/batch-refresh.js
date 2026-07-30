#!/usr/bin/env node
// batch-refresh.js — Refresh all 100 questions of the Living Book via the
// multi-agent ensemble pipeline (Research → Verification → Synthesis).
//
// Usage:
//   node scripts/batch-refresh.js
//   nohup node scripts/batch-refresh.js > /tmp/batch-refresh.log 2>&1 &
//
// Each question is processed sequentially to avoid rate-limit bursts.
// Failures are logged and skipped; the batch always continues to completion.
// After all questions, the site is rebuilt and a summary report is written.

"use strict";

const fs   = require("fs");
const path = require("path");

const { orchestrate } = require("./orchestrate.js");
const { spawn }       = require("child_process");

const ROOT            = path.join(__dirname, "..");
const REGISTRY_PATH   = path.join(ROOT, "data", "question-registry.json");
const REPORT_PATH     = path.join(ROOT, "logs", "batch-refresh-report.json");
const LOG_PATH        = path.join(ROOT, "logs", "orchestration.log");

// ── helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch (_) {}
}

function countWords(text = "") {
  return text.split(/\s+/).filter(Boolean).length;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  log("=== BATCH REFRESH STARTED ===");
  log(`Node ${process.version}  PID ${process.pid}`);

  // Load question registry.
  const registry  = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  const questions = (registry.questions || [])
    .filter((q) => q.status === "active")
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((q) => [q.id, q]);   // normalise to [qid, meta] pairs

  const total = questions.length;
  log(`Questions to refresh: ${total}`);

  const results = {
    started:   new Date().toISOString(),
    total,
    completed: 0,
    skipped:   0,
    errors:    [],
    questions: {},
  };

  for (let i = 0; i < questions.length; i++) {
    const [qid, meta] = questions[i];
    const progress    = `[${String(i + 1).padStart(3)}/${total}]`;

    log(`${progress} Starting  ${qid}: ${(meta.question || "").slice(0, 80)}`);

    let attempt = 0;
    let success = false;
    let lastError = null;

    while (attempt < 2 && !success) {
      attempt++;
      try {
        const claimFile = await orchestrate(qid, { mock: false, ensemble: true });
        const essay     = claimFile?.claims?.[0]?.text || "";
        const words     = countWords(essay);

        log(`${progress} ✓  ${qid}  ${words} words (attempt ${attempt})`);

        results.questions[qid] = {
          status:  "ok",
          words,
          attempt,
          edition: claimFile?.current_edition ?? null,
        };
        results.completed++;
        success = true;
      } catch (err) {
        lastError = err;
        log(`${progress} ✗  ${qid}  attempt ${attempt} FAILED: ${err.message}`);
        if (attempt < 2) {
          log(`${progress}    Retrying ${qid} in 15 s…`);
          await sleep(15000);
        }
      }
    }

    if (!success) {
      log(`${progress} SKIP ${qid} — both attempts failed: ${lastError?.message}`);
      results.questions[qid] = {
        status: "error",
        error:  lastError?.message ?? "unknown",
      };
      results.skipped++;
      results.errors.push({ qid, error: lastError?.message ?? "unknown" });
    }

    // Brief pause between questions to be polite to the API.
    if (i < questions.length - 1) await sleep(2000);
  }

  // ── Rebuild site ───────────────────────────────────────────────────────
  log("All questions processed. Rebuilding site…");
  await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "scripts", "build-v2.js")],
      { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) {
        log("Site rebuild complete. " + out.replace(/\n/g, " ").trim());
        results.siteRebuilt = true;
      } else {
        log(`Site rebuild FAILED (exit ${code}): ${out.replace(/\n/g, " ").trim()}`);
        results.siteRebuilt = false;
        results.siteRebuildError = out.trim();
      }
      resolve();
    });
  });

  // ── Summary ────────────────────────────────────────────────────────────
  results.finished = new Date().toISOString();
  const durationMin = (
    (new Date(results.finished) - new Date(results.started)) / 60000
  ).toFixed(1);

  const wordCounts = Object.values(results.questions)
    .filter((q) => q.status === "ok")
    .map((q) => q.words);
  const avgWords =
    wordCounts.length
      ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
      : 0;

  log("=== BATCH REFRESH COMPLETE ===");
  log(`  Total:     ${total}`);
  log(`  Completed: ${results.completed}`);
  log(`  Skipped:   ${results.skipped}`);
  log(`  Avg words: ${avgWords}`);
  log(`  Duration:  ${durationMin} min`);
  if (results.errors.length) {
    log(`  Failed QIDs: ${results.errors.map((e) => e.qid).join(", ")}`);
  }

  // Write JSON report.
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));
  log(`Report written to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error in batch-refresh:", err);
  process.exit(1);
});
