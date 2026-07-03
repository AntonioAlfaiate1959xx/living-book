// build.js — Turns the answer database into a complete one-page book
// website, written into docs/ (the folder GitHub Pages publishes).

const fs = require("fs");
const path = require("path");

const config = JSON.parse(fs.readFileSync("book.config.json", "utf8"));
const questions = JSON.parse(
  fs.readFileSync(path.join("questions", "questions.json"), "utf8")
);
const changelog = fs.existsSync("changelog/changelog.json")
  ? JSON.parse(fs.readFileSync("changelog/changelog.json", "utf8"))
  : [];

// Protect against stray characters breaking the page.
function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Minimal formatting: blank lines in the answer become paragraph breaks.
function toParagraphs(text) {
  return text.split(/\n\s*\n/).map((p) => `<p>${escapeHTML(p)}</p>`).join("\n");
}

// Sort questions into reading order: by chapter, then position.
const ordered = [...questions].sort(
  (a, b) => a.chapter - b.chapter || a.position - b.position
);

const today = new Date().toISOString().slice(0, 10);
let body = "", toc = "", currentChapter = null;

for (const q of ordered) {
  const file = path.join("answers", `${q.id}.json`);
  if (!fs.existsSync(file)) continue; // Skip questions not yet answered.
  const a = JSON.parse(fs.readFileSync(file, "utf8"));

  if (q.chapter !== currentChapter) {
    currentChapter = q.chapter;
    body += `<h2 id="ch${q.chapter}">Chapter ${q.chapter}. ${escapeHTML(q.chapterTitle)}</h2>\n`;
    toc += `<li><a href="#ch${q.chapter}">Chapter ${q.chapter}. ${escapeHTML(q.chapterTitle)}</a></li>\n`;
  }
  const srcs = a.sources
    .map((s) => `<li><a href="${s.url}">${escapeHTML(s.title)}</a></li>`)
    .join("\n");
  body += `
  <section>
    <h3>${escapeHTML(q.question)}</h3>
    ${toParagraphs(a.answer)}
    <details><summary>Sources (updated ${a.lastUpdated})</summary>
    <ul>${srcs}</ul></details>
  </section>`;
}

// The changelog appendix — the book's intellectual history.
let appendix = "<h2 id='changelog'>Appendix: How This Book Has Changed</h2>\n";
for (const entry of [...changelog].reverse()) {
  appendix += `<p><strong>${entry.date} — ${entry.id} [${entry.verdict}]</strong><br>${escapeHTML(entry.justification)}</p>\n`;
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
  .stamp{color:#777;font-style:italic}
</style></head><body>
<h1>${escapeHTML(config.title)}</h1>
<p>${escapeHTML(config.subtitle)} — ${escapeHTML(config.author)}</p>
<p class="stamp">Living edition of ${today}. This book revises itself; the
appendix records every change it has ever made.</p>
<ul>${toc}<li><a href="#changelog">Appendix: How This Book Has Changed</a></li></ul>
${body}
${appendix}
</body></html>`;

fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync(path.join("docs", "index.html"), html);
console.log(`Built docs/index.html — living edition of ${today}.`);
