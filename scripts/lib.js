// lib.js — Shared helpers for the Living Book v2 tooling.
// Pure Node.js built-ins only (no external dependencies).
//
// This module centralises path resolution, safe JSON I/O, source
// classification, and schema validation so that the migration,
// orchestration, and proposal scripts all agree on one source of truth.

const fs = require("fs");
const path = require("path");

// ── Repository roots ────────────────────────────────────────────────
// Resolve everything relative to the repo root (the parent of /scripts),
// so the scripts work regardless of the current working directory.
const ROOT = path.resolve(__dirname, "..");

const PATHS = {
  root: ROOT,
  legacyQuestions: path.join(ROOT, "questions", "questions.json"),
  legacyAnswersDir: path.join(ROOT, "answers"),
  dataDir: path.join(ROOT, "data"),
  claimsDir: path.join(ROOT, "data", "claims"),
  registry: path.join(ROOT, "data", "question-registry.json"),
  graph: path.join(ROOT, "data", "graph.json"),
  editionsDir: path.join(ROOT, "editions"),
  ledger: path.join(ROOT, "editions", "ledger.json"),
  logsDir: path.join(ROOT, "logs"),
  orchestrationLog: path.join(ROOT, "logs", "orchestration.log"),
};

// ── Safe JSON I/O ───────────────────────────────────────────────────
function readJSON(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Trailing newline keeps diffs and POSIX tooling happy.
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

// ── Dates ───────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}
function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); // "...:SSZ"
}

// ── Source classification ───────────────────────────────────────────
// Best-effort mapping from a URL to a source "type" and "credibility".
// These are heuristics used only to seed the new schema during migration;
// editors can refine them later.
function classifySource(url = "") {
  const u = String(url).toLowerCase();

  // Academic / peer-reviewed / preprint venues.
  if (
    /arxiv\.org|springer|link\.springer|nature\.com|frontiersin|sciencedirect|ieee|acm\.org|tandfonline|wiley|sagepub|jstor|researchgate|ssrn|\.edu(\/|$)|doi\.org|scholar/.test(
      u
    )
  ) {
    return { type: "academic", credibility: "high" };
  }

  // Official government / intergovernmental / institutional sources.
  if (
    /\.gov(\/|$|\.)|europa\.eu|whitehouse\.gov|ec\.europa|un\.org|unesco|oecd\.org|\.int(\/|$)|eursc\.eu|nea\.org|ed\.gov|ai\.gov|gov\.cn|scio\.gov/.test(
      u
    )
  ) {
    return { type: "official", credibility: "high" };
  }

  // Recognisable news / press outlets.
  if (
    /globaltimes|thehill|nytimes|washingtonpost|theguardian|bbc\.|reuters|bloomberg|forbes|wired|techcrunch|cnn\.|ecns\.cn|news/.test(
      u
    )
  ) {
    return { type: "news", credibility: "medium" };
  }

  // Everything else: blogs, vendor pages, practitioner resources.
  return { type: "practitioner", credibility: "medium" };
}

