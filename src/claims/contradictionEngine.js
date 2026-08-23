'use strict';

/**
 * contradictionEngine.js — Claim-Node Layer (additive).
 *
 * Loads every claim node produced by claimBuilder (grouped per question) and
 * applies lightweight, deterministic heuristics to detect pairs of claims on
 * the SAME question that appear to contradict one another. When a suspected
 * contradiction is found it:
 *   - sets `contradictionStatus = "suspected"` and `disputeStatus = "open"`
 *     on both claim nodes (and records the opposing claimIds under `contradicts`);
 *   - writes a dispute record to  disputes/<questionId>-<timestamp>.json
 *   - appends to a run report at   reports/contradictions-<date>.json
 *
 * The heuristics are intentionally conservative and explainable — this layer
 * flags candidates for human judgement (Zone 4 "Rule on lint report"); it never
 * deletes or rewrites answers.
 *
 * Inventor: António José Amaro Alfaiate.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLAIMS_DIR = path.join(ROOT, 'claims');
const DISPUTES_DIR = path.join(ROOT, 'disputes');
const REPORTS_DIR = path.join(ROOT, 'reports');

// Negation cues used by the heuristic.
const NEGATION_TOKENS = [
  'not', 'no', 'never', 'without', 'cannot', "can't", 'without',
  'fails', 'fail', 'false', 'incorrect', 'untrue', 'lacks', 'absence',
];

// Antonym pairs — if one claim uses one side and the other uses the opposite
// while otherwise talking about the same subject, that's a contradiction cue.
const ANTONYM_PAIRS = [
  ['increase', 'decrease'], ['increases', 'decreases'], ['increased', 'decreased'],
  ['improve', 'worsen'], ['improves', 'worsens'], ['improved', 'worsened'],
  ['higher', 'lower'], ['more', 'less'], ['positive', 'negative'],
  ['beneficial', 'harmful'], ['effective', 'ineffective'], ['helps', 'harms'],
  ['supports', 'undermines'], ['enhances', 'diminishes'], ['reduces', 'raises'],
  ['gain', 'loss'], ['rise', 'fall'], ['grows', 'shrinks'],
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'that', 'this', 'these', 'those',
  'it', 'its', 'as', 'at', 'by', 'from', 'has', 'have', 'had', 'not', 'no',
  'can', 'cannot', 'will', 'would', 'should', 'may', 'might', 'do', 'does',
  'their', 'they', 'them', 'we', 'our', 'you', 'your', 'he', 'she', 'his',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => path.join(dir, f));
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function contentWords(tokens) {
  return new Set(tokens.filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function negationCount(tokens) {
  return tokens.filter((t) => NEGATION_TOKENS.includes(t)).length;
}

/**
 * Decide whether two claims (on the same question) look contradictory.
 * Returns { contradiction: boolean, reason: string, overlap: number }.
 */
function assessPair(textA, textB) {
  const tokA = tokenize(textA);
  const tokB = tokenize(textB);
  const wordsA = contentWords(tokA);
  const wordsB = contentWords(tokB);
  const overlap = jaccard(wordsA, wordsB);

  // Only consider claims that share meaningful subject matter.
  if (overlap < 0.18) {
    return { contradiction: false, reason: 'insufficient topical overlap', overlap };
  }

  // Cue 1: antonym pair split across the two claims.
  for (const [x, y] of ANTONYM_PAIRS) {
    const aHasX = wordsA.has(x);
    const aHasY = wordsA.has(y);
    const bHasX = wordsB.has(x);
    const bHasY = wordsB.has(y);
    if ((aHasX && bHasY && !aHasY) || (aHasY && bHasX && !aHasX)) {
      return {
        contradiction: true,
        reason: `antonym conflict on shared topic ("${x}" vs "${y}", overlap=${overlap.toFixed(2)})`,
        overlap,
      };
    }
  }

  // Cue 2: strong topical overlap but opposite polarity (one negates, one asserts).
  const negA = negationCount(tokA);
  const negB = negationCount(tokB);
  if (overlap >= 0.4 && ((negA > 0) !== (negB > 0))) {
    return {
      contradiction: true,
      reason: `polarity conflict on shared topic (negations ${negA} vs ${negB}, overlap=${overlap.toFixed(2)})`,
      overlap,
    };
  }

  return { contradiction: false, reason: 'no contradiction cue', overlap };
}

