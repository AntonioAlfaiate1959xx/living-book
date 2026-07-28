// consistency-check.js — Cross-question consistency checker + claim graph.
//
// Builds a relationship graph across ALL claim files and flags potential
// contradictions so no two questions publish conflicting answers. It is
// deterministic and offline (pure Node built-ins), which makes it safe to
// run in CI as a gate.
//
// Two related things are produced:
//   1. data/graph.json  — nodes (claims) + edges (relationships), where an
//      edge means two claims are related because they share a source URL or
//      have strong keyword overlap.
//   2. A consistency report listing:
//        - disputed claims (reliability === "disputed")
//        - contradiction candidates: related claims where one negates the
//          other (lexical negation heuristic).
//
// Usage:
//   node scripts/consistency-check.js            # write graph + print report
//   node scripts/consistency-check.js --check     # exit 1 if contradictions
//   node scripts/consistency-check.js --json      # machine-readable output

const fs = require("fs");
const path = require("path");
const { PATHS, readJSON, writeJSON, nowISO } = require("./lib.js");

const NEG =
  /\b(not|no evidence|contradict|disput|however|conversely|but no|fails? to|cannot|unproven|debunk)\b/i;

const STOPWORDS = new Set(
  ("the a an of to and or for in on at by with from as is are was were be been " +
    "this that these those it its their our your his her they them we you i " +
    "how what why when where which who whom whose can could should would may " +
    "might will shall do does did done have has had about into over under more " +
    "most less least than then also such but not no yes education ai learning")
    .split(/\s+/)
);

function keywords(text = "") {
  const counts = new Map();
  for (const raw of String(text).toLowerCase().split(/\W+/)) {
    if (raw.length <= 4 || STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  // Keep the most frequent significant tokens.
  return new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([w]) => w)
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Load every claim into a flat list of nodes.
function loadNodes() {
  const dir = PATHS.claimsDir;
  if (!fs.existsSync(dir)) return [];
  const nodes = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const cf = readJSON(path.join(dir, file), null);
    if (!cf || !Array.isArray(cf.claims)) continue;
    for (const c of cf.claims) {
      nodes.push({
        claim_id: c.claim_id,
        question_id: cf.question_id,
        reliability: c.reliability,
        text: c.text || "",
        sources: (c.sources || []).map((s) => s.url).filter(Boolean),
        keywords: keywords(c.text || ""),
        negation: NEG.test(c.text || ""),
      });
    }
  }
  return nodes;
}

function buildGraph(nodes, { overlapThreshold = 0.18 } = {}) {
  const edges = [];
  const contradictions = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      // Only relate claims from DIFFERENT questions (cross-question links).
      if (a.question_id === b.question_id) continue;

      const sharedSources = a.sources.filter((u) => b.sources.includes(u));
      const kw = jaccard(a.keywords, b.keywords);

      let relation = null;
      if (sharedSources.length > 0) relation = "shared-source";
      else if (kw >= overlapThreshold) relation = "topical";

      if (!relation) continue;

      edges.push({
        from: a.claim_id,
        to: b.claim_id,
        from_question: a.question_id,
        to_question: b.question_id,
        relation,
        shared_sources: sharedSources,
        keyword_overlap: Number(kw.toFixed(3)),
      });

      // Contradiction candidate: related claims where exactly one negates.
      if (a.negation !== b.negation && (sharedSources.length > 0 || kw >= overlapThreshold)) {
        contradictions.push({
          claims: [a.claim_id, b.claim_id],
          questions: [a.question_id, b.question_id],
          reason:
            sharedSources.length > 0
              ? "opposing polarity on a shared source"
              : "opposing polarity on a strongly overlapping topic",
          shared_sources: sharedSources,
          keyword_overlap: Number(kw.toFixed(3)),
        });
      }
    }
  }

  return { edges, contradictions };
}

function run({ persist = true } = {}) {
  const nodes = loadNodes();
  const { edges, contradictions } = buildGraph(nodes);
  const disputed = nodes
    .filter((n) => n.reliability === "disputed")
    .map((n) => ({ claim_id: n.claim_id, question_id: n.question_id }));

  const graph = {
    schema_version: 2,
    generated_at: nowISO(),
    node_count: nodes.length,
    edge_count: edges.length,
    nodes: nodes.map((n) => ({
      claim_id: n.claim_id,
      question_id: n.question_id,
      reliability: n.reliability,
      source_count: n.sources.length,
    })),
    edges,
  };

  if (persist) writeJSON(PATHS.graph, graph);

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    disputed,
    contradictions,
    graph,
  };
}

// ── CLI entry point ─────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const asJSON = argv.includes("--json");
  const checkMode = argv.includes("--check");
  const result = run({ persist: true });

  if (asJSON) {
    console.log(
      JSON.stringify(
        {
          node_count: result.nodeCount,
          edge_count: result.edgeCount,
          disputed: result.disputed,
          contradictions: result.contradictions,
        },
        null,
        2
      )
    );
  } else {
    console.log(`✓ Consistency graph written to ${path.relative(PATHS.root, PATHS.graph)}`);
    console.log(`  claims (nodes) : ${result.nodeCount}`);
    console.log(`  relationships  : ${result.edgeCount}`);
    console.log(`  disputed claims: ${result.disputed.length}`);
    console.log(`  contradictions : ${result.contradictions.length}`);
    for (const c of result.contradictions) {
      console.log(
        `    ⚠ ${c.claims.join(" <> ")} (${c.questions.join(", ")}) — ${c.reason}`
      );
    }
  }

  if (checkMode && result.contradictions.length > 0) {
    console.error(
      `\n✗ ${result.contradictions.length} contradiction candidate(s) found. ` +
        `Review before publishing.`
    );
    process.exit(1);
  }
}

module.exports = { run, buildGraph, loadNodes, keywords, jaccard };
