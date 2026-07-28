// research-agent.js — Stage 1 of the Living Book v2 ensemble.
//
// Role: gather candidate raw findings + source URLs for one question.
// It does NOT judge reliability (that is the verification agent's job) and
// it does NOT write the final claim (that is the synthesis agent's job).
//
// Live mode calls the Abacus.AI API through an injectable `apiCall`
// function so tests can exercise the code path without a network. The
// default live caller reads process.env.ABACUS_API_KEY ONLY — no key is
// ever hardcoded or written to disk.

const { nowISO } = require("../lib.js");

// ── Default live API caller ─────────────────────────────────────────
// Isolated so tests never exercise it. Returns the raw model text plus any
// structured sources the deployment happened to surface.
async function defaultApiCall(questionText) {
  const apiKey = process.env.ABACUS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ABACUS_API_KEY is not set. Provide it via the environment, " +
        "or run the ensemble with --mock for an offline pass."
    );
  }
  const endpoint =
    process.env.ABACUS_API_ENDPOINT ||
    "https://api.abacus.ai/api/v0/getChatResponse";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          is_user: true,
          text:
            "You are a RESEARCH agent. Gather the most relevant, recent, " +
            "well-sourced findings about the following question on AI in " +
            "education. Return several distinct findings, each with a source " +
            "URL and title. Do not editorialise.\n\n" +
            questionText,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Research agent API error ${response.status}: ${await response.text()}`
    );
  }
  const data = await response.json();
  const text =
    data?.result?.messages?.slice(-1)[0]?.text ||
    data?.result?.answer ||
    data?.answer ||
    (typeof data === "string" ? data : JSON.stringify(data));
  const rawSources =
    data?.result?.search_results || data?.result?.sources || [];
  const findings = rawSources
    .filter((s) => s && (s.url || s.link))
    .map((s) => ({
      text: s.snippet || s.title || String(text).slice(0, 240),
      source: { url: s.url || s.link, title: s.title || s.url || s.link },
    }));
  // If the deployment returned no structured sources, fall back to a single
  // finding carrying the whole answer (verification will down-rate it).
  if (findings.length === 0) {
    findings.push({
      text: String(text).trim(),
      source: { url: "", title: "Unsourced model output" },
    });
  }
  return findings;
}

// ── Deterministic mock ──────────────────────────────────────────────
// Stable output derived from the questionId, so tests never flake.
function mockFindings(questionId, questionText) {
  return [
    {
      text:
        `[MOCK RESEARCH] Primary finding for ${questionId}: a peer-reviewed ` +
        `study relevant to "${questionText}".`,
      source: {
        url: `https://arxiv.org/abs/mock-${questionId}`,
        title: `Academic study on ${questionId}`,
      },
    },
    {
      text:
        `[MOCK RESEARCH] Secondary finding for ${questionId}: an official ` +
        `policy statement relevant to the question.`,
      source: {
        url: `https://www.oecd.org/education/mock-${questionId}`,
        title: `Official guidance on ${questionId}`,
      },
    },
    {
      text:
        `[MOCK RESEARCH] Practitioner note for ${questionId} from a vendor ` +
        `blog (lower credibility).`,
      source: {
        url: `https://example.com/blog/${questionId}`,
        title: `Practitioner blog on ${questionId}`,
      },
    },
  ];
}

// ── Public entry point ──────────────────────────────────────────────
async function researchAgent({
  questionId,
  questionText,
  mock = false,
  apiCall = null,
} = {}) {
  if (!questionId) throw new Error("researchAgent requires a questionId.");
  let findings;
  if (apiCall) {
    findings = await apiCall(questionText, questionId);
  } else if (mock) {
    findings = mockFindings(questionId, questionText || "");
  } else {
    findings = await defaultApiCall(questionText);
  }
  return { questionId, findings, generatedAt: nowISO() };
}

module.exports = { researchAgent, mockFindings };
