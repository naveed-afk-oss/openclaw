import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface IdempotencyCheck {
  /** Whether the issue should be processed */
  proceed: boolean;
  /** One of: 'already_merged' | 'branch_exists' | 'claimed' | undefined */
  reason?: "already_merged" | "branch_exists" | "claimed";
}

/**
 * Check if an issue has already been resolved by a merged PR.
 * Uses `GET /repos/{owner}/{repo}/pulls?head={owner}:afk/issue-{N}&state=all`
 * to detect whether an AFK PR has been merged.
 *
 * @returns true if a merged PR exists for this issue, false otherwise
 */
export async function isIssueResolved(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  try {
    const token = process.env.GH_TOKEN ?? "";
    const branch = `afk/issue-${issueNumber}`;
    // Use GitHub CLI for authenticated API request
    const { stdout } = await execAsync(
      `gh api "repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=all" --jq '.[] | select(.merged == true) | .number'`,
      { env: { ...process.env, GH_TOKEN: token } },
    );
    // If stdout contains the issue number, a merged PR exists
    const merged = stdout.trim().split("\n").filter(Boolean);
    return merged.length > 0;
  } catch {
    // GH CLI exits non-zero whenjq returns no results — that's fine
    return false;
  }
}

/**
 * Check whether an active AFK branch already exists for this issue on the remote.
 * This is used as a pre-spawn guard to avoid duplicate work when the same issue
 * is picked up by multiple orchestrator cycles.
 *
 * @returns true if the `afk/issue-{N}` branch exists on the remote
 */
export async function hasActiveBranch(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  const branch = `afk/issue-${issueNumber}`;
  try {
    const token = process.env.GH_TOKEN ?? "";
    const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const ref = `refs/heads/${branch}`;
    await execAsync(`git ls-remote ${remoteUrl} ${ref} 2>&1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compose a full idempotency check before spawning an agent for an issue.
 *
 * Checks (in order):
 * 1. Has a PR already been merged for this issue? → skip ('already_merged')
 * 2. Does an active branch already exist on the remote? → skip ('branch_exists')
 * 3. Is the issue already claimed in the claims store? → skip ('claimed')
 * 4. Otherwise → proceed
 *
 * @returns IdempotencyCheck with proceed=true only when no guards block processing
 */
export async function shouldProcessIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IdempotencyCheck> {
  // 1. Already merged?
  const resolved = await isIssueResolved(owner, repo, issueNumber);
  if (resolved) {
    return { proceed: false, reason: "already_merged" };
  }

  // 2. Active branch?
  const active = await hasActiveBranch(owner, repo, issueNumber);
  if (active) {
    return { proceed: false, reason: "branch_exists" };
  }

  // 3. Claimed in store? (import lazily to avoid circular deps at module level)
  const { isClaimed } = await import("./afk-claims-store.js");
  const claimed = await isClaimed(owner, repo, issueNumber);
  if (claimed) {
    return { proceed: false, reason: "claimed" };
  }

  return { proceed: true };
}
