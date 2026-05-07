import { exec as execSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execSync);

/** Worktree directory path for a given issue number */
export function worktreePath(repoRoot: string, issueNumber: number): string {
  return `${repoRoot}/.git/worktrees/afk-issue-${issueNumber}`;
}

function branchName(issueNumber: number): string {
  return `afk/issue-${issueNumber}`;
}

/**
 * Set the git remote URL to use GH_TOKEN for push/fetch operations.
 * This avoids interactive credential prompts.
 */
async function configureRemoteWithToken(
  repoRoot: string,
  owner: string,
  repo: string,
): Promise<void> {
  const token = process.env.GH_TOKEN ?? "";
  if (!token) return;
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  await exec(`git -C ${repoRoot} remote set-url origin ${remoteUrl}`);
}

/**
 * Check whether a branch exists on the remote.
 */
export async function branchExists(
  owner: string,
  repo: string,
  branch: string,
  repoRoot?: string,
): Promise<boolean> {
  try {
    const token = process.env.GH_TOKEN ?? "";
    const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const ref = `refs/heads/${branch}`;
    const result = await exec(`git ls-remote ${remoteUrl} ${ref} 2>&1`);
    return result.stdout.trim().includes(ref);
  } catch {
    return false;
  }
}

/**
 * Create branch `afk/issue-{N}` from HEAD of the base branch, then push to remote.
 * Returns branch name "afk/issue-{N}".
 */
export async function createBranch(
  owner: string,
  repo: string,
  issueNumber: number,
  baseBranch = "main",
  repoRoot?: string,
): Promise<string> {
  const root = repoRoot ?? (await getRepoRoot());
  const name = branchName(issueNumber);

  await configureRemoteWithToken(root, owner, repo);

  // Ensure we have the base branch
  await exec(`git -C ${root} fetch origin ${baseBranch}`);

  // Create branch off origin/<baseBranch>
  await exec(`git -C ${root} checkout -b ${name} origin/${baseBranch}`);

  // Push to remote
  await exec(`git -C ${root} push -u origin ${name}`);

  return name;
}

/**
 * Create a git worktree at `{repoRoot}/.git/worktrees/afk-issue-{N}` pointing to the given branch.
 * Returns the worktree path.
 */
export async function createWorktree(
  repoRoot: string,
  issueNumber: number,
  branchNameToUse: string,
): Promise<string> {
  const path = worktreePath(repoRoot, issueNumber);

  // Prune any stale worktree entry first
  try {
    await exec(`git -C ${repoRoot} worktree prune`);
  } catch {
    // ignore
  }

  // Create the worktree; ignore "already exists" errors for idempotency
  try {
    await exec(`git -C ${repoRoot} worktree add ${path} ${branchNameToUse}`);
  } catch {
    // worktree already exists — that's fine
  }

  return path;
}

/**
 * Delete the worktree and remote branch after fix is merged.
 */
export async function cleanupBranch(
  owner: string,
  repo: string,
  issueNumber: number,
  repoRoot?: string,
): Promise<void> {
  const root = repoRoot ?? (await getRepoRoot());
  const name = branchName(issueNumber);
  const path = worktreePath(root, issueNumber);

  // Remove the local worktree
  try {
    await exec(`git -C ${root} worktree remove ${path} --force`);
  } catch {
    // ignore if not present
  }

  // Delete the local branch
  try {
    await exec(`git -C ${root} branch -D ${name}`);
  } catch {
    // ignore
  }

  // Delete the remote branch
  try {
    await configureRemoteWithToken(root, owner, repo);
    await exec(`git -C ${root} push --delete origin ${name}`);
  } catch {
    // ignore — branch may already be gone
  }
}

/**
 * Get the SHA of the current HEAD.
 */
export async function getHeadSha(repoRoot?: string): Promise<string> {
  const root = repoRoot ?? (await getRepoRoot());
  const result = await exec(`git -C ${root} rev-parse HEAD`);
  return result.stdout.trim();
}

async function getRepoRoot(): Promise<string> {
  const result = await exec(`git rev-parse --show-toplevel`);
  return result.stdout.trim();
}
