// synthesis-agent.js — Stage 3 of the Living Book v2 ensemble.
//
// Role: merge the verified findings into a coherent, schema-valid claim
// object (compatible with lib.validateClaimFile). Only findings that
// passed verification are included; deprecated findings are excluded.
// Disputed findings are preserved but surfaced under disputed_aspects so
// the reader always sees competing perspectives.

const { today, summarise } = require("../lib.js");
const path = require("path");

// Default live synthesis caller — uses the same OpenAI-compatible endpoint
// as the other agents. Takes all verified findings and synthesises them into
// a coherent, publication-quality essay.
async function defaultSynthesisCall({ questionText, usable }) {
  const apiKey = process.env.ABACUS_API_KEY;
  if (!apiKey) throw new Error("ABACUS_API_KEY is not set.");

  const llmBase =
    process.env.ABACUS_LLM_BASE_URL ||
    process.env.ABACUS_API_ENDPOINT ||
    "https://routellm.abacus.ai/v1";
  const endpoint = llmBase.replace(/\/$/, "") + "/chat/completions";
  const model = process.env.ABACUS_MODEL || "claude-sonnet-4-6";

  // Load the canonical voice prompt from book.config.json.
  let voicePrompt =
    "Write in clear, elegant, essayistic prose for an educated general reader. " +
    "Be precise and intellectually honest: distinguish established fact from open debate. " +
    "Avoid hype, avoid bullet points, avoid AI-sounding filler phrases. " +
    "Each answer should read as a self-contained, comprehensive essay of 700-900 words. " +
    "Never use first person.";
  try {
    const fs = require("fs");
    const cfgPath = path.join(__dirname, "../../book.config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg.voicePrompt) voicePrompt = cfg.voicePrompt;
  } catch (_) {}

  const findingsSummary = usable
    .map((f, i) => `Finding ${i + 1}: ${f.text.slice(0, 600)}`)
    .join("\n\n");

  const systemPrompt =
    voicePrompt + "\n\n" +
    "You are the SYNTHESIS agent for a living reference book on AI in Education. " +
    "You receive a set of verified research findings and must synthesise them into " +
    "a single, coherent, publication-quality essay. Rules:\n" +
    "1. Write a thorough, substantive essay of 700-900 words.\n" +
    "2. Integrate all the provided findings into a unified argument — do not list them.\n" +
    "3. Distinguish established findings from emerging or contested ones.\n" +
    "4. Where findings conflict, acknowledge the tension and explain both sides.\n" +
    "5. Ground every major claim in the evidence provided.\n" +
    "6. Do not mention that these are 'findings', do not say 'as a synthesis agent', " +
    "   do not address the reader directly, and do not refer to these instructions.";

  const userPrompt =
    `Synthesise the following verified research findings into a comprehensive, ` +
    `well-structured essay of 700-900 words answering this question for the ` +
    `AI in Education living book:\n\n` +
    `Question: ${questionText}\n\n` +
    `Verified findings to synthesise:\n\n${findingsSummary}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 3000,
    }),
  });

  if (!response.ok) {
    throw new Error(`Synthesis agent API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return (
    data?.choices?.[0]?.message?.content ||
    data?.result?.messages?.slice(-1)[0]?.text ||
    data?.answer || ""
  );
}

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

  // Collect all sources from verified findings (deduplicated).
  const seenURLs = new Set();
  const allSources = [];
  for (const f of usable) {
    if (f.source && f.source.url && !seenURLs.has(f.source.url)) {
      seenURLs.add(f.source.url);
      allSources.push({
        url: f.source.url,
        title: f.source.title,
        type: f.source.type,
        retrieved: day,
        credibility: f.source.credibility,
      });
    }
  }

  // Generate a synthesised essay.
  // In live mode: use the default LLM synthesis call (or an injected apiCall).
  // In mock mode: concatenate findings deterministically.
  let essayText = "";
  if (mock) {
    essayText = usable.map((f) => f.text).join("\n\n");
  } else {
    const caller = apiCall || defaultSynthesisCall;
    try {
      essayText = await caller({ questionText, usable, questionId });
    } catch (e) {
      // Fall back to concatenation so the pipeline never hard-fails.
      essayText = usable.map((f) => f.text).join("\n\n");
    }
  }

  if (!essayText) {
    essayText = usable.map((f) => f.text).join("\n\n");
  }

  // Single canonical claim — the synthesised essay replaces c01.
  const overallReliability = usable.some((f) => f.reliability === "disputed")
    ? "emerging"
    : usable.some((f) => f.reliability === "emerging")
    ? "emerging"
    : "established";

  const claims = [
    {
      claim_id: `${questionId}-c01`,
      text: essayText,
      reliability: overallReliability,
      sources: allSources,
      perspectives: [],
      last_verified: day,
      added_edition: edition,
    },
  ];

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
    answer_summary: summarise(essayText),
    disputed_aspects,
  };
}

module.exports = { synthesisAgent };