/** Load claim nodes grouped by questionId: Map<qid, [{node, file}]>. */
function loadClaimsByQuestion() {
  const byQuestion = new Map();
  if (!fs.existsSync(CLAIMS_DIR)) return byQuestion;
  const questionDirs = fs
    .readdirSync(CLAIMS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const qid of questionDirs) {
    const entries = [];
    for (const file of listJsonFiles(path.join(CLAIMS_DIR, qid))) {
      try {
        entries.push({ node: readJson(file), file });
      } catch (err) {
        console.warn(`[contradictionEngine] skipping unreadable ${file}: ${err.message}`);
      }
    }
    if (entries.length) byQuestion.set(qid, entries);
  }
  return byQuestion;
}

function detectContradictions(options = {}) {
  const log = options.log === false ? () => {} : (...a) => console.log(...a);
  const runStamp = new Date().toISOString();
  const dateStamp = runStamp.slice(0, 10);
  const fileStamp = runStamp.replace(/[:.]/g, '-');

  const byQuestion = loadClaimsByQuestion();
  const report = {
    generatedAt: runStamp,
    inventor: 'António José Amaro Alfaiate',
    questionsScanned: byQuestion.size,
    claimsScanned: 0,
    contradictionsFound: 0,
    disputes: [],
  };

  // Track which nodes need re-writing (to persist status changes).
  const flaggedNodes = new Map(); // file -> node

  for (const [qid, entries] of byQuestion) {
    report.claimsScanned += entries.length;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const verdict = assessPair(a.node.claimText, b.node.claimText);
        if (!verdict.contradiction) continue;

        report.contradictionsFound++;

        for (const [self, other] of [[a, b], [b, a]]) {
          const node = flaggedNodes.get(self.file) || self.node;
          node.contradictionStatus = 'suspected';
          node.disputeStatus = 'open';
          node.contradicts = Array.from(
            new Set([...(node.contradicts || []), other.node.claimId])
          );
          node.meta = { ...(node.meta || {}), updatedAt: runStamp };
          flaggedNodes.set(self.file, node);
        }

        const dispute = {
          disputeId: `dsp-${qid}-${fileStamp}-${i}-${j}`,
          questionId: qid,
          status: 'open',
          detectedAt: runStamp,
          reason: verdict.reason,
          topicalOverlap: Number(verdict.overlap.toFixed(3)),
          claims: [
            { claimId: a.node.claimId, claimText: a.node.claimText },
            { claimId: b.node.claimId, claimText: b.node.claimText },
          ],
          resolution: null,
          inventor: 'António José Amaro Alfaiate',
        };

        fs.mkdirSync(DISPUTES_DIR, { recursive: true });
        const disputeFile = path.join(
          DISPUTES_DIR,
          `${qid}-${fileStamp}-${i}-${j}.json`
        );
        fs.writeFileSync(disputeFile, JSON.stringify(dispute, null, 2) + '\n');
        report.disputes.push({
          questionId: qid,
          disputeFile: path.relative(ROOT, disputeFile),
          claimIds: [a.node.claimId, b.node.claimId],
          reason: verdict.reason,
        });
      }
    }
  }

  // Persist status changes back onto the flagged claim nodes.
  for (const [file, node] of flaggedNodes) {
    fs.writeFileSync(file, JSON.stringify(node, null, 2) + '\n');
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportFile = path.join(REPORTS_DIR, `contradictions-${dateStamp}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');

  log(
    `[contradictionEngine] questions=${report.questionsScanned} ` +
      `claims=${report.claimsScanned} contradictions=${report.contradictionsFound} ` +
      `→ ${path.relative(ROOT, reportFile)}`
  );
  return report;
}

module.exports = {
  detectContradictions,
  assessPair,
  DISPUTES_DIR,
  REPORTS_DIR,
};

if (require.main === module) {
  detectContradictions();
}
