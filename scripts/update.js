// update.js — Runs on a schedule. For each question: get a current answer
// from Claude (with web search), compare it to the stored answer, and only
// accept genuine change. Reversals are quarantined for human review.

const fs = require("fs"); // Built-in: reading and writing files.
const path = require("path"); // Built-in: joining folder + file names safely.

// ── 1. LOAD CONFIGURATION AND STATE ─────────────────────────────────
const config = JSON.parse(fs.readFileSync("book.config.json", "utf8"));
const questions = JSON.parse(
  fs.readFileSync(path.join("questions", "questions.json"), "utf8")
);
const prompts = require("./prompts.js");

// The API key arrives through an "environment variable": a value handed to
// the program from outside, so the secret never appears in the code itself.
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is not set. Aborting.");
  process.exit(1); // Stop immediately; nothing has been modified.
}

// ── 2. ONE FUNCTION THAT TALKS TO THE ANTHROPIC API ────────────────
async function callClaude(body) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// ── 3. CALL 1: GET A CURRENT ANSWER, WITH WEB SEARCH ────────────────
async function getCurrentAnswer(question) {
  const data = await callClaude({
    model: config.model,
    max_tokens: 2000,
    system: prompts.answerSystem(config.voicePrompt),
    messages: [{ role: "user", content: prompts.answerUser(question) }],
    // This block gives Claude a real search engine for this request:
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: config.maxSearchesPerQuestion,
      },
    ],
  });

  // The response is a list of blocks (text, search activity, citations).
  // We assemble the answer text and collect every cited source.
  let text = "";
  const sources = [];
  for (const block of data.content) {
    if (block.type === "text") {
      text += block.text;
      // Citations ride along on text blocks; harvest title + URL.
      for (const c of block.citations || []) {
        if (c.url && !sources.some((s) => s.url === c.url)) {
          sources.push({ title: c.title || c.url, url: c.url });
        }
      }
    }
  }

  // SAFEGUARD: an answer without a single source is rejected outright.
  if (sources.length === 0) {
    throw new Error("Answer had no cited sources — rejected by safeguard.");
  }
  return { text: text.trim(), sources };
}

// ── 4. CALL 2: THE CHANGE DETECTOR ──────────────────────────────────
async function detectChange(oldAnswer, newAnswer) {
  const data = await callClaude({
    model: config.model,
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: prompts.changeDetectionPrompt(oldAnswer, newAnswer),
      },
    ],
    // Deliberately NO tools: comparison must not invent new information.
  });

  // Extract the text and parse the JSON verdict. If the model wrapped it
  // in code fences despite instructions, strip them before parsing.
  const raw = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();
  const verdict = JSON.parse(raw);

  // SAFEGUARD: a change without a justification is not accepted.
  if (!["A", "B", "C"].includes(verdict.verdict) || !verdict.justification) {
    throw new Error("Malformed change-detection verdict — rejected.");
  }
  return verdict;
}

// ── 5. SMALL HELPERS FOR READING/WRITING STATE ──────────────────────
function readJSON(file, fallback) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : fallback;
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ── 6. THE MAIN LOOP ────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().slice(0, 10); // e.g. "2026-07-02"
  const changelog = readJSON(path.join("changelog", "changelog.json"), []);
  const pending = readJSON(path.join("review", "pending.json"), []);
  let updated = 0, unchanged = 0, flagged = 0, failed = 0;

  for (const q of questions) {
    const answerFile = path.join("answers", `${q.id}.json`);
    try {
      console.log(`\n[${q.id}] ${q.question.slice(0, 70)}...`);
      const fresh = await getCurrentAnswer(q.question);
      const stored = readJSON(answerFile, null);

      if (!stored) {
        // FIRST RUN for this question: nothing to compare — just save.
        writeJSON(answerFile, {
          id: q.id, question: q.question,
          answer: fresh.text, sources: fresh.sources,
          lastUpdated: today, lastChecked: today, history: [],
        });
        changelog.push({
          date: today, id: q.id, verdict: "INITIAL",
          justification: "First answer generated.",
        });
        q.lastUpdated = today;
        updated++;
        continue;
      }

      // NORMAL RUN: ask the change detector for a verdict.
      const verdict = await detectChange(stored.answer, fresh.text);
      console.log(`  Verdict: ${verdict.verdict}`);

      if (verdict.verdict === "A") {
        // No substantive change: keep the old answer, note we checked.
        stored.lastChecked = today;
        writeJSON(answerFile, stored);
        unchanged++;
      } else if (verdict.verdict === "B") {
        // Facts updated: archive the old answer, publish the new one.
        stored.history.push({
          replacedOn: today,
          previousAnswer: stored.answer,
          justification: verdict.justification,
        });
        stored.answer = fresh.text;
        stored.sources = fresh.sources;
        stored.lastUpdated = today;
        stored.lastChecked = today;
        writeJSON(answerFile, stored);
        changelog.push({
          date: today, id: q.id, verdict: "B",
          justification: verdict.justification,
          sources: fresh.sources,
        });
        q.lastUpdated = today;
        q.timesChanged += 1;
        updated++;
      } else {
        // Verdict "C" — conclusion reversed. Do NOT publish automatically.
        // Quarantine for human review; the live book keeps the old answer.
        pending.push({
          date: today, id: q.id, question: q.question,
          currentAnswer: stored.answer,
          proposedAnswer: fresh.text,
          proposedSources: fresh.sources,
          justification: verdict.justification,
        });
        changelog.push({
          date: today, id: q.id, verdict: "C-FLAGGED",
          justification: verdict.justification,
        });
        flagged++;
      }
    } catch (err) {
      // FAIL-SAFE: one question failing never corrupts the rest.
      console.error(`  FAILED: ${err.message}`);
      failed++;
    }
    // Small pause between questions to be polite to the API.
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ── 7. SAVE THE BOOKKEEPING ──────────────────────────────────────
  writeJSON(path.join("changelog", "changelog.json"), changelog);
  writeJSON(path.join("review", "pending.json"), pending);
  writeJSON(path.join("questions", "questions.json"), questions);
  console.log(
    `\nDone. Updated: ${updated} | Unchanged: ${unchanged} | ` +
    `Flagged for review: ${flagged} | Failed: ${failed}`
  );
}

main();
