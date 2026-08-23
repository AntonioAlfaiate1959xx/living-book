'use strict';

/**
 * claimBuilder.js — Claim-Node Layer (additive).
 *
 * Reads the existing provenance data (per-question claim records under
 * `data/claims/*.json` and, when present, any source manifests carrying a
 * free-text `supportsClaim` field) and normalizes each distinct claim into a
 * persistent, versioned Claim Node stored under:
 *
 *     claims/<questionId>/<clm-uuid>.json
 *
 * Design rules:
 *  - Additive only. Never mutates or deletes existing files under data/.
 *  - Persistent identity: a claim's `claimId` is stable across runs, keyed by
 *    (questionId, normalized claimText). Re-running never mints a new id for an
 *    unchanged claim; a changed claimText/provenance bumps `version`.
 *  - No external dependencies required (uses Node's built-in crypto.randomUUID).
 *
 * Inventor: António José Amaro Alfaiate.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const LEGACY_CLAIMS_DIR = path.join(ROOT, 'data', 'claims');
const OUT_CLAIMS_DIR = path.join(ROOT, 'claims');
const INVENTOR = 'António José Amaro Alfaiate';

/** Generate a persistent claim id: clm-<uuid v4>. */
function newClaimId() {
  return 'clm-' + crypto.randomUUID();
}

/** Stable source id derived from a URL (sources in the legacy store have no id). */
function sourceIdFromUrl(url) {
  if (!url || typeof url !== 'string') return 'src-unknown';
  const hash = crypto.createHash('sha1').update(url.trim()).digest('hex').slice(0, 12);
  return 'src-' + hash;
}

/** Normalize claim text for identity comparison (whitespace + case insensitive). */
function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Today's date as YYYY-MM-DD (UTC). */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Map a source count to a confidence level + score. */
function inferConfidence(sourceCount) {
  if (sourceCount >= 3) return { level: 'high', score: 0.85 };
  if (sourceCount === 2) return { level: 'medium', score: 0.6 };
  if (sourceCount === 1) return { level: 'low', score: 0.35 };
  return { level: 'low', score: 0.1 };
}

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

/**
 * Extract normalized claim inputs from all available sources.
 * Returns an array of:
 *   { questionId, claimText, provenance: [{sourceId,url,relation,credibility}],
 *     legacyClaimId }
 */
function collectClaimInputs() {
  const inputs = [];

  // 1. Legacy per-question claim records (the real provenance store).
  for (const file of listJsonFiles(LEGACY_CLAIMS_DIR)) {
    let record;
    try {
      record = readJson(file);
    } catch (err) {
      console.warn(`[claimBuilder] skipping unreadable ${file}: ${err.message}`);
      continue;
    }
    const questionId = record.question_id || path.basename(file, '.json');
    const claims = Array.isArray(record.claims) ? record.claims : [];
    for (const c of claims) {
      const claimText = c.text || c.claimText || c.supportsClaim;
      if (!claimText) continue;
      const sources = Array.isArray(c.sources) ? c.sources : [];
      const provenance = sources.map((s) => ({
        sourceId: s.id || sourceIdFromUrl(s.url),
        url: s.url || null,
        relation: 'supports',
        credibility: s.credibility || null,
      }));
      inputs.push({
        questionId,
        claimText,
        provenance,
        legacyClaimId: c.claim_id || null,
      });
    }
  }

  // 2. Any generic source manifests carrying a free-text `supportsClaim` field.
  //    (None exist in the current repo, but the layer supports them additively.)
  const manifestDirs = [path.join(ROOT, 'sources'), path.join(ROOT, 'provenance')];
  for (const dir of manifestDirs) {
    for (const file of listJsonFiles(dir)) {
      let manifest;
      try {
        manifest = readJson(file);
      } catch (err) {
        console.warn(`[claimBuilder] skipping unreadable manifest ${file}: ${err.message}`);
        continue;
      }
      const entries = Array.isArray(manifest) ? manifest : [manifest];
      for (const entry of entries) {
        if (!entry || !entry.supportsClaim) continue;
        const questionId = entry.questionId || entry.question_id;
        if (!questionId) continue;
        inputs.push({
          questionId,
          claimText: entry.supportsClaim,
          provenance: [
            {
              sourceId: entry.sourceId || entry.id || sourceIdFromUrl(entry.url),
              url: entry.url || null,
              relation: 'supports',
              credibility: entry.credibility || null,
            },
          ],
          legacyClaimId: null,
        });
      }
    }
  }

  return inputs;
}