// ── Small text helpers ──────────────────────────────────────────────
// Produce a short plain-text summary from a (possibly Markdown) answer.
function summarise(answerText = "", maxLen = 400) {
  const plain = String(answerText)
    .replace(/\r/g, "")
    .replace(/^#{1,6}\s+.*$/gm, "") // drop heading lines
    .replace(/[*_`>#-]+/g, " ") // strip markdown punctuation
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxLen) return plain;
  // Cut on a sentence boundary when possible.
  const slice = plain.slice(0, maxLen);
  const lastStop = slice.lastIndexOf(". ");
  return (lastStop > 100 ? slice.slice(0, lastStop + 1) : slice).trim();
}

function padId(n) {
  return "q" + String(n).padStart(3, "0");
}

// ── Change detection ────────────────────────────────────────────────
// Truncate a string to a maximum length, appending an ellipsis marker.
function truncate(text = "", maxLen = 500) {
  const s = String(text || "");
  return s.length <= maxLen ? s : s.slice(0, maxLen).trimEnd() + "…";
}

// Normalise answer text for comparison: strip markdown punctuation,
// collapse whitespace, and lowercase so trivial formatting differences
// do not register as content changes.
function normaliseForCompare(text = "") {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[*_`>#|]+/g, " ")
    .replace(/https?:\/\/[^\s)"']+/g, " ") // URLs compared separately
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Word-level Jaccard similarity in [0,1]; 1 = identical word sets.
function textSimilarity(a = "", b = "") {
  const wa = new Set(normaliseForCompare(a).split(" ").filter(Boolean));
  const wb = new Set(normaliseForCompare(b).split(" ").filter(Boolean));
  if (wa.size === 0 && wb.size === 0) return 1;
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 1 : inter / union;
}

// Find a short evidence snippet describing what changed: the first place
// where the new answer diverges from the old one (first ~200 chars).
function changeEvidence(oldText = "", newText = "", maxLen = 200) {
  const o = String(oldText || "");
  const n = String(newText || "");
  if (!o) return truncate(n.replace(/\s+/g, " ").trim(), maxLen);
  // Find the first differing character index.
  let i = 0;
  const min = Math.min(o.length, n.length);
  while (i < min && o[i] === n[i]) i++;
  // Back up to the start of the word/sentence for readability.
  let start = i;
  while (start > 0 && !/\s/.test(n[start - 1])) start--;
  const snippet = n.slice(start).replace(/\s+/g, " ").trim();
  if (snippet) return truncate(snippet, maxLen);
  return truncate(n.replace(/\s+/g, " ").trim(), maxLen);
}

// Classify a change between an old and a new answer.
// Returns { changeType, evidence, addedSources, removedSources, similarity }.
// changeType is one of:
//   "initial"       — there was no prior answer
//   "no_change"     — content identical (ignoring formatting) and same sources
//   "minor_update"  — wording changed but same key facts and sources
//   "major_update"  — key facts or conclusion changed substantially
//   "new_source"    — a new source URL appeared (no major text change)
//   "source_removed"— a source was removed (no major text change)
function classifyChange(oldText, newText, oldSources = [], newSources = []) {
  const oldUrls = new Set(
    (oldSources || []).map((s) => (typeof s === "string" ? s : s && s.url)).filter(Boolean)
  );
  const newUrls = new Set(
    (newSources || []).map((s) => (typeof s === "string" ? s : s && s.url)).filter(Boolean)
  );
  const addedSources = [...newUrls].filter((u) => !oldUrls.has(u));
  const removedSources = [...oldUrls].filter((u) => !newUrls.has(u));

  if (oldText == null || oldText === "") {
    return {
      changeType: "initial",
      evidence: changeEvidence("", newText),
      addedSources,
      removedSources,
      similarity: 0,
    };
  }

  const similarity = textSimilarity(oldText, newText);
  const identicalText = normaliseForCompare(oldText) === normaliseForCompare(newText);

  let changeType;
  if (identicalText && addedSources.length === 0 && removedSources.length === 0) {
    changeType = "no_change";
  } else if (!identicalText && similarity < 0.85) {
    changeType = "major_update";
  } else if (addedSources.length > 0) {
    changeType = "new_source";
  } else if (removedSources.length > 0) {
    changeType = "source_removed";
  } else {
    changeType = "minor_update";
  }

  let evidence;
  if (changeType === "no_change") {
    evidence = "No substantive change; content and sources are unchanged.";
  } else if (changeType === "new_source") {
    evidence = "New source(s): " + truncate(addedSources.join(", "), 180);
  } else if (changeType === "source_removed") {
    evidence = "Removed source(s): " + truncate(removedSources.join(", "), 180);
  } else {
    evidence = changeEvidence(oldText, newText);
  }

  return { changeType, evidence, addedSources, removedSources, similarity };
}

// ── Schema validation ───────────────────────────────────────────────
// Returns an array of human-readable error strings; empty array = valid.
const RELIABILITY = ["established", "emerging", "disputed", "deprecated"];
const SOURCE_TYPES = ["academic", "news", "official", "practitioner"];
const CREDIBILITY = ["high", "medium", "low"];
const REGISTRY_STATUS = ["active", "deprecated", "proposed"];

function validateClaimFile(obj, label = "claim") {
  const errors = [];
  const req = (cond, msg) => {
    if (!cond) errors.push(`[${label}] ${msg}`);
  };

  req(obj && typeof obj === "object", "not an object");
  if (!obj || typeof obj !== "object") return errors;

  req(typeof obj.question_id === "string", "question_id must be a string");
  req(typeof obj.question_text === "string", "question_text must be a string");
  req(
    Number.isInteger(obj.current_edition),
    "current_edition must be an integer"
  );
  req(Array.isArray(obj.claims), "claims must be an array");
  req(typeof obj.answer_summary === "string", "answer_summary must be a string");
  req(Array.isArray(obj.disputed_aspects), "disputed_aspects must be an array");

  if (Array.isArray(obj.claims)) {
    obj.claims.forEach((c, i) => {
      const cl = `${label}.claims[${i}]`;
      req(typeof c.claim_id === "string", `${cl}.claim_id must be a string`);
      req(typeof c.text === "string", `${cl}.text must be a string`);
      req(
        RELIABILITY.includes(c.reliability),
        `${cl}.reliability must be one of ${RELIABILITY.join("|")}`
      );
      req(Array.isArray(c.sources), `${cl}.sources must be an array`);
      req(Array.isArray(c.perspectives), `${cl}.perspectives must be an array`);
      req(
        typeof c.last_verified === "string",
        `${cl}.last_verified must be a string`
      );
      req(Number.isInteger(c.added_edition), `${cl}.added_edition must be int`);
      if (Array.isArray(c.sources)) {
        c.sources.forEach((s, j) => {
          const sl = `${cl}.sources[${j}]`;
          req(typeof s.url === "string" && s.url, `${sl}.url must be a string`);
          req(typeof s.title === "string", `${sl}.title must be a string`);
          req(
            SOURCE_TYPES.includes(s.type),
            `${sl}.type must be one of ${SOURCE_TYPES.join("|")}`
          );
          req(
            typeof s.retrieved === "string",
            `${sl}.retrieved must be a string`
          );
          req(
            CREDIBILITY.includes(s.credibility),
            `${sl}.credibility must be one of ${CREDIBILITY.join("|")}`
          );
        });
      }
    });
  }
  return errors;
}

function validateRegistryEntry(entry, label = "entry") {
  const errors = [];
  const req = (cond, msg) => {
    if (!cond) errors.push(`[${label}] ${msg}`);
  };
  req(typeof entry.id === "string", "id must be a string");
  req(
    REGISTRY_STATUS.includes(entry.status),
    `status must be one of ${REGISTRY_STATUS.join("|")}`
  );
  req(typeof entry.chapter === "string", "chapter must be a string");
  req(typeof entry.question === "string", "question must be a string");
  req(typeof entry.rationale === "string", "rationale must be a string");
  // Active/deprecated questions carry an integer edition; a "proposed"
  // question has no edition yet (null) until it is approved and answered.
  req(
    entry.added_in_edition === null || Number.isInteger(entry.added_in_edition),
    "added_in_edition must be null or an integer"
  );
  req(
    entry.deprecated_in_edition === null ||
      Number.isInteger(entry.deprecated_in_edition),
    "deprecated_in_edition must be null or an integer"
  );
  req(
    entry.superseded_by === null || typeof entry.superseded_by === "string",
    "superseded_by must be null or a string"
  );
  return errors;
}

module.exports = {
  PATHS,
  readJSON,
  writeJSON,
  today,
  nowISO,
  classifySource,
  summarise,
  padId,
  truncate,
  normaliseForCompare,
  textSimilarity,
  changeEvidence,
  classifyChange,
  validateClaimFile,
  validateRegistryEntry,
  RELIABILITY,
  SOURCE_TYPES,
  CREDIBILITY,
  REGISTRY_STATUS,
};
