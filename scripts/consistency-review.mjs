#!/usr/bin/env node
// consistency-review.mjs — Canon & Consistency Review layer (Stage 6.5).
//
// This is an ADDITIVE, NON-BLOCKING pipeline stage. It sits between Stage 6
// (Harmonize — voice charter / coherence pass) and Stage 7 (Verify refs) of
// the Living Book update cycle. It NEVER halts the pipeline: every error and
// every detected dispute is quarantined and logged, and the process always
// exits 0.
//
// It implements two of the patented components (see the Living Book system
// map and patent FIG. 1–4):
//
//   1. Claim-Node Builder (FIG. 3)
//        collect claim inputs from provenance data & manifests
//        → normalize claim text; derive stable source IDs from URLs
//        → merge inputs per (questionId, normalized text)
//        → infer confidence from supporting-source count
//        → load existing claim nodes for the question
//        → if text/provenance changed: increment version + write updated node
//          else if new: create new node claims/<qid>/<clm>.json
//        → persist versioned claim-node store (old versions are archived,
//          never overwritten).
//
//   2. Contradiction-Detection Engine (FIG. 4)
//        load claim nodes grouped by questionId
//        → tokenize; remove stopwords; extract content words
//        → for each claim pair: compute Jaccard overlap
//        → if topical overlap >= gate: assess pair for antonym conflict OR
//          negation-polarity difference
//        → if contradiction indicated: set contradictionStatus=suspected,
//          disputeStatus=open, record contradicts[]; write dispute + report;
//          flag for human review
//        → else: leave nodes unchanged (no halt).
//
// The claim-node record schema follows patent FIG. 2 (see
// claims/claim-node.schema.json).
//
// Usage:
//   node scripts/consistency-review.mjs
//   CONSISTENCY_GATE=0.4 node scripts/consistency-review.mjs   # tune the gate
//
// Output:
//   claims/<qid>/<clm>.json                  versioned claim nodes
//   claims/<qid>/versions/<clm>.v<n>.json    archived prior versions
//   claims/disputes/<timestamp>-<qid>.json   dispute records
//   reports/consistency-<YYYY-MM-DD>.md      human-readable run report
//   quarantine/consistency-quarantine-*.json quarantined errors (on failure)
//
// Pure Node.js built-ins (uuid is used opportunistically if installed, with a
// crypto.randomUUID() fallback so the stage runs in CI without npm install).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Paths ────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const PATHS = {
  root: ROOT,
  questions: path.join(ROOT, "questions", "questions.json"),
  v2ClaimsDir: path.join(ROOT, "data", "claims"), // provenance-bearing manifests
  answersDir: path.join(ROOT, "answers"), // legacy fallback
  claimsDir: path.join(ROOT, "claims"), // NEW versioned claim-node store
  disputesDir: path.join(ROOT, "claims", "disputes"),
  reportsDir: path.join(ROOT, "reports"),
  quarantineDir: path.join(ROOT, "quarantine"),
};

// Topical-overlap gate for contradiction detection (configurable).
const GATE = Number(process.env.CONSISTENCY_GATE || "0.35");
// Cap on assertion-claims extracted per question, keeps the store reviewable.
const MAX_CLAIMS_PER_QUESTION = Number(process.env.CONSISTENCY_MAX_CLAIMS || "10");

// ── Safe I/O helpers ─────────────────────────────────────────────────
function readJSON(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function fsStamp() {
  // Filesystem-safe ISO timestamp for filenames.
  return nowISO().replace(/[:]/g, "-");
}

// ── UUID (uuid v4 if available, else built-in crypto) ────────────────
let uuidv4 = () => crypto.randomUUID();
try {
  const mod = await import("uuid");
  if (mod && typeof mod.v4 === "function") uuidv4 = mod.v4;
} catch {
  // uuid not installed — crypto.randomUUID() (Node >= 14.17) is the fallback.
}
function newClaimId() {
  return "clm-" + uuidv4();
}

// Stable source ID = first 12 hex chars of sha256(url). Deterministic across
// runs so the same URL always maps to the same sourceId (FIG. 3).
function stableSourceId(url = "") {
  return "src-" + crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 12);
}

