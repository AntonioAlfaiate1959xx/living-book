# Wiring the Canon & Consistency Review stage into CI

> **Why this is a manual step.** The automation that opened this PR authenticates
> as a GitHub App that does **not** hold the `workflows` permission, so it is not
> allowed to create or modify files under `.github/workflows/`. The one-line
> workflow addition below therefore has to be applied by a maintainer (it is a
> trivial, additive change). Everything else in the PR — the review script, the
> `claims/` store, the schema, and the scaffold — is included and ready.

The Canon & Consistency Review stage runs **after** the refresh/Harmonize step
and **before** the book is rebuilt. It is non-blocking (`continue-on-error: true`
plus the script's own `exit 0`), so it can never fail the pipeline.

## What to change

In [`.github/workflows/update.yml`](../.github/workflows/update.yml), insert the
step below **between** the existing `Refresh every active question (v2 orchestrator)`
step and the `Rebuild the published book (v2)` step:

```yaml
      # ── Stage 6.5 — Canon & Consistency Review (non-blocking) ──────────
      # Runs AFTER Harmonize (voice charter / coherence pass) and BEFORE the
      # book is rebuilt/verified. Builds versioned claim nodes and runs the
      # contradiction-detection engine. It NEVER halts the pipeline: disputes
      # and errors are quarantined and surfaced in the run report for the
      # author's loop. `continue-on-error: true` plus the script's own exit-0
      # guarantee make this stage strictly additive.
      - name: Canon & Consistency Review (Stage 6.5, non-blocking)
        continue-on-error: true
        run: |
          node scripts/consistency-review.mjs
          echo "----- Canon Review — Open Disputes -----"
          latest="$(ls -1 reports/consistency-*.md 2>/dev/null | tail -1)"
          if [ -n "$latest" ]; then
            echo "Report: $latest"
            # Surface the disputes section in the Actions log / job summary.
            sed -n '/## Canon Review — Open Disputes/,$p' "$latest" | head -60
            {
              echo "## Canon & Consistency Review (Stage 6.5)"
              sed -n '/## Summary/,/## Canon Review/p' "$latest"
              sed -n '/## Canon Review — Open Disputes/,$p' "$latest" | head -60
            } >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
          fi
```

## Applying the included patch

The exact diff is committed alongside this doc as
[`consistency-review-workflow.patch`](./consistency-review-workflow.patch). From
the repo root a maintainer can apply it with:

```bash
git apply docs/consistency-review-workflow.patch
git add .github/workflows/update.yml
git commit -m "ci: wire in Canon & Consistency Review stage (non-blocking)"
```

That is the only step that requires elevated (`workflows`) permission; the rest
of the layer works as soon as this PR is merged.

## Running the stage manually

```bash
npm run consistency:review
# or, tuning the topical-overlap gate:
CONSISTENCY_GATE=0.4 node scripts/consistency-review.mjs
```
