// ensemble.js — Orchestrates the Living Book v2 multi-agent pipeline.
//
//   Research  →  Verification  →  Synthesis
//
// Each stage is a separate, independently-testable module. This runner
// chains them for ONE question and returns a schema-valid claim-file object.
// It does NOT write to disk — the caller (orchestrate.js) decides on
// persistence, so the ensemble stays a pure, testable transform.

const fs = require("fs");
const path = require("path");
const { PATHS, readJSON, nowISO } = require("../lib.js");
const { researchAgent } = require("./research-agent.js");
const { verificationAgent } = require("./verification-agent.js");
const { synthesisAgent } = require("./synthesis-agent.js");

function log(message) {
  fs.mkdirSync(path.dirname(PATHS.orchestrationLog), { recursive: true });
  fs.appendFileSync(PATHS.orchestrationLog, `${nowISO()}  ${message}\n`);
}

// `apiCall` may be a single function (shared by all stages) or an object
// { research, verification, synthesis } giving each stage its own caller.
function pickCaller(apiCall, stage) {
  if (!apiCall) return null;
  if (typeof apiCall === "function") return apiCall;
  return apiCall[stage] || null;
}

async function runEnsemble({
  questionId,
  mock = false,
  edition = 1,
  apiCall = null,
  registryData = null,
} = {}) {
  if (!questionId || !/^q\d+$/.test(questionId)) {
    throw new Error(`Invalid questionId "${questionId}" (expected qNNN).`);
  }

  // Resolve the question text from the registry (or an injected copy).
  const registry = registryData || readJSON(PATHS.registry, null);
  if (!registry) {
    throw new Error("Registry not found. Run `node scripts/migrate.js` first.");
  }
  const entry = registry.questions.find((q) => q.id === questionId);
  if (!entry) throw new Error(`Question ${questionId} is not in the registry.`);
  const questionText = entry.question;

  log(`ENSEMBLE start ${questionId} (mode=${mock ? "mock" : "live"})`);

  // Stage 1 — Research
  const research = await researchAgent({
    questionId,
    questionText,
    mock,
    apiCall: pickCaller(apiCall, "research"),
  });
  log(`ENSEMBLE ${questionId} research: ${research.findings.length} finding(s)`);

  // Stage 2 — Verification
  const verification = await verificationAgent({
    questionId,
    findings: research.findings,
    mock,
    apiCall: pickCaller(apiCall, "verification"),
  });
  log(
    `ENSEMBLE ${questionId} verification: ` +
      `${verification.verifiedFindings.filter((f) => f.verified).length} verified, ` +
      `${verification.disputed.length} disputed`
  );

  // Stage 3 — Synthesis
  const claimFile = await synthesisAgent({
    questionId,
    questionText,
    verifiedFindings: verification.verifiedFindings,
    edition,
    mock,
    apiCall: pickCaller(apiCall, "synthesis"),
  });
  log(
    `ENSEMBLE ${questionId} synthesis: ${claimFile.claims.length} claim(s), ` +
      `${claimFile.disputed_aspects.length} disputed aspect(s)`
  );

  return {
    questionId,
    claimFile,
    stages: { research, verification },
    model: mock ? "ensemble(mock)" : "ensemble",
  };
}

module.exports = { runEnsemble };