// ── Text processing ──────────────────────────────────────────────────
const STOPWORDS = new Set(
  ("a an the and or but if then else of to in on at by for with from as is are was were be " +
    "been being it its this that these those there here their our your his her they them we you i " +
    "he she who whom whose which what when where why how can could should would may might will shall " +
    "do does did done have has had having not no nor only own same so than too very just about into " +
    "over under again further once more most less least such both each few other some any all up down " +
    "out off above below between through during before after because while also however therefore thus " +
    "them us me my mine ours yours theirs itself themselves")
    .split(/\s+/)
);

function tokenizeContent(text = "") {
  const out = new Set();
  for (const raw of String(text).toLowerCase().split(/[^a-z]+/)) {
    if (raw.length <= 2 || STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function normalizeClaimText(text = "") {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim()
    .toLowerCase();
}

// Negation / polarity vocabulary.
const NEGATION_WORDS = new Set(
  ("not no never none cannot without less fewer decreases decrease reduces reduce reduced declines " +
    "decline declining worsens worsen worse lower lowers lowest fails fail failing unable neither nor " +
    "diminish diminishes weaken weakens undermine undermines harms harm hurts hurt")
    .split(/\s+/)
);

// Antonym pairs: if one claim uses the left word and the other uses the right
// word (on a topically-overlapping pair), that indicates a possible conflict.
const ANTONYM_PAIRS = [
  ["increase", "decrease"], ["increases", "decreases"], ["increasing", "decreasing"],
  ["improve", "worsen"], ["improves", "worsens"], ["improved", "worsened"],
  ["benefit", "harm"], ["benefits", "harms"], ["beneficial", "harmful"],
  ["more", "less"], ["higher", "lower"], ["rise", "fall"], ["rises", "falls"],
  ["rising", "falling"], ["gain", "loss"], ["gains", "losses"],
  ["help", "hurt"], ["helps", "hurts"], ["expand", "shrink"], ["expands", "shrinks"],
  ["strengthen", "weaken"], ["strengthens", "weakens"],
  ["enhance", "diminish"], ["enhances", "diminishes"],
  ["support", "oppose"], ["supports", "opposes"], ["accelerate", "slow"],
  ["boost", "reduce"], ["boosts", "reduces"], ["positive", "negative"],
];

function wordSet(text = "") {
  return new Set(String(text).toLowerCase().split(/[^a-z]+/).filter(Boolean));
}
function hasNegation(words) {
  for (const w of NEGATION_WORDS) if (words.has(w)) return true;
  return false;
}

// Assess a claim pair for a contradiction indicator (FIG. 4).
// Returns { indicated, reason } — reason is "antonym" | "negation" | null.
function assessPair(textA, textB) {
  const wa = wordSet(textA);
  const wb = wordSet(textB);

  // Antonym conflict: A has one side of a pair, B has the other.
  for (const [x, y] of ANTONYM_PAIRS) {
    if ((wa.has(x) && wb.has(y)) || (wa.has(y) && wb.has(x))) {
      return { indicated: true, reason: "antonym", detail: `${x} / ${y}` };
    }
  }

  // Negation-polarity difference: exactly one of the two claims is negated.
  const negA = hasNegation(wa);
  const negB = hasNegation(wb);
  if (negA !== negB) {
    return { indicated: true, reason: "negation", detail: negA ? "A negated, B affirmed" : "B negated, A affirmed" };
  }

  return { indicated: false, reason: null, detail: null };
}

// Split answer prose into candidate assertion sentences. Only substantive
// sentences that carry a polarity / modal / evaluative signal are kept, since
// those are the ones relevant to contradiction detection. Deterministic.
const SIGNAL_RE =
  /\b(increase|decrease|improv|worsen|benefit|harm|more|less|higher|lower|rise|fall|gain|loss|help|hurt|expand|shrink|strengthen|weaken|enhance|diminish|reduc|boost|accelerat|not|never|cannot|must|should|essential|require|replace|outperform|threat|risk|advantage|positive|negative|support|oppose)\b/i;

function extractAssertions(answerText = "") {
  const plain = String(answerText)
    .replace(/\r/g, "")
    .replace(/^#{1,6}\s+.*$/gm, " ") // drop markdown headings
    .replace(/```[\s\S]*?```/g, " ") // drop code fences
    .replace(/[*_`>#|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const sentences = plain
    .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 400 && /[a-z]/.test(s) && SIGNAL_RE.test(s));

  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    const key = normalizeClaimText(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_CLAIMS_PER_QUESTION) break;
  }
  return out;
}

function confidenceFrom(sourceCount) {
  const score = Math.min(1.0, Number((sourceCount * 0.33).toFixed(2)));
  let level = "low";
  if (score >= 0.7) level = "high";
  else if (score >= 0.4) level = "medium";
  return { score, level };
}

// ── Input collection (FIG. 3, step 310) ──────────────────────────────
// Collect provenance-bearing inputs for a question from the richest source
// available: the v2 claim store (data/claims/<qid>.json) which carries
// answer text + classified sources, falling back to the legacy answers/.
function collectClaimInputs(qid) {
  const v2 = readJSON(path.join(PATHS.v2ClaimsDir, `${qid}.json`), null);
  if (v2 && Array.isArray(v2.claims) && v2.claims.length) {
    const answerText = v2.claims.map((c) => c.text || "").join("\n\n");
    const sources = [];
    for (const c of v2.claims) {
      for (const s of c.sources || []) {
        if (s && s.url) sources.push(s);
      }
    }
    return { answerText, sources, questionText: v2.question_text || "" };
  }
  const legacy = readJSON(path.join(PATHS.answersDir, `${qid}.json`), null);
  if (legacy && legacy.answer) {
    return {
      answerText: legacy.answer,
      sources: legacy.sources || [],
      questionText: legacy.question || "",
    };
  }
  return null;
}

// Build provenanceEdges (FIG. 2, field 245) from a source list, de-duplicated
// by stable sourceId.
function buildProvenanceEdges(sources = []) {
  const byId = new Map();
  for (const s of sources) {
    const url = typeof s === "string" ? s : s && s.url;
    if (!url) continue;
    const sourceId = stableSourceId(url);
    if (byId.has(sourceId)) continue;
    byId.set(sourceId, {
      sourceId,
      url,
      relation: "supports",
      credibility: (s && s.credibility) || "medium",
    });
  }
  return [...byId.values()];
}

// Load the existing latest claim nodes for a question, indexed by the
// normalized claim text (FIG. 3, step 350).
function loadExistingNodes(qid) {
  const dir = path.join(PATHS.claimsDir, qid);
  const byNorm = new Map();
  if (!fs.existsSync(dir)) return byNorm;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const node = readJSON(path.join(dir, f), null);
    if (!node || !node.claimId) continue;
    const norm = (node.meta && node.meta.normalizedText) || normalizeClaimText(node.claimText || "");
    byNorm.set(norm, { node, file: path.join(dir, f) });
  }
  return byNorm;
}

function provenanceSignature(edges) {
  return edges.map((e) => e.sourceId).sort().join(",");
}

// ── Claim-Node Builder (FIG. 3) ──────────────────────────────────────
function buildClaimNodes(qid, quarantine) {
  const built = { created: 0, updated: 0, unchanged: 0 };
  const inputs = collectClaimInputs(qid);
  if (!inputs) return built;

  const assertions = extractAssertions(inputs.answerText);
  if (!assertions.length) return built;

  const edges = buildProvenanceEdges(inputs.sources);
  const confidence = confidenceFrom(edges.length);
  const existing = loadExistingNodes(qid);
  const dir = path.join(PATHS.claimsDir, qid);
  const seenNorm = new Set();

  for (const claimText of assertions) {
    try {
      const norm = normalizeClaimText(claimText);
      if (seenNorm.has(norm)) continue; // merge per (questionId, normalized text)
      seenNorm.add(norm);

      const prior = existing.get(norm);
      if (prior) {
        const oldNode = prior.node;
        const textChanged = (oldNode.claimText || "") !== claimText;
        const provChanged = provenanceSignature(oldNode.provenanceEdges || []) !== provenanceSignature(edges);
        if (!textChanged && !provChanged) {
          built.unchanged++;
          continue; // leave node unchanged (no halt)
        }
        // Text or provenance changed → archive old version, increment version.
        const archived = { ...oldNode, status: "superseded" };
        archived.validityInterval = { ...(oldNode.validityInterval || {}), validUntil: today() };
        writeJSON(
          path.join(dir, "versions", `${oldNode.claimId}.v${oldNode.version || 1}.json`),
          archived
        );
        const updated = {
          ...oldNode,
          claimText,
          status: "active",
          version: (oldNode.version || 1) + 1,
          validityInterval: { validFrom: today(), validUntil: null },
          confidence,
          provenanceEdges: edges,
          // A content change resets review flags; the engine re-evaluates below.
          contradictionStatus: "none",
          disputeStatus: "none",
          contradicts: [],
          meta: {
            ...(oldNode.meta || {}),
            normalizedText: norm,
            questionText: inputs.questionText,
            updatedAt: nowISO(),
            supportingSourceCount: edges.length,
          },
        };
        writeJSON(path.join(dir, `${updated.claimId}.json`), updated);
        built.updated++;
      } else {
        // New claim → create a new node.
        const claimId = newClaimId();
        const node = {
          claimId,
          questionId: qid,
          claimText,
          status: "active",
          version: 1,
          validityInterval: { validFrom: today(), validUntil: null },
          confidence,
          provenanceEdges: edges,
          contradictionStatus: "none",
          disputeStatus: "none",
          contradicts: [],
          meta: {
            normalizedText: norm,
            questionText: inputs.questionText,
            createdAt: nowISO(),
            updatedAt: nowISO(),
            supportingSourceCount: edges.length,
            builder: "consistency-review.mjs",
          },
        };
        writeJSON(path.join(dir, `${claimId}.json`), node);
        built.created++;
      }
    } catch (err) {
      quarantine.push({ questionId: qid, claimText, error: String(err && err.message || err), stack: err && err.stack });
    }
  }
  return built;
}

// ── Contradiction-Detection Engine (FIG. 4) ──────────────────────────
function loadActiveNodesGrouped() {
  const groups = new Map();
  if (!fs.existsSync(PATHS.claimsDir)) return groups;
  for (const entry of fs.readdirSync(PATHS.claimsDir)) {
    if (!/^q\d+$/.test(entry)) continue; // only q### question dirs
    const dir = path.join(PATHS.claimsDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const node = readJSON(path.join(dir, f), null);
      if (!node || node.status !== "active") continue;
      node.__file = path.join(dir, f);
      node.__tokens = tokenizeContent(node.claimText || "");
      if (!groups.has(entry)) groups.set(entry, []);
      groups.get(entry).push(node);
    }
  }
  return groups;
}

function detectContradictions(quarantine) {
  const groups = loadActiveNodesGrouped();
  const disputes = [];

  for (const [qid, nodes] of groups) {
    try {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const overlap = jaccard(a.__tokens, b.__tokens);
          if (overlap < GATE) continue; // topical gate

          const assessment = assessPair(a.claimText, b.claimText);
          if (!assessment.indicated) continue; // leave nodes unchanged (no halt)

          // Flag both nodes.
          a.contradictionStatus = "suspected";
          a.disputeStatus = "open";
          if (!a.contradicts.includes(b.claimId)) a.contradicts.push(b.claimId);
          b.contradictionStatus = "suspected";
          b.disputeStatus = "open";
          if (!b.contradicts.includes(a.claimId)) b.contradicts.push(a.claimId);

          a.meta = { ...(a.meta || {}), lastReviewed: nowISO() };
          b.meta = { ...(b.meta || {}), lastReviewed: nowISO() };
          persistNode(a);
          persistNode(b);

          const dispute = {
            disputeId: `dsp-${uuidv4()}`,
            detectedAt: nowISO(),
            questionId: qid,
            questionText: (a.meta && a.meta.questionText) || "",
            reason: assessment.reason,
            detail: assessment.detail,
            topicalOverlap: Number(overlap.toFixed(3)),
            gate: GATE,
            claims: [
              {
                claimId: a.claimId,
                claimText: a.claimText,
                confidence: a.confidence,
                sourceIds: (a.provenanceEdges || []).map((e) => e.sourceId),
              },
              {
                claimId: b.claimId,
                claimText: b.claimText,
                confidence: b.confidence,
                sourceIds: (b.provenanceEdges || []).map((e) => e.sourceId),
              },
            ],
            status: "open",
            resolution: null,
          };
          const file = path.join(PATHS.disputesDir, `${fsStamp()}-${qid}-${dispute.disputeId.slice(4, 12)}.json`);
          writeJSON(file, dispute);
          disputes.push(dispute);
        }
      }
    } catch (err) {
      quarantine.push({ questionId: qid, phase: "contradiction-detection", error: String(err && err.message || err), stack: err && err.stack });
    }
  }
  return disputes;
}

function persistNode(node) {
  const clean = { ...node };
  delete clean.__file;
  delete clean.__tokens;
  writeJSON(node.__file, clean);
}

// ── Run report (Zone 4 — author's loop) ──────────────────────────────
function writeReport(summary, disputes, quarantine) {
  const date = today();
  const file = path.join(PATHS.reportsDir, `consistency-${date}.md`);
  const lines = [];
  lines.push(`# Canon & Consistency Review — ${date}`);
  lines.push("");
  lines.push(`_Generated ${nowISO()} by \`scripts/consistency-review.mjs\` (Stage 6.5, non-blocking)._`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Questions processed: **${summary.questions}**`);
  lines.push(`- Claim nodes created: **${summary.created}**`);
  lines.push(`- Claim nodes updated (new version): **${summary.updated}**`);
  lines.push(`- Claim nodes unchanged: **${summary.unchanged}**`);
  lines.push(`- Topical-overlap gate: **${GATE}**`);
  lines.push(`- Open disputes this run: **${disputes.length}**`);
  lines.push(`- Quarantined events: **${quarantine.length}**`);
  lines.push("");
  lines.push("## Canon Review — Open Disputes");
  lines.push("");
  if (!disputes.length) {
    lines.push("No new contradictions detected.");
  } else {
    lines.push(
      "> The following claim pairs were flagged as _suspected_ contradictions and their " +
        "`disputeStatus` set to _open_. Nothing was halted or removed. Review each pair and " +
        "resolve via the author's loop (amend questions / charter, or mark resolved)."
    );
    lines.push("");
    let n = 1;
    for (const d of disputes) {
      lines.push(`### ${n}. ${d.questionId} — ${d.reason} conflict (overlap ${d.topicalOverlap})`);
      if (d.questionText) lines.push(`*Question:* ${d.questionText}`);
      lines.push("");
      lines.push(`- **Claim A** (\`${d.claims[0].claimId}\`, confidence ${d.claims[0].confidence.score}/${d.claims[0].confidence.level}):`);
      lines.push(`  > ${d.claims[0].claimText}`);
      lines.push(`  - sourceIds: ${d.claims[0].sourceIds.join(", ") || "—"}`);
      lines.push(`- **Claim B** (\`${d.claims[1].claimId}\`, confidence ${d.claims[1].confidence.score}/${d.claims[1].confidence.level}):`);
      lines.push(`  > ${d.claims[1].claimText}`);
      lines.push(`  - sourceIds: ${d.claims[1].sourceIds.join(", ") || "—"}`);
      lines.push(`- **Reason:** ${d.reason} (${d.detail})`);
      lines.push(`- **Dispute record:** \`claims/disputes/\` (${d.disputeId})`);
      lines.push("");
      n++;
    }
  }

  if (quarantine.length) {
    lines.push("## Quarantined Events");
    lines.push("");
    lines.push("These records were skipped without halting the pipeline; see `quarantine/`.");
    lines.push("");
    for (const q of quarantine) {
      lines.push(`- ${q.questionId || "(unknown)"}${q.phase ? ` [${q.phase}]` : ""}: ${q.error}`);
    }
    lines.push("");
  }

  writeJSON(path.join(PATHS.reportsDir, `consistency-${date}.summary.json`), {
    date,
    generatedAt: nowISO(),
    gate: GATE,
    ...summary,
    disputeCount: disputes.length,
    quarantineCount: quarantine.length,
  });

  fs.mkdirSync(PATHS.reportsDir, { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

// ── Main (non-blocking; ALWAYS exits 0) ──────────────────────────────
async function main() {
  const quarantine = [];
  const summary = { questions: 0, created: 0, updated: 0, unchanged: 0 };

  try {
    ensureDir(PATHS.claimsDir);
    ensureDir(PATHS.disputesDir);
    ensureDir(PATHS.reportsDir);

    // Determine the set of question ids to process (canonical q### format).
    const questionIds = new Set();
    const qbank = readJSON(PATHS.questions, []);
    for (const q of qbank || []) if (q && /^q\d+$/.test(q.id)) questionIds.add(q.id);
    // Also include any provenance-bearing manifests present in data/claims.
    if (fs.existsSync(PATHS.v2ClaimsDir)) {
      for (const f of fs.readdirSync(PATHS.v2ClaimsDir)) {
        const m = f.match(/^(q\d+)\.json$/);
        if (m) questionIds.add(m[1]);
      }
    }

    for (const qid of [...questionIds].sort()) {
      try {
        const built = buildClaimNodes(qid, quarantine);
        summary.questions++;
        summary.created += built.created;
        summary.updated += built.updated;
        summary.unchanged += built.unchanged;
      } catch (err) {
        quarantine.push({ questionId: qid, phase: "builder", error: String(err && err.message || err), stack: err && err.stack });
      }
    }

    const disputes = detectContradictions(quarantine);
    const reportFile = writeReport(summary, disputes, quarantine);

    // Persist any quarantined events to disk (non-fatal).
    if (quarantine.length) {
      writeJSON(
        path.join(PATHS.quarantineDir, `consistency-quarantine-${fsStamp()}.json`),
        { generatedAt: nowISO(), events: quarantine }
      );
    }

    console.log("Canon & Consistency Review (Stage 6.5) — complete.");
    console.log(`  questions processed : ${summary.questions}`);
    console.log(`  nodes created       : ${summary.created}`);
    console.log(`  nodes updated       : ${summary.updated}`);
    console.log(`  nodes unchanged     : ${summary.unchanged}`);
    console.log(`  open disputes       : ${disputes.length}`);
    console.log(`  quarantined events  : ${quarantine.length}`);
    console.log(`  report              : ${path.relative(ROOT, reportFile)}`);
  } catch (fatal) {
    // Absolute last-resort catch: quarantine and continue. Never halt.
    try {
      writeJSON(
        path.join(PATHS.quarantineDir, `consistency-quarantine-${fsStamp()}.json`),
        { generatedAt: nowISO(), fatal: true, error: String(fatal && fatal.message || fatal), stack: fatal && fatal.stack, events: quarantine }
      );
    } catch {
      /* even quarantine failed — swallow to guarantee non-blocking behaviour */
    }
    console.log("Canon & Consistency Review (Stage 6.5) — completed with a quarantined fatal error (non-blocking).");
  }
}

await main();
// Guarantee a clean, non-blocking exit for the pipeline.
process.exit(0);
