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

> **Phase 2 is now implemented** — see the "Phase 2" section at the end of this
> document for the multi-agent ensemble, the cross-question consistency checker
> and claim graph, and the human-in-the-loop scheduled workflow.

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



---

# Phase 2 — Multi-Agent Ensemble, Consistency Graph & CI

Phase 2 builds on Phase 1 without changing any of its data schemas. It is
still **additive and offline-safe**: every model-calling code path has a
deterministic `--mock` mode, tests never touch the network, and nothing is
ever pushed to `main` or deployed automatically.

## 1. The multi-agent ensemble

The single-shot orchestrator is upgraded into a three-stage pipeline. Each
stage is an independent, testable module under `scripts/agents/`:

```
Research  →  Verification  →  Synthesis
```

| Stage | File | Responsibility |
|-------|------|----------------|
| Research | `scripts/agents/research-agent.js` | Gather candidate findings + source URLs. Does **not** judge reliability. |
| Verification | `scripts/agents/verification-agent.js` | Independently classify each source (`classifySource`), assign a reliability grade, and flag conflicting findings as `disputed`. |
| Synthesis | `scripts/agents/synthesis-agent.js` | Merge only the *verified* findings into a schema-valid claim set + summary; surface disputes under `disputed_aspects`. |
| Runner | `scripts/agents/ensemble.js` | Chains the three stages for one question and returns a claim-file object (does not write to disk). |

The reliability rule is deterministic: **high-credibility** sources →
`established`, **medium** → `emerging`, **no usable source** → cannot be
`established` and is not marked `verified`, **conflicting polarity** →
`disputed`. This enforces the project rule that *no claim is published merely
because a model can write it.*

### Running the ensemble

```bash
# Offline, deterministic — safe for demos and CI:
npm run ensemble -- --question-id q001 --mock

# Live (requires the environment variable; never hardcoded):
ABACUS_API_KEY=... npm run ensemble -- --question-id q001
```

The ensemble path appends its new claims after any existing ones (ids never
collide), bumps the question's edition, and writes an immutable ledger entry
authored by `ensemble` / `ensemble(mock)`. The default single-shot path
(`npm run orchestrate`) is unchanged.

## 2. Cross-question consistency checker & claim graph

`scripts/consistency-check.js` builds a relationship graph across **all**
claim files and flags potential contradictions before publication.

- **Graph** (`data/graph.json`): nodes are claims; an edge links two claims
  from *different* questions when they share a source URL (`shared-source`)
  or have strong keyword overlap (`topical`).
- **Contradiction candidates**: related claims with opposing polarity (one
  negates the other) are reported for editorial review.

```bash
npm run consistency          # write data/graph.json + print a report
npm run consistency:check    # same, but exit 1 if contradictions exist (CI gate)
node scripts/consistency-check.js --json   # machine-readable output
```

On the current migrated data this reports **69 claims, 133 cross-question
relationships, 0 contradictions**.

## 3. Human-in-the-loop automation (`.github/workflows/living-book-v2.yml`)

A new workflow, kept separate from the legacy `update.yml`, enforces the
"stop before publishing" rule:

- **`ci` job** — on every push/PR to `feature/living-book-v2`: runs the full
  test suite and the consistency gate. No secrets required.
- **`refresh` job** — scheduled (weekly) or manual: runs the ensemble
  (mock unless `ABACUS_API_KEY` is configured as a repo secret), rebuilds the
  graph, and **opens a Pull Request** via `peter-evans/create-pull-request`.
  It **never pushes to `main` and never deploys** — a human reviews and merges.

## 4. Tests

Phase 2 adds mock-only suites (all run with `npm test`):

- `tests/research-agent.test.js`
- `tests/verification-agent.test.js`
- `tests/synthesis-agent.test.js`
- `tests/ensemble.test.js` (full pipeline + orchestrator `--ensemble` path)
- `tests/consistency-check.test.js`

Total: **41 tests passing** (19 from Phase 1 + 22 new).

## 5. Safety recap

- No credentials in code — `ABACUS_API_KEY` is read from the environment only.
- Every model call has a deterministic `--mock`; tests make no network calls.
- `main`, the legacy `docs/` site, and all migrated `data/` / `editions/`
  files are untouched by Phase 2.
- Automated refreshes open a PR for review; they never merge or deploy.

---

# Phase 3 — Publishing Bridge: v2 Data → GitHub Pages

Phase 3 completes the circle: the v2 data structures (claim files, registry, ledger) now **feed directly into the published GitHub Pages site**. The legacy `build.js` remains untouched on `main`, while the v2 build produces an identical output format from the new data.

