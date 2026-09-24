// build-monograph.js — Build a cohesive single-page monograph from v2 data.
//
// Reads:
//   - data/question-registry.json
//   - data/claims/*.json
//   - editions/ledger.json
// Writes:
//   - docs/monograph.html
//
// Usage:
//   node scripts/build-monograph.js

const fs = require("fs");
const path = require("path");
const { PATHS, readJSON } = require("./lib.js");
const { markdownToHTML, escapeHTML } = require("./render-claim.js");

const MONOGRAPH_TITLE = "Living Book — Monograph";
const OUTPUT_FILE = path.join(PATHS.root, "docs", "monograph.html");

function fail(message, extra = "") {
  const suffix = extra ? `\n${extra}` : "";
  console.error(`✗ ${message}${suffix}`);
  process.exit(1);
}

function ensureObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is missing or malformed (expected object).`);
  }
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} is missing or malformed (expected array).`);
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function naturalChapterSort(a, b) {
  const aNum = Number.isFinite(a.chapter_number) ? a.chapter_number : 999;
  const bNum = Number.isFinite(b.chapter_number) ? b.chapter_number : 999;
  if (aNum !== bNum) return aNum - bNum;
  return String(a.chapter).localeCompare(String(b.chapter));
}

function parseQuestionNumber(questionId) {
  const match = String(questionId || "").match(/q(\d+)/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function stripMarkdown(text) {
  return String(text || "")
    .replace(/`{1,3}[^`]*`{1,3}/g, " ")
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, " ")
    .replace(/\[[^\]]+\]\([^\)]*\)/g, " ")
    .replace(/[>#*_~\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stopWords() {
  return new Set([
    "a","about","after","again","against","all","also","an","and","any","are","as","at",
    "be","because","been","before","being","between","both","but","by","can","cannot","could",
    "do","does","doing","for","from","had","has","have","having","how","if","in","into","is",
    "it","its","itself","just","more","most","no","not","now","of","on","once","only","or",
    "other","our","out","over","should","so","some","such","than","that","the","their","them",
    "then","there","these","they","this","those","through","to","too","under","up","use","using",
    "very","was","we","what","when","where","which","while","who","why","will","with","within",
    "without","would","your","education","learning","students","student","teachers","teacher","schools",
    "school","ai"
  ]);
}

function extractKeywords(question, claimFile) {
  const keywords = new Set();

  for (const key of ["keywords", "categories", "tags"]) {
    const value = question[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) keywords.add(item.trim().toLowerCase());
      }
    }
  }

  const sw = stopWords();
  const combined = [question.question, claimFile.answer_summary]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const tokens = combined.match(/[a-z]{4,}/g) || [];
  for (const token of tokens) {
    if (!sw.has(token)) keywords.add(token);
    if (keywords.size >= 14) break;
  }

  keywords.add(String(question.chapter || "uncategorized").toLowerCase());
  return [...keywords];
}

function buildNarrativeTransition(prevClaim, currentClaim, sourceCount) {
  const prevReliability = prevClaim?.reliability || "unspecified";
  const currentReliability = currentClaim?.reliability || "unspecified";
  const sourcesText = sourceCount === 1 ? "1 source" : `${sourceCount} sources`;

  if (prevReliability === currentReliability) {
    return `This line of argument continues at the same reliability level (${escapeHTML(currentReliability)}), strengthening the thread with ${sourcesText}.`;
  }

  return `The narrative then shifts from a ${escapeHTML(prevReliability)} perspective to a ${escapeHTML(currentReliability)} perspective, widening the evidentiary lens through ${sourcesText}.`;
}

function sourceSortKey(source) {
  return [
    source.title || "",
    source.url || "",
    source.type || "",
    source.credibility || "",
  ].join("|").toLowerCase();
}

function collectEditionInfo(ledger) {
  const editions = Array.isArray(ledger.editions) ? ledger.editions : [];
  if (editions.length === 0) {
    return {
      latestEdition: 0,
      latestTimestamp: "n/a",
      totalEditions: 0,
    };
  }

  const latest = editions.reduce((best, item) => {
    const bestNum = Number(best.edition_number || 0);
    const nextNum = Number(item.edition_number || 0);
    return nextNum > bestNum ? item : best;
  }, editions[0]);

  return {
    latestEdition: Number(latest.edition_number || editions.length),
    latestTimestamp: latest.created_at || "n/a",
    totalEditions: editions.length,
  };
}

function main() {
  console.log("→ Loading registry, claims, and edition ledger...");

  const registry = readJSON(PATHS.registry, null);
  if (!registry) fail("Registry file not found.", `Expected: ${PATHS.registry}`);
  ensureObject(registry, "question-registry.json root");
  ensureArray(registry.questions, "question-registry.json.questions");

  const ledger = readJSON(PATHS.ledger, null);
  if (!ledger) fail("Ledger file not found.", `Expected: ${PATHS.ledger}`);
  ensureObject(ledger, "ledger.json root");
  ensureArray(ledger.editions, "ledger.json.editions");

  // Canonical monograph scope: chaptered questions (q001-q100 in current data).
  const activeChapteredQuestions = registry.questions
    .filter((q) => q && q.status === "active")
    .filter((q) => Number.isFinite(q.chapter_number) && Number.isFinite(q.position))
    .sort((a, b) => {
      const chapterDelta = Number(a.chapter_number) - Number(b.chapter_number);
      if (chapterDelta !== 0) return chapterDelta;
      const posDelta = Number(a.position) - Number(b.position);
      if (posDelta !== 0) return posDelta;
      return parseQuestionNumber(a.id) - parseQuestionNumber(b.id);
    });

  if (activeChapteredQuestions.length === 0) {
    fail("No chaptered active questions found in registry.");
  }

  const chapters = new Map();
  const questionData = [];
  const sourceMap = new Map();

  for (const question of activeChapteredQuestions) {
    if (!question.id || !question.question) {
      fail("Malformed question record in registry.", JSON.stringify(question, null, 2));
    }

    const claimPath = path.join(PATHS.claimsDir, `${question.id}.json`);
    if (!fs.existsSync(claimPath)) {
      fail(`Missing claim file for ${question.id}.`, `Expected: ${claimPath}`);
    }

    const claimFile = readJSON(claimPath, null);
    if (!claimFile) {
      fail(`Claim file for ${question.id} is malformed JSON.`, `Path: ${claimPath}`);
    }

    if (!Array.isArray(claimFile.claims)) {
      fail(`Claim file for ${question.id} has malformed claims array.`, `Path: ${claimPath}`);
    }

    const chapterKey = `${question.chapter_number}::${question.chapter}`;
    if (!chapters.has(chapterKey)) {
      chapters.set(chapterKey, {
        chapter_number: Number(question.chapter_number),
        chapter: question.chapter,
        questions: [],
      });
    }

    const questionKeywords = extractKeywords(question, claimFile);

    const activeClaims = claimFile.claims.filter((c) => c && c.reliability !== "deprecated");
    const claimsToUse = activeClaims.length > 0
      ? activeClaims
      : (claimFile.answer_summary ? [{
          claim_id: `${question.id}-summary`,
          text: claimFile.answer_summary,
          reliability: "emerging",
          sources: [],
        }] : []);

    const sources = [];
    for (const claim of claimFile.claims) {
      const claimSources = Array.isArray(claim.sources) ? claim.sources : [];
      for (const source of claimSources) {
        if (!source || typeof source !== "object") continue;
        const url = String(source.url || "").trim();
        if (!url) continue;

        const normalizedUrl = url.toLowerCase();
        const normalized = {
          title: String(source.title || url).trim(),
          url,
          type: String(source.type || "unknown").trim(),
          credibility: String(source.credibility || "unknown").trim(),
          retrieved: String(source.retrieved || "").trim(),
        };

        if (!sourceMap.has(normalizedUrl)) {
          sourceMap.set(normalizedUrl, normalized);
        }
        sources.push(normalizedUrl);
      }
    }

    const uniqueSources = [...new Set(sources)];

    const record = {
      ...question,
      claimFile,
      claimsToUse,
      sources: uniqueSources,
      keywords: questionKeywords,
    };

    chapters.get(chapterKey).questions.push(record);
    questionData.push(record);
  }

  const orderedChapters = [...chapters.values()].sort(naturalChapterSort);
  console.log(`✓ Loaded ${orderedChapters.length} chapters and ${questionData.length} questions.`);

  const bibliography = [...sourceMap.values()].sort((a, b) => {
    const ta = sourceSortKey(a);
    const tb = sourceSortKey(b);
    return ta.localeCompare(tb);
  });

  const bibliographyIdByUrl = new Map();
  bibliography.forEach((source, idx) => {
    bibliographyIdByUrl.set(source.url.toLowerCase(), `src-${String(idx + 1).padStart(3, "0")}`);
  });

  // Related-question graph: weighted overlap on chapter + keywords.
  const relatedMap = new Map();
  for (const question of questionData) {
    const related = [];
    const qSet = new Set(question.keywords);

    for (const other of questionData) {
      if (question.id === other.id) continue;
      const oSet = new Set(other.keywords);
      let overlap = 0;
      for (const kw of qSet) if (oSet.has(kw)) overlap++;

      if (question.chapter === other.chapter) overlap += 2;
      if (overlap > 1) {
        related.push({ id: other.id, question: other.question, score: overlap });
      }
    }

    related.sort((a, b) => b.score - a.score || parseQuestionNumber(a.id) - parseQuestionNumber(b.id));
    relatedMap.set(question.id, related.slice(0, 5));
  }

  // Cross-reference keyword index.
  const keywordIndex = new Map();
  for (const question of questionData) {
    for (const keyword of question.keywords) {
      const key = keyword.trim().toLowerCase();
      if (!key || key.length < 4) continue;
      if (!keywordIndex.has(key)) keywordIndex.set(key, new Set());
      keywordIndex.get(key).add(question.id);
    }
  }

  const keywordRows = [...keywordIndex.entries()]
    .map(([keyword, ids]) => ({ keyword, ids: [...ids].sort((a, b) => parseQuestionNumber(a) - parseQuestionNumber(b)) }))
    .filter((row) => row.ids.length >= 2)
    .sort((a, b) => b.ids.length - a.ids.length || a.keyword.localeCompare(b.keyword))
    .slice(0, 120);

  const editionInfo = collectEditionInfo(ledger);
  const generatedAt = new Date().toISOString();

  let tocHTML = "";
  let chapterHTML = "";

  for (const chapter of orderedChapters) {
    const chapterAnchor = `chapter-${String(chapter.chapter_number).padStart(2, "0")}`;
    tocHTML += `<li><a href="#${chapterAnchor}">Chapter ${chapter.chapter_number}. ${escapeHTML(chapter.chapter)}</a><ul>`;

    const chapterQuestions = chapter.questions
      .sort((a, b) => Number(a.position) - Number(b.position));

    for (const q of chapterQuestions) {
      tocHTML += `<li><a href="#${q.id}">${escapeHTML(q.id.toUpperCase())} — ${escapeHTML(q.question)}</a></li>`;
    }

    tocHTML += "</ul></li>";

    chapterHTML += `\n<section class="chapter" id="${chapterAnchor}">\n`;
    chapterHTML += `<h2>Chapter ${chapter.chapter_number}. ${escapeHTML(chapter.chapter)}</h2>`;
    chapterHTML += `<p class="chapter-intro">This chapter threads ${chapterQuestions.length} question${chapterQuestions.length === 1 ? "" : "s"} into a continuous argument, connecting established and emerging claims with shared evidence.</p>`;

    for (const question of chapterQuestions) {
      chapterHTML += `\n<article class="question" id="${question.id}">`;
      chapterHTML += `<h3><span class="qid">${escapeHTML(question.id.toUpperCase())}</span> ${escapeHTML(question.question)}</h3>`;

      const primaryClaimCount = question.claimsToUse.length;
      const primarySourcesCount = question.sources.length;
      chapterHTML += `<p class="narrative">This question is supported by ${primaryClaimCount} narrative claim${primaryClaimCount === 1 ? "" : "s"} and ${primarySourcesCount} distinct source${primarySourcesCount === 1 ? "" : "s"}, creating a bridge between conceptual framing and practical implications.</p>`;

      question.claimsToUse.forEach((claim, idx) => {
        const claimSources = Array.isArray(claim.sources) ? claim.sources : [];
        const claimSourceLinks = claimSources
          .map((source) => {
            const url = String(source?.url || "").toLowerCase();
            const bibId = bibliographyIdByUrl.get(url);
            if (!bibId) return null;
            return `<a href="#${bibId}">[${bibId.toUpperCase()}]</a>`;
          })
          .filter(Boolean);

        chapterHTML += `<section class="claim">`;
        chapterHTML += `<h4>Claim ${idx + 1}${claim.reliability ? ` <span class="badge">${escapeHTML(claim.reliability)}</span>` : ""}</h4>`;
        chapterHTML += markdownToHTML(String(claim.text || ""));
        if (claimSourceLinks.length) {
          chapterHTML += `<p class="citations">Sources: ${claimSourceLinks.join(" ")}</p>`;
        }
        chapterHTML += `</section>`;

        if (idx < question.claimsToUse.length - 1) {
          const transition = buildNarrativeTransition(claim, question.claimsToUse[idx + 1], claimSources.length);
          chapterHTML += `<p class="transition">${transition}</p>`;
        }
      });

      if (question.claimFile.disputed_aspects && question.claimFile.disputed_aspects.length > 0) {
        const disputedItems = question.claimFile.disputed_aspects
          .map((item) => `<li>${escapeHTML(item.summary || "Unspecified disputed aspect")}</li>`)
          .join("");
        chapterHTML += `<details class="disputed"><summary>Disputed aspects</summary><ul>${disputedItems}</ul></details>`;
      }

      const related = relatedMap.get(question.id) || [];
      if (related.length > 0) {
        chapterHTML += `<p class="related"><strong>Related questions:</strong> ${related
          .map((item) => `<a href="#${item.id}">${escapeHTML(item.id.toUpperCase())}</a>`)
          .join(", ")}</p>`;
      }

      chapterHTML += `</article>`;
    }

    chapterHTML += `\n</section>`;
  }

  const bibliographyHTML = bibliography
    .map((source, idx) => {
      const id = `src-${String(idx + 1).padStart(3, "0")}`;
      const safeURL = /^https?:\/\//i.test(source.url) ? escapeHTML(source.url) : "#";
      return `<li id="${id}"><span class="bib-id">[${id.toUpperCase()}]</span> <a href="${safeURL}">${escapeHTML(source.title)}</a> <span class="meta">(${escapeHTML(source.type)}, credibility: ${escapeHTML(source.credibility)}${source.retrieved ? `, retrieved: ${escapeHTML(source.retrieved)}` : ""})</span></li>`;
    })
    .join("\n");

  const crossRefHTML = keywordRows
    .map((row) => {
      const links = row.ids
        .map((id) => `<a href="#${id}">${escapeHTML(id.toUpperCase())}</a>`)
        .join(", ");
      return `<li><span class="term">${escapeHTML(row.keyword)}</span>: ${links}</li>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(MONOGRAPH_TITLE)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1b1f24;
      --muted: #5b6470;
      --line: #d6dde6;
      --paper: #f7f9fc;
      --accent: #1f5fbf;
      --accent-soft: #e7f0ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Georgia", "Times New Roman", serif;
      color: var(--ink);
      background: #ffffff;
      line-height: 1.62;
      font-size: 17px;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .page {
      max-width: 1080px;
      margin: 0 auto;
      padding: 2rem 1.25rem 4rem;
      display: grid;
      grid-template-columns: minmax(250px, 290px) 1fr;
      gap: 1.5rem;
    }
    .toc {
      position: sticky;
      top: 1rem;
      align-self: start;
      max-height: calc(100vh - 2rem);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 1rem;
      background: var(--paper);
      font-family: "Inter", "Segoe UI", sans-serif;
      font-size: 0.9rem;
    }
    .toc h2 { margin: 0 0 0.75rem; font-size: 1rem; }
    .toc ul { margin: 0; padding-left: 1.1rem; }
    .toc li { margin: 0.28rem 0; }
    .content {
      min-width: 0;
    }
    .title-block {
      border-bottom: 2px solid var(--line);
      padding-bottom: 1rem;
      margin-bottom: 1.5rem;
    }
    h1 {
      margin: 0;
      font-size: clamp(1.7rem, 3vw, 2.3rem);
      line-height: 1.2;
    }
    .subtitle {
      margin-top: 0.6rem;
      color: var(--muted);
      font-family: "Inter", "Segoe UI", sans-serif;
      font-size: 0.95rem;
    }
    .chapter {
      margin-top: 2.3rem;
      padding-top: 0.6rem;
      border-top: 1px solid var(--line);
    }
    h2 {
      margin: 0.2rem 0 0.8rem;
      font-size: 1.5rem;
    }
    .chapter-intro {
      color: var(--muted);
      margin-top: 0;
      font-family: "Inter", "Segoe UI", sans-serif;
      font-size: 0.95rem;
    }
    .question {
      margin: 1.5rem 0;
      padding: 1rem;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
    }
    h3 {
      margin: 0;
      font-size: 1.2rem;
      line-height: 1.35;
    }
    .qid {
      display: inline-block;
      margin-right: 0.35rem;
      color: var(--muted);
      font-family: "Inter", "Segoe UI", sans-serif;
      font-size: 0.85em;
      letter-spacing: 0.03em;
    }
    .narrative {
      margin: 0.8rem 0;
      color: #2b3037;
      font-style: italic;
    }
    .claim {
      margin-top: 0.9rem;
      padding-left: 0.8rem;
      border-left: 3px solid var(--accent-soft);
    }
    h4 {
      margin: 0.4rem 0 0.7rem;
      font-size: 1rem;
      font-family: "Inter", "Segoe UI", sans-serif;
    }
    .badge {
      display: inline-block;
      margin-left: 0.4rem;
      padding: 0.06rem 0.45rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: #244f99;
      font-size: 0.78rem;
      vertical-align: middle;
    }
    .citations,
    .transition,
    .related {
      font-family: "Inter", "Segoe UI", sans-serif;
      font-size: 0.89rem;
      color: var(--muted);
    }
    .transition {
      margin: 0.75rem 0 0.5rem;
      padding: 0.55rem 0.7rem;
      border-left: 3px solid var(--line);
      background: #fafbfd;
    }
    .disputed {
      margin-top: 0.7rem;
      padding: 0.5rem 0.8rem;
      border-radius: 8px;
      background: #fff6dc;
      border: 1px solid #f0d99f;
      font-family: "Inter", "Segoe UI", sans-serif;
      font-size: 0.9rem;
    }
    .endmatter {
      margin-top: 2.5rem;
      padding-top: 1rem;
      border-top: 2px solid var(--line);
    }
    .endmatter h2 {
      margin-top: 1.4rem;
    }
    .bibliography,
    .xref {
      padding-left: 1.2rem;
    }
    .bibliography li,
    .xref li {
      margin-bottom: 0.55rem;
    }
    .bib-id {
      color: var(--muted);
      font-family: "Inter", "Segoe UI", sans-serif;
      font-size: 0.83rem;
      margin-right: 0.3rem;
    }
    .meta {
      color: var(--muted);
      font-family: "Inter", "Segoe UI", sans-serif;
      font-size: 0.83rem;
    }
    .term {
      font-weight: 600;
      text-transform: capitalize;
    }
    @media (max-width: 940px) {
      .page { grid-template-columns: 1fr; }
      .toc { position: static; max-height: none; }
    }
  </style>
</head>
<body>
  <div class="page">
    <nav class="toc">
      <h2>Table of Contents</h2>
      <ul>${tocHTML}</ul>
      <hr>
      <ul>
        <li><a href="#bibliography">Unified Bibliography</a></li>
        <li><a href="#cross-reference-index">Cross-Reference Index</a></li>
      </ul>
    </nav>
    <main class="content">
      <header class="title-block">
        <h1>${escapeHTML(MONOGRAPH_TITLE)}</h1>
        <p class="subtitle">Generated ${escapeHTML(generatedAt)} · Latest edition ${editionInfo.latestEdition} (${escapeHTML(editionInfo.latestTimestamp)}) · Total editions ${editionInfo.totalEditions} · Questions in monograph ${questionData.length}</p>
      </header>
      ${chapterHTML}
      <section class="endmatter">
        <h2 id="bibliography">Unified Bibliography</h2>
        <p class="subtitle">Deduplicated from all claim sources across included questions (${bibliography.length} unique sources).</p>
        <ol class="bibliography">${bibliographyHTML}</ol>

        <h2 id="cross-reference-index">Cross-Reference Index</h2>
        <p class="subtitle">Keyword and thematic index linking related questions by chapter and extracted terms.</p>
        <ol class="xref">${crossRefHTML}</ol>
      </section>
    </main>
  </div>
</body>
</html>`;

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, html, "utf8");

  console.log(`✓ Built ${path.relative(PATHS.root, OUTPUT_FILE)}`);
  console.log(`  Included questions: ${questionData.length}`);
  console.log(`  Chapters: ${orderedChapters.length}`);
  console.log(`  Bibliography entries: ${bibliography.length}`);
  console.log(`  Cross-reference terms: ${keywordRows.length}`);
}

main();
