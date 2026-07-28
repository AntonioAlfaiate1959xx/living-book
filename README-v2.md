# Living Book v2 — Reliability-First Architecture (Phase 1)

This document describes the **Phase 1** redesign of the Living Book, implemented
on the `feature/living-book-v2` branch. It is **additive**: every legacy file on
`main` (`questions/`, `answers/`, `changelog/`, `docs/`, `scripts/update.js`,
`scripts/build.js`) is left untouched, and the GitHub Pages site continues to
build exactly as before. The new machinery lives alongside it.

Phase 1 delivers a working, testable foundation for treating the book as an
evolving, **claim + source + edition** knowledge base rather than a flat set of
essay answers.

---

## What Phase 1 adds

| Area | Legacy (`main`) | v2 (this branch) |
|------|------------------|------------------|
| Answers | `answers/qNNN.json` (one essay + flat sources) | `data/claims/qNNN.json` (structured claims, typed & graded sources) |
| Question list | `questions/questions.json` | `data/question-registry.json` (adaptive registry: active / proposed / deprecated) |
| History | `changelog/changelog.json` | `editions/ledger.json` (immutable edition ledger) |
| Refresh | `scripts/update.js` (Anthropic, all questions) | `scripts/orchestrate.js` (one question, mock or Abacus.AI) |
| Growth | manual edit | `scripts/propose-question.js` (validated proposals) |
| Tests | `prepublish_check.py` | `tests/*.test.js` (Node built-in test runner) |

**Explicitly deferred to Phase 2:** the full 16-agent ensemble, a knowledge
graph / vector store, cross-question consistency checking, and an automated
PR/merge pipeline.

---

## Directory layout (new files only)

```
data/
  question-registry.json      # every question + lifecycle status
  claims/
    q001.json ... q069.json   # one claim file per answered question
editions/
  ledger.json                 # immutable record of every edition
logs/
  orchestration.log           # append-only run log (git-ignored)
scripts/
  lib.js                      # shared helpers + schema validators
  migrate.js                  # legacy -> v2 migration (one-time / idempotent)
  propose-question.js         # CLI: propose a new question
  orchestrate.js              # CLI: refresh one question (mock or live)
tests/
  schema.test.js              # validates registry + all claim files
  propose-question.test.js    # unit tests for proposal logic
  orchestrate.test.js         # tests orchestrator in mock mode
README-v2.md                  # this file
```

---

## Schema

### `data/question-registry.json`

An adaptive registry of **all** questions (the initial 100 plus any future
proposals). Each entry:

```json
{
  "id": "q001",
  "status": "active",              // active | deprecated | proposed
  "chapter": "Chapter 1: Philosophical Foundations — Why Do We Educate?",
  "chapter_number": 1,
  "position": 1,
  "question": "What is the purpose of education ...?",
  "rationale": "Migrated from legacy questions.json (initial 100-question set).",
  "added_in_edition": 1,
  "deprecated_in_edition": null,
  "superseded_by": null
}
```

### `data/claims/qNNN.json`

One file per answered question. Each legacy essay became a single
`established` claim carrying the full text and all its cited sources; sources
are typed and credibility-graded so future editing can reason about them.

```json
{
  "question_id": "q001",
  "question_text": "...",
  "current_edition": 1,
  "claims": [
    {
      "claim_id": "q001-c01",
      "text": "... full answer text ...",
      "reliability": "established",       // established | emerging | disputed | deprecated
      "sources": [
        {
          "url": "https://arxiv.org/pdf/2605.12757",
          "title": "A Framework for institutional change in the age of AI",
          "type": "academic",             // academic | news | official | practitioner
          "retrieved": "2026-07-03",
          "credibility": "high"           // high | medium | low
        }
      ],
      "perspectives": [],
      "last_verified": "2026-07-03",
      "added_edition": 1
    }
  ],
  "answer_summary": "...",
  "disputed_aspects": [],
  "legacy": { "lastUpdated": "...", "lastChecked": "...", "history": [] }
}
```

> Source `type`/`credibility` are seeded by URL heuristics during migration
> (see `classifySource` in `scripts/lib.js`) and can be refined by editors.

### `editions/ledger.json`

An append-only ledger. Edition 1 is the initial migration; each orchestrator
run appends a new edition recording exactly what changed.

```json
{
  "editions": [
    {
      "edition_number": 1,
      "created_at": "2026-07-28T20:05:00Z",
      "description": "Initial migration from legacy format ...",
      "questions_updated": [],
      "questions_added": ["q001", "q002", "..."],
      "questions_deprecated": [],
      "author": "migration-script"
    }
  ]
}
```

---

## How to run

All commands run from the repository root. Requires **Node.js ≥ 18** (uses the
built-in `fetch` and `node:test`). No `npm install` is needed — the tooling uses
only Node built-ins.

### 1. Migrate legacy data into the v2 schema

```bash
node scripts/migrate.js      # or: npm run migrate
```

Idempotent: reads `questions/questions.json` + `answers/*.json` and (re)writes
`data/question-registry.json`, `data/claims/*.json`, and seeds
`editions/ledger.json` if it does not already exist.

### 2. Propose a new question

```bash
node scripts/propose-question.js \
  --question "How should institutions govern agentic AI tutors?" \
  --chapter  "Chapter 12: Frontiers — Emerging Territories" \
  --rationale "Agentic tutors emerged as a category in 2026."
```

- Validates the input and rejects **exact duplicates** (case/punctuation
  insensitive).
- Appends a `proposed` entry to the registry with the next free id.
- Does **not** create a claim file — a proposal has no answer until approved
  and refreshed.

### 3. Refresh one question with the orchestrator

**Mock mode** (offline, deterministic, no API key — used by tests and dry-runs):

```bash
node scripts/orchestrate.js --question-id q001 --mock
```

**Live mode** (calls the Abacus.AI API):

```bash
export ABACUS_API_KEY=...     # never hardcoded; read only from the environment
node scripts/orchestrate.js --question-id q001
# optional: override the endpoint with ABACUS_API_ENDPOINT
```

On success the orchestrator:
1. verifies the question is active in the registry,
2. fetches a fresh answer (mock or Abacus.AI),
3. appends a new claim and bumps the question's `current_edition`,
4. appends a new immutable entry to `editions/ledger.json`,
5. promotes a `proposed` question to `active` on its first successful refresh,
6. logs every action to `logs/orchestration.log`.

### 4. Run the tests

```bash
npm test        # node --test tests/*.test.js
```

Tests are fully offline: the orchestrator is exercised only in **mock mode** and
with an injected provider, and all mutating tests use `persist: false` so they
never touch the real `data/` or `editions/` files. No API key is required.

---

## Design notes & safety

- **Credentials** are only ever read from `process.env.ABACUS_API_KEY`. Nothing
  is hardcoded or written to disk. `logs/*.log` is git-ignored.
- **`main` is never modified.** The legacy publish pipeline (`build.js` →
  `docs/`) is unchanged, so GitHub Pages keeps working.
- **The ledger is append-only.** Refreshes add editions; they never rewrite
  history.
- **No new dependencies.** Everything uses Node.js built-ins, keeping the repo
  install-free and easy to audit.
