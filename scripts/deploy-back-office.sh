#!/usr/bin/env bash
# deploy-back-office.sh — Safe CODE-ONLY deploy of origin/main to the live Back Office
#
# WHY THIS IS A CODE-ONLY OVERLAY (not `git pull`):
#   The live host is the source of truth for DATA. The running service continuously
#   writes the book's data lineage (editions, answers, claim nodes, disputes, reports)
#   directly into this working tree. A plain `git pull` / `git merge` would overwrite
#   that live data with whatever is on GitHub and could also swap the ensemble pipeline
#   scripts, breaking generation. So instead of merging, this script checks out ONLY
#   code from origin/main and never touches the protected live-data paths below.
#
# WHAT IS PROTECTED (never overwritten by this script):
#   - data/            live claim data, graph.json, question-registry.json
#   - answers/         generated answers
#   - editions/        ledger.json (edition lineage)
#   - questions/       questions.json
#   - changelog/       changelog.json
#   - quarantine/      quarantined records
#   - docs/index.html  the published site page
#   - reports/         consistency run reports (human-reviewed)
#   - claims/q*        per-question claim NODES (canon data)
#   - claims/disputes  dispute records (human-in-the-loop resolutions)
#   - claims/versions  versioned claim history
#   - scripts/orchestrate.js, scripts/build-v2.js  live ensemble pipeline (diverged on purpose)
#   - .github/         CI workflows (GitHub App lacks the `workflows` scope)
#
# WHAT IS DEPLOYED (overlaid from origin/main): everything else that is tracked —
#   Back Office server & UI (scripts/server.js, scripts/lib.js, admin/*),
#   Stage 6.5 tooling (scripts/consistency-review.mjs, claims/README.md, schema),
#   tests, package.json / package-lock.json, docs (except index.html), this script.
#
# NOTE: this script overlays itself from origin/main, so the canonical copy lives on
#   GitHub. Land any change to this file on origin/main first; otherwise the next run
#   reverts a local-only edit back to origin's version.
#
# Usage (on the deployment server b758bcce6):
#   bash scripts/deploy-back-office.sh
#
# Or run remotely via SSH:
#   ssh ubuntu@b758bcce6.abacusai.cloud "cd /home/ubuntu/github_repos/living-book && bash scripts/deploy-back-office.sh"

set -euo pipefail

REPO_DIR="/home/ubuntu/github_repos/living-book"
LOG="/tmp/deploy-back-office.log"

# Protected live-data paths — passed as git pathspec exclusions so the overlay
# can never modify them. Keep this list in sync with the header comment above.
PROTECT=(
  ':(exclude)data'
  ':(exclude)answers'
  ':(exclude)editions'
  ':(exclude)questions'
  ':(exclude)changelog'
  ':(exclude)quarantine'
  ':(exclude)docs/index.html'
  ':(exclude)reports'
  ':(exclude)claims/q*'
  ':(exclude)claims/disputes'
  ':(exclude)claims/versions'
  ':(exclude)scripts/orchestrate.js'
  ':(exclude)scripts/build-v2.js'
  ':(exclude).github'
)

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"
}

log "=== BACK OFFICE DEPLOYMENT STARTED (code-only overlay) ==="

# ── 1. Ensure we're in the repo directory ────────────────────────────────
if [[ ! -d "$REPO_DIR" ]]; then
  log "ERROR: Repository directory $REPO_DIR does not exist."
  exit 1
fi

cd "$REPO_DIR"
log "Working directory: $(pwd)"

# ── 2. Fetch latest origin/main (no merge, no checkout of data) ────────────
log "Fetching origin/main..."
git fetch origin main
TARGET=$(git rev-parse origin/main)
log "origin/main is at: $TARGET"

# ── 3. Snapshot live data (safety net) ─────────────────────────────────────
# A lightweight tar of the protected data so any surprise is instantly recoverable.
SNAP="/tmp/living-book-data-snapshot-$(date -u +%Y%m%d-%H%M%S).tar.gz"
tar czf "$SNAP" \
  data answers editions questions changelog quarantine docs/index.html \
  reports claims 2>/dev/null || true
log "Live-data snapshot: $SNAP"

# ── 4. Code-only overlay from origin/main ─────────────────────────────────
# Checks out every tracked file from origin/main EXCEPT the protected paths.
# This updates code in the working tree without touching any live data and
# without deleting untracked live files.
log "Overlaying code from origin/main (protected data excluded)..."
CHANGED_BEFORE=$(git diff --name-only origin/main -- . "${PROTECT[@]}" | wc -l | tr -d ' ')