/**
 * Merge claim inputs that refer to the same (questionId, normalized text),
 * unioning their provenance edges.
 */
function mergeInputs(inputs) {
  const byKey = new Map();
  for (const input of inputs) {
    const key = `${input.questionId}::${normalizeText(input.claimText)}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        questionId: input.questionId,
        claimText: input.claimText,
        legacyClaimId: input.legacyClaimId,
        provenance: new Map(),
      });
    }
    const merged = byKey.get(key);
    for (const edge of input.provenance) {
      merged.provenance.set(edge.sourceId, edge);
    }
  }
  return Array.from(byKey.values()).map((m) => ({
    questionId: m.questionId,
    claimText: m.claimText,
    legacyClaimId: m.legacyClaimId,
    provenance: Array.from(m.provenance.values()),
  }));
}

/** Load existing claim nodes for a question, keyed by normalized text. */
function loadExistingNodes(questionId) {
  const dir = path.join(OUT_CLAIMS_DIR, questionId);
  const byText = new Map();
  for (const file of listJsonFiles(dir)) {
    try {
      const node = readJson(file);
      byText.set(normalizeText(node.claimText), { node, file });
    } catch (err) {
      console.warn(`[claimBuilder] skipping unreadable node ${file}: ${err.message}`);
    }
  }
  return byText;
}

function provenanceSignature(edges) {
  return edges
    .map((e) => `${e.sourceId}:${e.relation}`)
    .sort()
    .join('|');
}

/**
 * Build/update all claim nodes.
 * @returns {{created:number, updated:number, unchanged:number, nodes:object[]}}
 */
function buildClaims(options = {}) {
  const log = options.log === false ? () => {} : (...a) => console.log(...a);
  fs.mkdirSync(OUT_CLAIMS_DIR, { recursive: true });

  const merged = mergeInputs(collectClaimInputs());
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const nodes = [];

  // Group by question so we only read each question's existing nodes once.
  const byQuestion = new Map();
  for (const item of merged) {
    if (!byQuestion.has(item.questionId)) byQuestion.set(item.questionId, []);
    byQuestion.get(item.questionId).push(item);
  }

  for (const [questionId, items] of byQuestion) {
    const existing = loadExistingNodes(questionId);
    const dir = path.join(OUT_CLAIMS_DIR, questionId);
    fs.mkdirSync(dir, { recursive: true });

    for (const item of items) {
      const key = normalizeText(item.claimText);
      const confidence = inferConfidence(item.provenance.length);
      const prior = existing.get(key);
      const now = new Date().toISOString();

      let node;
      if (!prior) {
        node = {
          claimId: newClaimId(),
          questionId,
          claimText: item.claimText,
          status: 'active',
          version: 1,
          validityInterval: { validFrom: today(), validUntil: null },
          confidence,
          provenanceEdges: item.provenance,
          contradictionStatus: 'none',
          disputeStatus: 'none',
          contradicts: [],
          meta: {
            createdAt: now,
            updatedAt: now,
            legacyClaimId: item.legacyClaimId || undefined,
            inventor: INVENTOR,
          },
        };
        created++;
      } else {
        const p = prior.node;
        const changed =
          provenanceSignature(p.provenanceEdges || []) !== provenanceSignature(item.provenance) ||
          (p.confidence && p.confidence.level) !== confidence.level;
        node = {
          ...p,
          claimText: item.claimText,
          provenanceEdges: item.provenance,
          confidence,
        };
        node.meta = { ...(p.meta || {}), updatedAt: now, inventor: INVENTOR };
        if (changed) {
          node.version = (p.version || 1) + 1;
          updated++;
        } else {
          unchanged++;
        }
      }

      const outFile = path.join(dir, `${node.claimId}.json`);
      fs.writeFileSync(outFile, JSON.stringify(node, null, 2) + '\n');
      nodes.push(node);
    }
  }

  log(
    `[claimBuilder] questions=${byQuestion.size} claims=${nodes.length} ` +
      `created=${created} updated=${updated} unchanged=${unchanged}`
  );
  return { created, updated, unchanged, nodes };
}

module.exports = {
  buildClaims,
  // exported for reuse / testing
  newClaimId,
  sourceIdFromUrl,
  normalizeText,
  inferConfidence,
  OUT_CLAIMS_DIR,
};

if (require.main === module) {
  buildClaims();
}
