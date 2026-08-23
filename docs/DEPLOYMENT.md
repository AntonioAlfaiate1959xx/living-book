# Back Office Deployment Guide

## Overview

The Living Book Back Office runs at **https://b758bcce6.abacusai.cloud** on an Abacus-managed cloud VM. This guide explains how to deploy updates after merging changes to the `main` branch.

## Deployment Architecture

- **Server**: `b758bcce6.abacusai.cloud` (Abacus-managed VM)
- **Service**: `living-book-admin` (systemd service)
- **Code**: `/home/ubuntu/github_repos/living-book` (Git repository)
- **Port**: 4610 (local), proxied to port 80/443 via nginx
- **Config**: 
  - Systemd unit: `deploy/living-book-admin.service`
  - Nginx proxy: `deploy/b758bcce6.conf`

## Quick Deploy

### Option 1: SSH Deploy (Recommended)

If you have SSH access to the deployment server:

```bash
# From your local machine or this VM
ssh ubuntu@b758bcce6.abacusai.cloud "cd /home/ubuntu/github_repos/living-book && bash scripts/deploy-back-office.sh"
```

Or SSH in and run manually:

```bash
ssh ubuntu@b758bcce6.abacusai.cloud
cd /home/ubuntu/github_repos/living-book
bash scripts/deploy-back-office.sh
```

The deployment script will:
1. Pull the latest `main` branch
2. Update dependencies if needed
3. Restart the `living-book-admin` systemd service
4. Verify the deployment

### Option 2: Manual Deployment

If SSH fails or you prefer manual control:

1. **SSH into the deployment server**:
   ```bash
   ssh ubuntu@b758bcce6.abacusai.cloud
   ```

2. **Navigate to the repository**:
   ```bash
   cd /home/ubuntu/github_repos/living-book
   ```

3. **Pull latest changes**:
   ```bash
   git fetch origin main
   git pull origin main
   ```

4. **Update dependencies** (if package.json changed):
   ```bash
   npm ci --production
   ```

5. **Restart the service**:
   ```bash
   sudo systemctl restart living-book-admin
   ```

6. **Verify deployment**:
   ```bash
   sudo systemctl status living-book-admin
   curl http://localhost:4610/api/status | jq
   ```

### Option 3: Abacus Platform Redeploy

If the deployment is managed through the Abacus AI platform:

1. Log into the Abacus AI platform
2. Navigate to your deployment dashboard
3. Find the `b758bcce6` deployment
4. Click "Redeploy" or "Restart" button
5. Wait for the deployment to complete

## Verifying Deployment

After deployment, verify the new features are live:

```bash
# Check API status (should include Canon fields after PR #7)
curl -s https://b758bcce6.abacusai.cloud/api/status | python3 -c "
import sys, json
s = json.load(sys.stdin)
print('✓ API is healthy:', s.get('ok'))
print('✓ Canon fields present:', 'claimNodes' in s and 'openDisputes' in s)
if 'claimNodes' in s:
    print(f\"  - Claim nodes: {s.get('claimNodes', 0)}\")
    print(f\"  - Open disputes: {s.get('openDisputes', 0)}\")
    print(f\"  - Latest report: {s.get('latestReport', 'N/A')}\")
"
```

Or visit the Back Office in your browser:
1. Go to https://b758bcce6.abacusai.cloud
2. Check for the new "Canon & Disputes" tab
3. Click "Run Canon review (6.5)" button
4. Verify the new features work

## Troubleshooting

### Service won't start

Check the service logs:
```bash
sudo journalctl -u living-book-admin -n 50
```

Common issues:
- **Port already in use**: Check if another process is using port 4610
- **Syntax errors**: Verify code with `node --check scripts/server.js`
- **Missing dependencies**: Run `npm ci --production`

### Service starts but API fails

Check if the process is listening:
```bash
sudo netstat -tlnp | grep 4610
# or
sudo ss -tlnp | grep 4610
```

Test the local endpoint:
```bash
curl http://localhost:4610/api/status
```

### Code didn't update

Verify the git state:
```bash
cd /home/ubuntu/github_repos/living-book
git status
git log -1 --oneline
```

If the branch is detached or dirty:
```bash
git checkout main
git reset --hard origin/main
git pull origin main
```

## Deployment Checklist

After deploying a new feature (like PR #7):

- [ ] Code merged to `main` on GitHub
- [ ] SSH access to deployment server verified
- [ ] Deployment script executed successfully
- [ ] Service restarted and shows `active` status
- [ ] API health check passes (`/api/status` returns `"ok": true`)
- [ ] New features visible in the API response
- [ ] New features work in the web UI
- [ ] No errors in service logs

## Rollback Procedure

If a deployment breaks the service:

1. **SSH into the server**:
   ```bash
   ssh ubuntu@b758bcce6.abacusai.cloud
   cd /home/ubuntu/github_repos/living-book
   ```

2. **Find the last working commit**:
   ```bash
   git log --oneline -10
   ```

3. **Revert to that commit**:
   ```bash
   git checkout <commit-sha>
   ```

4. **Restart the service**:
   ```bash
   sudo systemctl restart living-book-admin
   sudo systemctl status living-book-admin
   ```

5. **Verify**:
   ```bash
   curl http://localhost:4610/api/status
   ```

6. **Fix forward** (recommended) or stay on the old commit temporarily

## Automated Deployments

The `scripts/post-batch-push.sh` script automatically restarts the service after batch refreshes. To enable automatic deployments after every push to `main`, consider setting up:

- **GitHub Actions workflow** with a deployment step
- **Webhook** to trigger redeploy on push events
- **Git hooks** on the server to pull and restart on remote changes

## Support

For deployment issues:
1. Check service logs: `sudo journalctl -u living-book-admin -n 100`
2. Check nginx logs: `sudo journalctl -u nginx -n 50`
3. Review this guide's Troubleshooting section
4. Contact platform support if the deployment infrastructure is unavailable
