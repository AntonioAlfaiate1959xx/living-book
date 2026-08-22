// build-v2.js — Builds the GitHub Pages site from v2 data structures.
//
// This is the v2-aware version of build.js. It reads from:
//   - data/question-registry.json (instead of questions/questions.json)
//   - data/claims/qNNN.json (instead of answers/qNNN.json)
//   - editions/ledger.json (instead of changelog/changelog.json)
// and produces the same single-page HTML book in docs/index.html.
//
// Usage:
//   node scripts/build-v2.js

const fs = require("fs");
const path = require("path");
const { PATHS, readJSON } = require("./lib.js");
const { renderClaim, escapeHTML } = require("./render-claim.js");

const config = readJSON(path.join(PATHS.root, "book.config.json"), {
  title: "AI in Education — The State of the Art",
  subtitle: "A Living Book in One Hundred Questions",
  author: "António",
});

const registry = readJSON(PATHS.registry, null);
if (!registry) {
  console.error("✗ Registry not found. Run `npm run migrate` first.");
  process.exit(1);
}

const ledger = readJSON(PATHS.ledger, { editions: [] });

const today = new Date().toISOString().slice(0, 10);

// Group questions by chapter and sort by position.
const byChapter = new Map();
for (const q of registry.questions.filter((q) => q.status === "active")) {
  const ch = q.chapter || "Uncategorized";
  if (!byChapter.has(ch)) byChapter.set(ch, []);
  byChapter.get(ch).push(q);
}

// Sort chapters and questions within each chapter.
const chapterKeys = [...byChapter.keys()].sort((a, b) => {
  const aNum = typeof a === "string" ? parseInt(a.match(/\d+/)?.[0] || "999", 10) : a;
  const bNum = typeof b === "string" ? parseInt(b.match(/\d+/)?.[0] || "999", 10) : b;
  return aNum - bNum;
});

for (const ch of chapterKeys) {
  byChapter.get(ch).sort((a, b) => (a.position || 0) - (b.position || 0));
}

let body = "";
let toc = "";
let chapterIndex = 0;

for (const chKey of chapterKeys) {
  chapterIndex++;
  const questions = byChapter.get(chKey);
  const chapterTitle = escapeHTML(
    typeof chKey === "string" ? chKey.replace(/^Chapter \d+\.\s*/, "") : chKey
  );

  body += `<h2 id="ch${chapterIndex}">Chapter ${chapterIndex}. ${chapterTitle}</h2>\n`;
  toc += `<li><a href="#ch${chapterIndex}">Chapter ${chapterIndex}. ${chapterTitle}</a></li>\n`;

  for (const q of questions) {
    const claimFile = readJSON(
      path.join(PATHS.claimsDir, `${q.id}.json`),
      null
    );
    if (!claimFile) continue; // Skip unanswered questions.
    body += renderClaim(claimFile, { includeDisputed: true });
  }
}

// The edition ledger appendix — the book's intellectual history.
// Reads EVERY entry from editions/ledger.json (no truncation) and shows
// them in reverse-chronological order with the recorded change type and a
// brief description of what changed.
const CHANGE_LABELS = {
  initial: "First answer",
  no_change: "No change",
  minor_update: "Minor update",
  major_update: "Major update",
  new_source: "New source",
  source_removed: "Source removed",
};

let appendix =
  "<h2 id='ledger'>Appendix: How This Book Has Changed</h2>\n" +
  `<p>This appendix records all ${ledger.editions.length} edition(s) of the ` +
  "Living Book, showing which questions changed, how they changed, and the " +
  "evidence for each change. Each entry is immutable — the book's memory of " +
  "its own evolution.</p>\n";

for (const e of [...ledger.editions].reverse()) {
  const parts = [];
  if (e.questions_added?.length)
    parts.push(`added ${e.questions_added.join(", ")}`);
  if (e.questions_updated?.length)
    parts.push(`updated ${e.questions_updated.join(", ")}`);
  if (e.questions_deprecated?.length)
    parts.push(`deprecated ${e.questions_deprecated.join(", ")}`);
  const summary = parts.length ? parts.join("; ") : "no changes";

  const c = e.change;
  const dateStr = (e.created_at || "").slice(0, 10);

  let detail = "";
  if (c) {
    const label = CHANGE_LABELS[c.changeType] || c.changeType || "change";
    detail =
      `<br><strong>${escapeHTML(c.question || "")}</strong>` +
      `<br><em>Change: ${escapeHTML(label)}</em>` +
      (c.evidence ? `<br>${escapeHTML(c.evidence)}` : "");
  }

  appendix += `<p><strong>Edition ${e.edition_number} — ${dateStr} [${escapeHTML(
    e.author || ""
  )}]</strong><br>${escapeHTML(
    e.description || ""
  )}${detail}<br><em>${escapeHTML(summary)}</em></p>\n`;
}

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(config.title)}</title>
<style>
  body{max-width:44rem;margin:2rem auto;padding:0 1rem;
  font-family:Georgia,serif;line-height:1.65;color:#222}
  h1{font-size:2rem} h2{margin-top:3rem;border-bottom:1px solid #ccc}
  h3{margin-top:2.2rem} details{font-size:.9rem;color:#555;margin:.8rem 0}
  details.disputed{background:#fff3cd;border-left:3px solid #f90;padding:.5rem}
  .stamp{color:#777;font-style:italic}
  small{color:#666}
</style></head><body>
<h1>${escapeHTML(config.title)}</h1>
<p>${escapeHTML(config.subtitle)} — ${escapeHTML(config.author)}</p>
<p class="stamp">Living edition of ${today}. This book revises itself; the
appendix records every change it has ever made. Built from Edition ${
  ledger.editions.length
}.</p>
<ul>${toc}<li><a href="#ledger">Appendix: How This Book Has Changed</a></li></ul>
${body}
${appendix}
</body></html>`;

const docsDir = path.join(PATHS.root, "docs");
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(docsDir, "index.html"), html);
console.log(`✓ Built docs/index.html from v2 data — living edition of ${today}.`);
console.log(`  ${registry.questions.filter((q) => q.status === "active").length} active questions`);
console.log(`  ${chapterKeys.length} chapters`);
console.log(`  Edition ${ledger.editions.length}`);
