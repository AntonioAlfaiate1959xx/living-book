// verification-agent.js — Stage 2 of the Living Book v2 ensemble.
//
// Role: independently assess each research finding. It classifies every
// source (type + credibility) using the shared heuristic in lib.js, assigns
// a reliability grade, and flags findings that conflict with one another as
// "disputed". This is the deterministic guardrail that stops a claim from
// being published merely because a model wrote it.

const { classifySource, RELIABILITY, nowISO } = require("../lib.js");

// Map a source's credibility to a default reliability grade. This is the
// deterministic rule used in mock mode and as the baseline in live mode.
function reliabilityFromCredibility(credibility) {
  switch (credibility) {
    case "high":
      return "established";
    case "medium":
      return "emerging";
    default:
      return "emerging";
  }
}

// Very small lexical conflict detector: if one finding asserts something
// and another negates it (contains "not"/"no evidence"/"however" about the
// same key noun), we flag both as disputed. Deterministic and offline.
function detectConflicts(findings) {
  const disputedIdx = new Set();
  const NEG = /\b(not|no evidence|contradict|disput|however|conversely|but no)\b/i;
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const a = findings[i].text || "";
      const b = findings[j].text || "";
      const aNeg = NEG.test(a);
      const bNeg = NEG.test(b);
      // Conflict heuristic: exactly one of the pair is a negation and they
      // share a meaningful token (length > 5).
      if (aNeg !== bNeg) {
        const tokensA = new Set(
          a.toLowerCase().split(/\W+/).filter((t) => t.length > 5)
        );
        const shared = b
          .toLowerCase()
          .split(/\W+/)
          .some((t) => t.length > 5 && tokensA.has(t));
        if (shared) {
          disputedIdx.add(i);
          disputedIdx.add(j);
        }
      }
    }
  }
  return disputedIdx;
}

async function verificationAgent({
  questionId,
  findings = [],
  mock = false,
  apiCall = null,
} = {}) {
  if (!questionId) throw new Error("verificationAgent requires a questionId.");

  const disputedIdx = detectConflicts(findings);

  const verifiedFindings = [];
  const disputed = [];

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const url = (f.source && f.source.url) || "";
    const { type, credibility } = classifySource(url);

    let reliability = reliabilityFromCredibility(credibility);

    // A finding with no usable source cannot be "established".
    if (!url) reliability = "emerging";

    // Optional live cross-check: an injected apiCall may override the grade
    // with an independent judgement. Never exercised by tests unless injected.
    if (!mock && apiCall) {
      try {
        const verdict = await apiCall(f, questionId);
        if (verdict && RELIABILITY.includes(verdict.reliability)) {
          reliability = verdict.reliability;
        }
      } catch (_) {
        /* fall back to the deterministic grade */
      }
    }

    const isDisputed = disputedIdx.has(i);
    if (isDisputed) reliability = "disputed";

    const record = {
      text: f.text,
      source: {
        url,
        title: (f.source && f.source.title) || url || "Untitled",
        type,
        credibility,
      },
      reliability,
      credibility,
      verified: reliability !== "deprecated" && Boolean(url),
    };

    verifiedFindings.push(record);
    if (isDisputed) disputed.push(record);
  }

  return { questionId, verifiedFindings, disputed, verifiedAt: nowISO() };
}

module.exports = {
  verificationAgent,
  reliabilityFromCredibility,
  detectConflicts,
};
