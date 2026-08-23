#!/usr/bin/env bash
# deploy-back-office.sh — Deploy the latest main branch to the live Back Office
#
# This script pulls the latest code from main and restarts the service.
# 
# Usage (on the deployment server b758bcce6):
#   bash scripts/deploy-back-office.sh
#
# Or run remotely via SSH:
#   ssh ubuntu@b758bcce6.abacusai.cloud "cd /home/ubuntu/github_repos/living-book && bash scripts/deploy-back-office.sh"

set -euo pipefail

REPO_DIR="/home/ubuntu/github_repos/living-book"
LOG="/tmp/deploy-back-office.log"

log() { 
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"
}

log "=== BACK OFFICE DEPLOYMENT STARTED ==="

# ── 1. Ensure we're in the repo directory ────────────────────────────────
if [[ ! -d "$REPO_DIR" ]]; then
  log "ERROR: Repository directory $REPO_DIR does not exist."
  exit 1
fi

cd "$REPO_DIR"
log "Working directory: $(pwd)"

# ── 2. Check current branch and status ────────────────────────────────────
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
log "Current branch: $CURRENT_BRANCH"

if [[ "$CURRENT_BRANCH" != "main" ]]; then
  log "Switching to main branch..."
  git checkout main
fi

# ── 3. Pull latest changes from origin/main ───────────────────────────────
log "Pulling latest changes from origin/main..."
git fetch origin main
BEFORE=$(git rev-parse HEAD)
git pull origin main
AFTER=$(git rev-parse HEAD)

log "Before: $BEFORE"
log "After:  $AFTER"

if [[ "$BEFORE" == "$AFTER" ]]; then
  log "Already up to date — no new commits."
else
  log "✓ Pulled $(git rev-list --count $BEFORE..$AFTER) new commit(s)."
  log "Latest commit:"
  git log -1 --oneline | while IFS= read -r line; do log "  $line"; done
fi

# ── 4. Install/update dependencies if needed ──────────────────────────────
if [[ -f "package.json" ]] && [[ -f "package-lock.json" ]]; then
  log "Checking for npm dependency updates..."
  if npm ci --production --silent 2>&1 | grep -v "^$" | head -5 | while IFS= read -r line; do log "  npm: $line"; done; then
    log "✓ Dependencies up to date."
  else
    log "⚠ npm ci encountered issues (may be safe to ignore)."
  fi
fi

# ── 5. Restart the Back Office service ────────────────────────────────────
log "Restarting living-book-admin service..."

if command -v systemctl &>/dev/null; then
  sudo systemctl restart living-book-admin 2>&1 | while IFS= read -r line; do log "  systemctl: $line"; done
  sleep 3
  
  STATUS=$(systemctl is-active living-book-admin 2>/dev/null || echo "unknown")
  log "Service status: $STATUS"
  
  if [[ "$STATUS" == "active" ]]; then
    log "✓ Back Office service is running."
    
    # Show recent logs
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

# ── 6. Verify deployment ──────────────────────────────────────────────────
log "Verifying deployment..."
sleep 2

if command -v curl &>/dev/null; then
  RESPONSE=$(curl -s --max-time 5 http://localhost:4610/api/status || echo "{}")
  
  if echo "$RESPONSE" | grep -q "\"ok\":true"; then
    log "✓ API health check passed."
    
    # Check for Canon fields (PR #7)
    if echo "$RESPONSE" | grep -q "claimNodes"; then
      log "✓ Canon & Consistency Review fields detected (PR #7 deployed)."
    else
      log "⚠ Canon fields not found — may need a hard refresh or check the code."
    fi
  else
    log "⚠ API health check failed or timed out."
  fi
fi

log "=== BACK OFFICE DEPLOYMENT COMPLETE ==="
log "Public URL: https://b758bcce6.abacusai.cloud"
