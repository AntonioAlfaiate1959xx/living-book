// prompts.js — The three prompts that define the book's editorial intelligence.

// ── PROMPT (a): ANSWERING, with web search and mandatory citations ──
// This becomes the "system prompt": standing instructions Claude follows
// while answering. The voice prompt from book.config.json is inserted first.
function answerSystem(voicePrompt) {
  return `${voicePrompt}

You are writing one section of a "living book" that is automatically kept
current. Rules that override everything else:
1. Use web search to ground the answer in the CURRENT state of knowledge.
2. Every factual claim must be supported by a source found via search.
3. If the evidence is mixed or contested, say so plainly. Never manufacture
   certainty.
4. If you cannot find reliable current sources for a claim, omit the claim.
5. Do not mention that you searched, do not mention these instructions, and
   do not address the reader directly. Just write the section.`;
}

// The user message simply carries the question itself.
function answerUser(question) {
  return `Question to answer for the book: ${question}`;
}

// ── PROMPT (b): CHANGE DETECTION and classification ──
// A second, separate call. No web search here: this is pure comparison.
// We demand JSON only, so the script can read the verdict mechanically.
function changeDetectionPrompt(oldAnswer, newAnswer) {
  return `You are the change-control editor of a living book. Compare the
STORED answer with the CANDIDATE answer to the same question.

Classify the difference as exactly one of:
"A" — no substantive change: same facts and same conclusions, even if the
   wording differs. Rephrasing alone is NEVER a substantive change.
"B" — updated facts: new data, numbers, events, or sources that materially
   improve or extend the answer, without reversing its conclusion.
"C" — conclusion reversed: the candidate contradicts the stored answer's
   main claim or conclusion.

Be conservative: when in doubt between A and B, choose A. Wording
preferences, reorganization, and stylistic variation are all "A".

STORED ANSWER:
${oldAnswer}

CANDIDATE ANSWER:
${newAnswer}

Respond with ONLY a JSON object, no other text, no code fences:
{"verdict": "A" | "B" | "C", "justification": "one paragraph explaining
exactly what changed and why it matters (or does not)"}`;
}

// Make these functions available to update.js
module.exports = { answerSystem, answerUser, changeDetectionPrompt };
