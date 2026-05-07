# AFK-8 End-to-End Test Guide

This guide walks you through triggering and verifying a real AFK orchestrator run end-to-end.

---

## Prerequisites

You need these env vars set (add to your shell profile or export directly):

```bash
export GH_TOKEN="ghp_..."           # GitHub Personal Access Token
export SLACK_BOT_TOKEN="xoxb-..."   # Slack Bot Token
export OPENCLAW_TOKEN="..."         # OpenClaw gateway token
```

---

## Step 1 — Build the Dist

Before running, compile the TypeScript:

```bash
cd ~/openclaw
pnpm install
pnpm run build 2>&1 | tail -5
```

The compiled output will be in `dist/agents/afk-orchestrator.js`.

---

## Step 2 — Pick an Issue

Go to https://github.com/naveed-afk-oss/openclaw/issues
Pick any open issue (or create a new one). Copy the **issue number**.

---

## Step 3 — Label the Issue `afk`

```bash
gh issue edit {issue-number} --add-label afk --repo naveed-afk-oss/openclaw
```

Or via GitHub UI: Issues → open issue → Labels → click `afk`.

---

## Step 4 — Trigger a Poll Cycle

The orchestrator is designed to run as a cron job. To manually trigger one cycle now:

```bash
cd ~/openclaw
node -e "
const { runOrchestratorCycle } = require('./dist/agents/afk-orchestrator.js');
runOrchestratorCycle({
  owner: 'naveed-afk-oss',
  repo: 'openclaw',
  channelId: 'C0B30NE82KA',
  maxConcurrent: 2
}).catch(console.error);
"
```

This runs synchronously — one full poll cycle, then exits.

---

## Step 5 — Watch Slack

Within the poll cycle, you should see a new thread in #grill-master with:

```
🤖 Agent started on issue #{N}: {title}
```

Then progress milestones:

```
📝 tests written — issue #{N}
📝 PR opened — issue #{N}
```

Then completion:

```
✅ Issue #{N} resolved — PR: https://github.com/naveed-afk-oss/openclaw/pull/123
```

Or on error:

```
❌ Issue #{N} failed: {error description}
```

---

## Step 6 — Verify Each Pipeline Step

Run these checks after the run completes:

### Branch created on remote?

```bash
git ls-remote --refs https://github.com/naveed-afk-oss/openclaw | grep afk/issue-{N}
# Should show:  refs/heads/afk/issue-{N}  {sha}
```

### Worktree created?

```bash
ls ~/openclaw/.git/worktrees/afk-issue-{N}/
# Should list files from the repo
```

### PR opened?

```bash
gh pr list --repo naveed-afk-oss/openclaw --head afk/issue-{N}
# Should show one open PR
```

### PR merged?

```bash
gh pr view {pr-number} --repo naveed-afk-oss/openclaw --json state
# Should show: "merged"
```

### Branch cleaned up (post-merge)?

```bash
git ls-remote --refs https://github.com/naveed-afk-oss/openclaw | grep afk/issue-{N}
# → should return empty
```

### Worktree removed?

```bash
ls ~/openclaw/.git/worktrees/afk-issue-{N}/ 2>/dev/null || echo "cleaned"
```

---

## Testing Concurrency (optional)

Label 3 issues with `afk` at the same time:

```bash
gh issue edit {N1} --add-label afk --repo naveed-afk-oss/openclaw
gh issue edit {N2} --add-label afk --repo naveed-afk-oss/openclaw
gh issue edit {N3} --add-label afk --repo naveed-afk-oss/openclaw
```

Then run the orchestrator. You should see:

- 2 agents start immediately (slots full)
- 3rd agent waits in queue
- As agents finish, queued agents pick up

Slack threads for each will appear in parallel.

---

## Troubleshooting

### Agent never starts

- Check claims file hasn't expired: `cat /data/.clawdbot/afk-claims.json`
- Check GH_TOKEN is valid: `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user`

### Agent starts but no Slack message

- Check SLACK_BOT_TOKEN is valid
- Check channel ID is correct

### PR not merged

- Check CI status — auto-merge waits for clean CI
- Check PR is mergeable: `gh pr view {N} --json mergeable`

### Branch not cleaned up

- Check merge completed successfully
- Manual cleanup: `git push --delete origin afk/issue-{N} && git worktree remove .git/worktrees/afk-issue-{N}`
