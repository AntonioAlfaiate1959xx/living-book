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

  // OpenAI-compatible RouteLLM endpoint available on the Abacus.AI VM.
  const llmBase =
    process.env.ABACUS_LLM_BASE_URL ||
    process.env.ABACUS_API_ENDPOINT ||
    "https://routellm.abacus.ai/v1";
  const endpoint = llmBase.replace(/\/$/, "") + "/chat/completions";
  const model = process.env.ABACUS_MODEL || "claude-sonnet-4-6";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a RESEARCH agent for an AI-in-Education reference book. " +
            "Gather the most relevant, recent, well-sourced findings about the " +
            "given question. Return several distinct findings, each supported by " +
            "a real source URL and title. Do not editorialise or draw conclusions.",
        },
        {
          role: "user",
          content:
            "Gather well-sourced findings about the following question on " +
            "AI in education. For each finding include a source URL.\n\n" +
            questionText,
        },
      ],
      max_tokens: 1024,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Research agent API error ${response.status}: ${await response.text()}`
    );
  }
  const data = await response.json();
  // OpenAI-compatible response: choices[0].message.content
  const text =
    data?.choices?.[0]?.message?.content ||
    data?.result?.messages?.slice(-1)[0]?.text ||
    data?.result?.answer ||
    data?.answer ||
    (typeof data === "string" ? data : JSON.stringify(data));

  // Extract URLs from the text to form findings.
  const urlRegex = /https?:\/\/[^\s)"']+/g;
  const urlMatches = [...new Set(String(text).match(urlRegex) || [])].slice(0, 6);
  const findings = urlMatches.map((url) => ({
    text: String(text).trim(),
    source: { url, title: url },
  }));

  // If no URLs found, fall back to a single finding with the full text.
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