## 1. Claim-to-HTML rendering (`scripts/render-claim.js`)

Converts a schema-valid claim file into a reader-facing HTML section:
- **Answer summary** — the synthesized text from `answer_summary`.
- **Sources** — all sources from all claims, deduplicated and sorted by credibility (high → medium → low), with visible credibility badges.
- **Disputed aspects** — surfaced prominently in a yellow-highlighted `<details>` box so readers always see competing perspectives.
- **Security** — all user-controlled content (question text, source titles, URLs) is HTML-escaped; only `http://` and `https://` URLs are allowed (others replaced with `#`).

## 2. v2-aware build (`scripts/build-v2.js`)

Generates `docs/index.html` from the v2 data:
- Reads `data/question-registry.json` (instead of `questions/questions.json`).
- Reads `data/claims/qNNN.json` (instead of `answers/qNNN.json`).
- Reads `editions/ledger.json` (instead of `changelog/changelog.json`).
- Groups questions by chapter, renders each with `renderClaim`, and appends the edition ledger as the appendix.
- Output is a single-page HTML book **identical in structure** to the legacy build, preserving all GitHub Pages behavior.

```bash
npm run build:v2   # writes docs/index.html from v2 data
```

On the current migrated data, this produces **100 active questions across 12 chapters, Edition 1**.

## 3. Tests (10 new, 51 total passing)

Phase 3 adds:
- `tests/render-claim.test.js` — HTML escaping, Markdown conversion, source deduplication, disputed-aspect surfacing.
- `tests/build-v2.test.js` — end-to-end build validation, XSS prevention, schema conformance.

All tests pass; no network, no credentials, no `docs/` writes during test runs.

## 4. Migration path

The legacy and v2 build systems coexist on `feature/living-book-v2`:
- `npm run build` — legacy path (unchanged, reads `questions/` and `answers/`).
- `npm run build:v2` — v2 path (reads `data/` and `editions/`).

When this branch is merged to `main`, the GitHub Pages workflow can switch from `build.js` to `build-v2.js`, and the v2 data becomes the single source of truth for the published site. Until then, both work independently.



---

# Phase 4 — Back Office (admin control panel)

A dependency-free web dashboard for operating every change and action from one
place, instead of remembering CLI flags.

## Run it

```bash
npm run backoffice          # starts on http://localhost:3000
PORT=4000 npm run backoffice  # custom port
```

Then open the printed URL. To enable live AI refreshes, export your key before
starting the server:

```bash
export ABACUS_API_KEY=your_key_here
npm run backoffice
```

## What it does

| Tab | Capability |
|-----|-----------|
| **Dashboard** | Live totals (questions, answered, proposed, editions, claim nodes, relationships, contradictions, disputed). Quick actions: run consistency check, build site. |
| **Questions** | Searchable/filterable table of all 100+ questions. Click a row to see the rendered claim, sources and disputed aspects. "Refresh" opens a dialog to regenerate the answer. |
| **Propose** | Add a new question (question / chapter / rationale). Enters the registry with status `proposed`. |
| **Refresh dialog** | Choose pipeline (**Single-shot** or **Multi-agent ensemble**) and mode (**Mock** offline or **Live AI**). Live mode is disabled automatically when no API key is set. |
| **Editions** | The immutable, append-only edition ledger. |
| **Consistency** | Consistency-graph stats and any contradictions; re-run on demand. |
| **Logs** | Tail of `logs/orchestration.log`. |

## How it is built

- `scripts/server.js` — Node built-in `http` server. No frameworks, no new
  dependencies. It requires the existing script modules
  (`orchestrate`, `propose-question`, `consistency-check`, `render-claim`)
  and exposes them as a small JSON API:
  - `GET /api/status`, `GET /api/questions[/:id]`, `GET /api/editions`,
    `GET /api/graph`, `GET /api/logs`
  - `POST /api/propose`, `POST /api/refresh`, `POST /api/consistency`,
    `POST /api/build`
- `admin/` — static single-page front end (`index.html`, `styles.css`,
  `app.js`). Served by the same server.

## Safety

- Reuses the exact same functions as the CLI — the dashboard cannot do
  anything the scripts don't already do.
- Live mode requires `ABACUS_API_KEY` **on the server**; the key is never sent
  to the browser or written to disk.
- Path-traversal protection on static file serving; request bodies capped.
- `tests/server.test.js` covers the data-assembly helpers and the read-only
  HTTP endpoints (56 tests total, all passing; no network, no data writes).
