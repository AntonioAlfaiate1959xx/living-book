# `claims/` — Versioned Claim-Node Store

This directory is the persistent, additive, provenance-bearing claim-node store
produced by the **Canon & Consistency Review** layer (Stage 6.5) of the Living
Book update cycle. It is written by [`scripts/consistency-review.mjs`](../scripts/consistency-review.mjs)
and implements patent **FIG. 2–4** of the Living Book architecture.

> This layer is **additive and non-blocking**. It never edits the existing
> answer/claim pipeline, never deletes prior versions, and never halts a run.
> Errors and disputes are quarantined and logged for the author's loop.

## Layout

```
claims/
├── claim-node.schema.json     JSON Schema for a claim-node record (FIG. 2)
├── README.md                  this file
├── <qid>/                     one directory per question (q### format)
│   ├── <claimId>.json         the latest version of a claim node (status: active)
│   └── versions/
│       └── <claimId>.v<n>.json archived prior versions (status: superseded)
└── disputes/
    └── <timestamp>-<qid>-<id>.json  one record per suspected contradiction
```

The per-question node directories (`claims/q001/`, …) and dispute records are
**generated at runtime** by the review stage and committed back by the update
workflow. Only the scaffold (this README, the schema, and `.gitkeep`
placeholders) is checked in initially.

## Claim-node record

Each node follows [`claim-node.schema.json`](./claim-node.schema.json) (FIG. 2):

| Field | Meaning |
| --- | --- |
| `claimId` | Persistent id `clm-<uuid-v4>` |
| `questionId` | Owning question, `q###` |
| `claimText` | Natural-language assertion |
| `status` | `active` \| `superseded` \| `retracted` |
| `version` | Monotonic integer |
| `validityInterval` | `{ validFrom, validUntil }` |
| `confidence` | `{ score 0.0–1.0, level }` inferred from supporting-source count |
| `provenanceEdges` | `[{ sourceId, url, relation, credibility }]` |
| `contradictionStatus` | `none` \| `suspected` \| `confirmed` |
| `disputeStatus` | `none` \| `open` \| `resolved` |
| `contradicts` | `[claimId, …]` |
| `meta` | bookkeeping (`normalizedText`, timestamps, source count) |

## How nodes are built (FIG. 3)

1. Collect claim inputs from the provenance-bearing manifests
   (`data/claims/<qid>.json`, falling back to `answers/<qid>.json`).
2. Extract assertion sentences from the answer text and normalize them.
3. Derive stable `sourceId`s from source URLs (`sha256(url)` → first 12 hex).
4. Merge inputs per `(questionId, normalized text)`.
5. Infer confidence from the supporting-source count
   (`score = min(1.0, count × 0.33)`; `low <0.4`, `medium <0.7`, `high ≥0.7`).
6. Load existing nodes for the question. If the text or provenance changed,
   **archive the old version** and write an incremented version; if the claim
   is new, create a new node. Old versions are never overwritten.

## How contradictions are detected (FIG. 4)

1. Load active claim nodes grouped by `questionId`.
2. Tokenize each claim, drop stopwords, keep content words.
3. For each pair, compute Jaccard topical overlap.
4. If overlap ≥ the gate (`CONSISTENCY_GATE`, default `0.35`), assess the pair
   for an **antonym conflict** (e.g. *increase/decrease*) or a
   **negation-polarity difference** (one claim negated, the other not).
5. If a contradiction is indicated, set both nodes'
   `contradictionStatus = "suspected"` and `disputeStatus = "open"`, record
   `contradicts[]`, and write a dispute record + a run-report entry for human
   review. Otherwise the nodes are left unchanged (no halt).

Open disputes surface in `reports/consistency-<YYYY-MM-DD>.md` under
**"Canon Review — Open Disputes"**, which the author reviews in the author's
loop (Zone 4). Resolving a dispute is a human action.
