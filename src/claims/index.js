'use strict';

/**
 * index.js — Claim-Node Layer entry point.
 *
 * Orchestrates the two-stage claim pipeline:
 *   1. claimBuilder        — normalize provenance into persistent, versioned
 *                            claim nodes under claims/<questionId>/<clm-uuid>.json
 *   2. contradictionEngine — scan claim nodes per question, flag suspected
 *                            contradictions, write dispute + report artifacts
 *
 * Invoked from the pipeline via `npm run claims` (see package.json), which runs
 * between the Classify and Harmonize stages of the update cycle.
 *
 * Inventor: António José Amaro Alfaiate.
 */

const { buildClaims } = require('./claimBuilder');
const { detectContradictions } = require('./contradictionEngine');

function runClaimPipeline(options = {}) {
  console.log('[claims] Building claim nodes from provenance…');
  const build = buildClaims(options);

  console.log('[claims] Scanning for contradictions…');
  const contradictions = detectContradictions(options);

  const summary = {
    claims: {
      created: build.created,
      updated: build.updated,
      unchanged: build.unchanged,
      total: build.nodes.length,
    },
    contradictions: {
      questionsScanned: contradictions.questionsScanned,
      claimsScanned: contradictions.claimsScanned,
      found: contradictions.contradictionsFound,
      disputes: contradictions.disputes.length,
    },
  };

  console.log('[claims] Done.', JSON.stringify(summary));
  return summary;
}

module.exports = { runClaimPipeline };

if (require.main === module) {
  try {
    runClaimPipeline();
  } catch (err) {
    console.error('[claims] pipeline failed:', err);
    process.exit(1);
  }
}
