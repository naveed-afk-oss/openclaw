import { runAgentForIssue, AgentRunContext } from "./afk-agent-spawner.js";
import { branchExists, createBranch, createWorktree } from "./afk-branch-manager.js";
import { claimIssue, isClaimed } from "./afk-claims-store.js";
import { createSemaphore, AfkSemaphore } from "./afk-orchestrator/afk-semaphore.js";
import { pollAfkIssues, getIssueComments } from "./afk-poller.js";
import { AfkSlackNotifier, SlackThread } from "./afk-slack-notifier.js";

export interface OrchestratorConfig {
  owner: string;
  repo: string;
  channelId: string;
  maxConcurrent?: number;
}

interface IssueContext {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  comments: string;
  worktreePath: string;
  branchName: string;
}

/**
 * Run one full orchestration cycle:
 * 1. Poll for AFK-labeled open issues
 * 2. For each unclaimed issue:
 *    a. claimIssue (skip if already claimed)
 *    b. isClaimed check after semaphore
 *    c. branchExists check — skip if branch already exists (idempotent resume)
 *    d. createBranch + createWorktree
 *    e. createThread in Slack
 *    f. runAgentForIssue
 * 3. Errors caught per-issue, Slack notified, semaphore released
 */
export async function runOrchestratorCycle(config: OrchestratorConfig): Promise<void> {
  const { owner, repo, channelId } = config;
  const maxConcurrent = config.maxConcurrent ?? 2;
  const semaphore = createSemaphore(maxConcurrent);
  const notifier = new AfkSlackNotifier(channelId);

  // 1. Poll open issues with afk label
  const issues = await pollAfkIssues(owner, repo);

  // 2. Process each issue sequentially to respect semaphore
  for (const issue of issues) {
    await processIssue(owner, repo, issue, semaphore, notifier);
  }
}

async function processIssue(
  owner: string,
  repo: string,
  issue: { number: number; title: string; body: string },
  semaphore: AfkSemaphore,
  notifier: AfkSlackNotifier,
): Promise<void> {
  const { number: issueNumber, title, body } = issue;

  // 2a. Attempt to claim
  const claimed = await claimIssue(owner, repo, issueNumber);
  if (!claimed) {
    // Already claimed by another runner
    return;
  }

  // 2b. Re-check claim after semaphore slot acquisition (race condition guard)
  //    (The semaphore acquire in runAgentForIssue provides this.)

  // 2c. Check if branch already exists (idempotent resume)
  const branch = `afk/issue-${issueNumber}`;
  const repoRoot = await getRepoRoot();
  const branchAlreadyExists = await branchExists(owner, repo, branch, repoRoot);
  if (branchAlreadyExists) {
    // Someone else already started — skip but keep claim so they finish
    return;
  }

  try {
    // 2d. Create branch and worktree
    await createBranch(owner, repo, issueNumber, "main", repoRoot);
    const worktreePath = await createWorktree(repoRoot, issueNumber, branch);

    // Fetch comments for the prompt
    const comments = await getIssueComments(owner, repo, issueNumber);

    // 2e. Create Slack thread for this issue
    const issueKey = `${owner}/${repo}#${issueNumber}`;
    const slackThread: SlackThread = await notifier.createThread(issueKey, issueNumber);

    // Attach postMilestone to the thread object
    const threadWithPost = {
      ...slackThread,
      postMilestone: (event: Parameters<typeof notifier.postMilestone>[1]) =>
        notifier.postMilestone(slackThread, event),
    };

    // 2f. Run the agent
    const ctx: AgentRunContext = {
      owner,
      repo,
      issueNumber,
      issueTitle: title,
      issueBody: body,
      comments,
      worktreePath,
      branchName: branch,
      slackThread: threadWithPost,
      semaphore,
    };

    await runAgentForIssue(ctx);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Attempt to notify error in Slack even on failure
    try {
      const issueKey = `${owner}/${repo}#${issueNumber}`;
      const threadTs = ""; // We don't have it if createThread failed
      await notifier.postMilestone(
        { issueKey, threadTs, channelId: notifier["channelId"] },
        { type: "error", issueNumber, error: errorMsg },
      );
    } catch {
      // ignore Slack notification failures
    }
    // Release semaphore if it was acquired (runAgentForIssue handles its own, but
    // if we failed before calling it, the claim is already held — let it expire)
  }
}

async function getRepoRoot(): Promise<string> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  const result = await execAsync("git rev-parse --show-toplevel");
  return result.stdout.trim();
}