git checkout origin/main -- . "${PROTECT[@]}"

# Report what the overlay actually changed in the working tree.
if [[ "$CHANGED_BEFORE" == "0" ]]; then
  log "Code already in sync with origin/main — no code files changed."
else
  log "✓ Overlaid $CHANGED_BEFORE code file(s) from origin/main."
  git status --porcelain -- . "${PROTECT[@]}" | head -20 | \
    while IFS= read -r line; do log "  $line"; done
fi

# ── 4b. Safety assertion — protected data must be untouched ────────────────
DIRTY_DATA=$(git status --porcelain -- \
  data answers editions questions changelog quarantine docs/index.html \
  reports 'claims/q*' claims/disputes claims/versions \
  scripts/orchestrate.js scripts/build-v2.js | wc -l | tr -d ' ')
if [[ "$DIRTY_DATA" != "0" ]]; then
  log "ERROR: overlay unexpectedly modified protected live-data paths — aborting."
  log "Restore from snapshot if needed: tar xzf $SNAP"
  git status --porcelain -- \
    data answers editions questions changelog quarantine docs/index.html \
    reports 'claims/q*' claims/disputes claims/versions \
    scripts/orchestrate.js scripts/build-v2.js | \
    while IFS= read -r line; do log "  $line"; done
  exit 1
fi
log "✓ Safety check passed — no live-data or pipeline files were modified."

# ── 5. Commit the overlaid code (keeps the working tree traceable) ─────────
# The live repo's main intentionally diverges from origin (it keeps live data +
# the live pipeline scripts), so we commit the code overlay locally rather than
# fast-forwarding. Nothing is pushed.
if [[ -n "$(git status --porcelain -- . "${PROTECT[@]}")" ]]; then
  git add -- . "${PROTECT[@]}"
  git -c user.name="Living Book Bot" -c user.email="bot@living-book.local" \
    commit -q -m "deploy: code-only overlay from origin/main ($TARGET)" || true
  log "✓ Committed code overlay locally (live data preserved)."
fi

# ── 6. Install/update dependencies if needed ──────────────────────────────
if [[ -f "package.json" ]] && [[ -f "package-lock.json" ]]; then
  log "Installing dependencies (npm ci --omit=dev)..."
  if npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3 | while IFS= read -r line; do log "  npm: $line"; done; then
    log "✓ Dependencies installed."
  else
    log "⚠ npm ci had issues; retrying with npm install..."
    npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3 | \
      while IFS= read -r line; do log "  npm: $line"; done || \
      log "⚠ npm install also reported issues (may be safe to ignore)."
  fi
fi

# ── 7. Restart the Back Office service ────────────────────────────────────
log "Restarting living-book-admin service..."

if command -v systemctl &>/dev/null; then
  sudo systemctl restart living-book-admin 2>&1 | while IFS= read -r line; do log "  systemctl: $line"; done
  sleep 3

  STATUS=$(systemctl is-active living-book-admin 2>/dev/null || echo "unknown")
  log "Service status: $STATUS"

  if [[ "$STATUS" == "active" ]]; then
    log "✓ Back Office service is running."
    log "Recent service logs:"
    sudo journalctl -u living-book-admin --since "5 seconds ago" -n 10 --no-pager 2>/dev/null | \
      while IFS= read -r line; do log "  $line"; done
  else
    log "⚠ Service status is '$STATUS' — check logs:"
    log "  sudo journalctl -u living-book-admin -n 50"
    exit 1
  fi
else
  log "⚠ systemctl not available — you may need to manually restart the service."
fi

# ── 8. Verify deployment ──────────────────────────────────────────────────
log "Verifying deployment..."
sleep 2

if command -v curl &>/dev/null; then
  RESPONSE=$(curl -s --max-time 5 http://localhost:4610/api/status || echo "{}")

  if echo "$RESPONSE" | grep -q "\"ok\":true"; then
    log "✓ API health check passed."
    if echo "$RESPONSE" | grep -q "claimNodes"; then
      log "✓ Canon & Consistency Review fields detected (Stage 6.5 live)."
    else
      log "⚠ Canon fields not found — may need a hard refresh or check the code."
    fi
  else
    log "⚠ API health check failed or timed out."
  fi
fi

log "=== BACK OFFICE DEPLOYMENT COMPLETE ==="
log "Public URL: https://b758bcce6.abacusai.cloud"
