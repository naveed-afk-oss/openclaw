## Problem Statement

OpenClaw lacks a Sandcastle-style AFK agent workflow: issue-based task triggering where an agent picks up a labeled issue, creates a branch, performs the work, and merges it back — all without manual intervention. Users who want autonomous, queue-based coding agents currently have no first-class way to achieve this within OpenClaw.

## Solution

Implement an AFK agent orchestrator that watches GitHub issues for a specific label (`afk`), spawns isolated agent runs per issue, manages branch lifecycle, posts Slack progress updates in per-issue threads, handles retries with backoff, and auto-cleans up branches and worktrees on merge.

## User Stories

1. As a developer, I want to label a GitHub issue with `afk` so that an agent automatically starts working on it without me doing anything manually.
2. As a developer, I want the agent to read the full issue thread (body + comments) so it has full context about what has been discussed or tried before.
3. As a developer, I want the agent to create a branch named `afk/issue-N` so the work is isolated and traceable back to the originating issue.
4. As a developer, I want the agent to open a PR against the base branch and auto-merge it once work is complete so I don't have to manually merge.
5. As a developer, I want multiple agents to run in parallel (up to a configurable limit, default 2-3) so throughput scales with available resources.
6. As a developer, I want the agent to run on the host machine (no Docker sandbox) so the setup is lightweight and simple.
7. As a developer, I want the agent to post Slack notifications on start, progress milestones, and completion so I can track what's happening without checking terminals.
8. As a developer, I want Slack thread per issue so all updates for a given issue are grouped together and easy to follow.
9. As a developer, I want progress milestones to be defined by a custom milestone list so I control the signal and avoid noise.
10. As a developer, I want commits and PRs attributed to my GitHub account (`naveed-afk-oss`) so the work is clearly mine.
11. As a developer, I want the agent to retry with exponential backoff on transient errors (rate limits, API errors) so transient failures don't immediately fail the run.
12. As a developer, I want idempotent behavior so that if the same issue is labeled `afk` twice, the agent picks up the existing branch and continues from where it left off.
13. As a developer, I want the agent to use OpenClaw's default/primary model so no per-run configuration is needed.
14. As a developer, I want the agent to emit `COMPLETE` as the exit signal so completion is controllable and explicit.
15. As a developer, I want the agent to auto-delete the branch and worktree after a successful merge so I don't accumulate stale branches.
16. As an operator, I want a claims file to track which issues are actively being processed so duplicate agents don't get spawned for the same issue across cron intervals.
17. As an operator, I want the system to skip issues that already have an active branch or open PR so no double-work occurs.

## Implementation Decisions

### Core Orchestrator Module

A new `afk-orchestrator` module (or integrated into `src/agents/`) that manages:

- **Issue watcher** — polls GitHub Issues API for issues labeled `afk` (or uses webhook-based trigger via GitHub Actions)
- **Branch manager** — creates `afk/issue-N` branches, checks for existing active branches before spawning
- **Agent spawner** — uses OpenClaw's existing `sessions_spawn` to kick off a sub-agent per issue
- **Claims tracker** — writes `{owner/repo}#{issue_number}` with timestamp to a claims file (`/data/.clawdbot/afk-claims.json`); claims older than 2 hours are expired
- **Worktree support** — each agent run operates on its own git worktree (worktree per issue branch) so concurrent agents don't interfere with each other's file system
- **Completion detector** — agent emits `COMPLETE` to signal end of iteration; orchestrator detects this and proceeds to PR
- **Merge pipeline** — after `COMPLETE`, the orchestrator creates a PR (if not exists) and auto-merges
- **Cleanup** — post-merge: delete branch + worktree

### Slack Notifier Module

- Uses the existing `slack` skill / `message` tool
- Creates a Slack thread per issue at start of run (stores thread_ts in claims/run state)
- Posts milestone messages (start, custom milestones, done, error) into the per-issue thread
- Notification events driven by a configurable milestone list (e.g. "tests written", "PR opened", "type errors fixed")

### GitHub Integration Layer

- Uses GitHub REST API via `curl` (not `gh` CLI) for portability
- Monitors labels via `GET /repos/{owner}/{repo}/issues?labels=afk&state=open`
- Creates branches via `POST /repos/{owner}/{repo}/git/refs`
- Opens/merges PRs via `/repos/{owner}/{repo}/pulls` and `/repos/{owner}/{repo}/pulls/{pr_number}/merge`
- Attributed to `naveed-afk-oss` via the GH_TOKEN

### Concurrency Manager

- In-memory semaphore (or file-based lock) enforcing max 2-3 concurrent agent runs
- Queues additional issues; processes as slots free up
- Each slot = one worktree + one sub-agent session

### Idempotency Guard

- Before spawning: check if `afk/issue-{N}` branch exists on the repo (API call)
- If exists: check if PR already open → skip if PR exists; otherwise re-use branch (idempotent resume)
- Claims file used to handle the window between issue discovery and sub-agent spawn

### Retry / Backoff Policy

- On API errors (429, 5xx): retry with exponential backoff (up to N attempts, configurable)
- On agent run error: retry sub-agent spawn up to M times before failing and notifying Slack

### Sandbox / Execution Model

- No Docker: agent runs directly on host using OpenClaw's native `exec` tool within the sub-agent session
- Worktree-based isolation: each issue gets its own worktree at `{repo}/.git/worktrees/afk-issue-{N}`
- No sandbox provider needed; host = the machine running the orchestrator

### Module Boundaries

| Module | Responsibility |
|---|---|
| `afk-orchestrator` | Main loop: poll → queue → dispatch → monitor → merge → cleanup |
| `afk-branch-manager` | Git branch/worktree creation, existence checks, cleanup |
| `afk-github-client` | All GitHub API calls (issues, branches, PRs, merges) |
| `afk-slack-notifier` | Slack thread creation, milestone postings |
| `afk-claims-store` | Claims file read/write/expire |
| `afk-semaphore` |Concurrency slot management |

## Testing Decisions

- **Unit tests** on each module: claims expiry logic, branch naming, milestone filtering, semaphore acquire/release
- **Integration tests** against a real GitHub repo: label an issue, verify branch created, PR opened, merged
- **Slack integration test**: verify correct thread created and milestone messages posted
- **Idempotency test**: label same issue twice, verify only one agent run spawned
- **Concurrency test**: label N+1 issues with max 2 concurrent slots, verify N run and 1 queued
- **Retry test**: mock API 429 then success, verify backoff and eventual success
- Prior art: existing `subagent-registry*.test.ts` tests in the codebase for sub-agent lifecycle patterns

## Out of Scope

- Docker/Podman sandbox provisioning (host-only execution for v1)
- Webhook-based real-time triggers (polling is sufficient for v1)
- Custom per-label model selection (always uses OpenClaw default model)
- Agent tool allowlist customization per issue type
- Multiple GitHub organizations/repos managed from a single instance
- GitHub Actions workflow packaging (manual cron setup for v1)

## Further Notes

The existing `sessions_spawn`, `subagent-registry`, and `exec` tools provide the building blocks for spawning and managing sub-agent runs. The primary new work is the orchestration layer (polling, claims, branch management, Slack threading, merge pipeline) — not new execution primitives.
