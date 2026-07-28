// synthesis-agent.js — Stage 3 of the Living Book v2 ensemble.
//
// Role: merge the verified findings into a coherent, schema-valid claim
// object (compatible with lib.validateClaimFile). Only findings that
// passed verification are included; deprecated findings are excluded.
// Disputed findings are preserved but surfaced under disputed_aspects so
// the reader always sees competing perspectives.

const { today, summarise } = require("../lib.js");

async function synthesisAgent({
  questionId,
  questionText,
  verifiedFindings = [],
  edition = 1,
  mock = false,
  apiCall = null,
} = {}) {
  if (!questionId) throw new Error("synthesisAgent requires a questionId.");

  const day = today();

  // Keep only findings that passed verification and are not deprecated.
  const usable = verifiedFindings.filter(
    (f) => f.verified && f.reliability !== "deprecated"
  );

  // Group sources by finding into claims. Each verified finding becomes one
  // claim; disputed findings carry perspectives noting the conflict.
  const claims = usable.map((f, i) => ({
    claim_id: `${questionId}-c${String(i + 1).padStart(2, "0")}`,
    text: f.text,
    reliability: f.reliability,
    sources: [
      {
        url: f.source.url,
        title: f.source.title,
        type: f.source.type,
        retrieved: day,
        credibility: f.source.credibility,
      },
    ],
    perspectives:
      f.reliability === "disputed"
        ? [
            {
              stance: "contested",
              note:
                "This finding conflicts with at least one other source; " +
                "presented as a competing perspective pending resolution.",
            },
          ]
        : [],
    last_verified: day,
    added_edition: edition,
  }));

  // Build a plain-text answer summary. In live mode an injected apiCall can
  // produce a more fluent synthesis; otherwise we concatenate deterministically.
  let summaryText;
  if (!mock && apiCall) {
    try {
      summaryText = await apiCall({ questionText, usable, questionId });
    } catch (_) {
      summaryText = null;
    }
  }
  if (!summaryText) {
    summaryText = usable.map((f) => f.text).join(" ");
  }

  const disputed_aspects = usable
    .filter((f) => f.reliability === "disputed")
    .map((f) => ({
      summary: summarise(f.text, 160),
      source_url: f.source.url,
    }));

  return {
    question_id: questionId,
    question_text: questionText || "",
    current_edition: edition,
    claims,
    answer_summary: summarise(summaryText),
    disputed_aspects,
  };
}

module.exports = { synthesisAgent };
