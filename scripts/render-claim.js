// render-claim.js — Convert a claim file into HTML sections for publishing.
//
// Takes a schema-valid claim file (from data/claims/qNNN.json) and produces
// the HTML sections ready to embed in the published book. This is the bridge
// between the v2 reliability-first data model and the reader-facing site.

const { RELIABILITY } = require("./lib.js");

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Minimal Markdown-to-HTML: **bold**, *italic*, paragraph breaks.
function markdownToHTML(text) {
  let html = escapeHTML(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  return html
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, " ")}</p>`)
    .join("\n");
}

function renderClaim(claimFile, { includeDisputed = true } = {}) {
  const question = escapeHTML(claimFile.question_text || "");
  const edition = claimFile.current_edition || 1;

  // Primary content: use the full text of the most recent non-deprecated claim.
  // Fall back to answer_summary only if no claim text is available.
  const activeClaims = (claimFile.claims || []).filter(
    (c) => c.reliability !== "deprecated"
  );
  const primaryClaim = activeClaims[activeClaims.length - 1] || null;
  const fullText =
    (primaryClaim && primaryClaim.text) ? primaryClaim.text : (claimFile.answer_summary || "");
  const answerHTML = markdownToHTML(fullText);

  // Collect all sources from all claims (dedupe by URL).
  const sourceURLs = new Set();
  const allSources = [];
  for (const c of claimFile.claims || []) {
    for (const s of c.sources || []) {
      if (s.url && !sourceURLs.has(s.url)) {
        sourceURLs.add(s.url);
        allSources.push(s);
      }
    }
  }
  // Sort by credibility (high first) then type.
  const order = { high: 0, medium: 1, low: 2 };
  allSources.sort((a, b) => {
    const ca = order[a.credibility] ?? 9;
    const cb = order[b.credibility] ?? 9;
    if (ca !== cb) return ca - cb;
    return (a.type || "").localeCompare(b.type || "");
  });

  const sourcesHTML = allSources
    .map((s) => {
      const badge =
        s.credibility === "high"
          ? " <small>[high credibility]</small>"
          : s.credibility === "low"
          ? " <small>[low credibility]</small>"
          : "";
      // Sanitize URL: only allow http/https, escape for HTML attribute.
      const url = String(s.url || "");
      const safeURL = /^https?:\/\//i.test(url) ? escapeHTML(url) : "#";
      return `<li><a href="${safeURL}">${escapeHTML(s.title)}</a> <em>(${
        s.type
      })</em>${badge}</li>`;
    })
    .join("\n");

  // If there are disputed aspects, surface them prominently.
  let disputedHTML = "";
  if (includeDisputed && claimFile.disputed_aspects?.length > 0) {
    const items = claimFile.disputed_aspects
      .map((d) => {
        let url = "";
        if (d.source_url) {
          const safeURL = /^https?:\/\//i.test(d.source_url)
            ? escapeHTML(d.source_url)
            : "#";
          url = ` (<a href="${safeURL}">source</a>)`;
        }
        return `<li>${escapeHTML(d.summary)}${url}</li>`;
      })
      .join("\n");
    disputedHTML = `<details class="disputed"><summary>⚠ Disputed Aspects</summary>
    <p>The following claims have conflicting evidence and are flagged for editorial review:</p>
    <ul>${items}</ul></details>`;
  }

  // Assemble the section.
  return `
  <section>
    <h3>${question}</h3>
    ${answerHTML}
    ${disputedHTML}
    <details><summary>Sources (edition ${edition}, ${allSources.length} source${
    allSources.length !== 1 ? "s" : ""
  })</summary>
    <ul>${sourcesHTML}</ul></details>
  </section>`;
}

module.exports = { renderClaim, markdownToHTML, escapeHTML };
