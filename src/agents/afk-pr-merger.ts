import { exec } from "node:child_process";

export interface PrResult {
  merged: boolean;
  prUrl?: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AfkPrMerger {
  private ghToken: string;

  constructor(ghToken?: string) {
    this.ghToken = ghToken ?? process.env.GH_TOKEN ?? "";
  }

  async execCurl(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      exec(
        [
          "curl",
          "-s",
          "-H",
          `Authorization: Bearer ${this.ghToken}`,
          "-H",
          "Accept: application/vnd.github+json",
          ...args,
        ].join(" "),
        (error, stdout, stderr) => {
          resolve({ stdout, stderr, exitCode: error ? 1 : 0 });
        },
      );
    });
  }

  /**
   * Check if an open PR already exists for the given head branch.
   * Returns { exists: true, prUrl, prNumber } if found, or { exists: false }.
   */
  async prExists(
    owner: string,
    repo: string,
    headBranch: string,
  ): Promise<{ exists: boolean; prUrl?: string; prNumber?: number }> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${headBranch}`;
    const result = await this.execCurl([url]);

    if (result.exitCode !== 0) {
      throw new Error(`curl failed: ${result.stderr}`);
    }

    const prs = JSON.parse(result.stdout) as Array<{
      number: number;
      html_url: string;
      state: string;
    }>;
    const open = prs.filter((pr) => pr.state === "open");

    if (open.length > 0) {
      return { exists: true, prUrl: open[0]!.html_url, prNumber: open[0]!.number };
    }
    return { exists: false };
  }

  /**
   * Create a new PR.
   * Returns { prUrl, prNumber }.
   */
  async createPr(
    owner: string,
    repo: string,
    headBranch: string,
    baseBranch = "main",
    issueNumber?: number,
  ): Promise<{ prUrl: string; prNumber: number }> {
    const title = issueNumber ? `Auto: Fix issue #${issueNumber}` : `Auto: ${headBranch}`;
    const body = issueNumber ? `Fixes #${issueNumber}` : "";

    const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;
    const payload = JSON.stringify({
      title,
      head: headBranch,
      base: baseBranch,
      body,
    });

    const result = await this.execCurl([
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
      url,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`curl failed: ${result.stderr}`);
    }

    const parsed = JSON.parse(result.stdout) as {
      number: number;
      html_url: string;
      message?: string;
    };
    if (parsed.message) {
      throw new Error(`GitHub API error: ${parsed.message}`);
    }

    return { prUrl: parsed.html_url, prNumber: parsed.number };
  }

  /**
   * Check if a PR is in a mergeable state (not blocked, no conflicts).
   */
  async isMergeable(owner: string, repo: string, prNumber: number): Promise<boolean> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const result = await this.execCurl([url]);

    if (result.exitCode !== 0) {
      throw new Error(`curl failed: ${result.stderr}`);
    }

    const pr = JSON.parse(result.stdout) as {
      mergeable: boolean | null;
      mergeable_state?: string;
      merged: boolean;
      state: string;
    };

    // merged = true means already merged
    // mergeable === false means conflicts or blocked
    // mergeable_state of "blocked" means cannot merge yet
    if (pr.merged || pr.state === "closed") {
      return false;
    }

    return pr.mergeable === true && pr.mergeable_state !== "blocked";
  }

  /**
   * Merge a PR via PUT /repos/{owner}/{repo}/pulls/{pr_number}/merge
   */
  async mergePr(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{ merged: boolean; error?: string }> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`;
    const payload = JSON.stringify({ merge_method: "squash" });

    const result = await this.execCurl([
      "-X",
      "PUT",
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
      url,
    ]);

    if (result.exitCode !== 0) {
      return { merged: false, error: result.stderr };
    }

    const parsed = JSON.parse(result.stdout) as {
      merged: boolean;
      message?: string;
      error?: string;
    };

    if (parsed.message || parsed.error) {
      return { merged: false, error: parsed.message ?? parsed.error };
    }

    return { merged: parsed.merged };
  }

  /**
   * Full pipeline:
   * 1. Check if PR already exists — if so and mergeable, merge it directly.
   * 2. Create PR if it doesn't exist.
   * 3. Poll isMergeable every 5s for up to 60s.
   * 4. Merge the PR.
   * 5. On 409 conflict: retry after 5s.
   * 6. On 429 rate limit: retry with exponential backoff (honors Retry-After).
   */
  async runMergePipeline(
    owner: string,
    repo: string,
    branchName: string,
    baseBranch = "main",
    issueNumber?: number,
  ): Promise<PrResult> {
    // Step 1: check if PR already exists
    const existing = await this.prExists(owner, repo, branchName);
    if (existing.exists && existing.prNumber !== undefined) {
      // Check if already mergeable — if so, merge directly
      const canMerge = await this.isMergeable(owner, repo, existing.prNumber);
      if (canMerge) {
        const result = await this.mergePr(owner, repo, existing.prNumber);
        return {
          merged: result.merged,
          prUrl: existing.prUrl,
          error: result.error,
        };
      }
    }

    // Step 2: create PR if it doesn't exist
    let prNumber: number;
    let prUrl: string;
    if (existing.exists) {
      prNumber = existing.prNumber!;
      prUrl = existing.prUrl!;
    } else {
      const created = await this.createPr(owner, repo, branchName, baseBranch, issueNumber);
      prNumber = created.prNumber;
      prUrl = created.prUrl;
    }

    // Step 3: poll isMergeable every 5s for up to 60s
    const maxAttempts = 12; // 12 * 5s = 60s
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await sleep(5000);

      const canMerge = await this.isMergeable(owner, repo, prNumber);
      if (canMerge) {
        break;
      }

      if (attempt === maxAttempts) {
        return { merged: false, prUrl, error: "PR not mergeable after 60s timeout" };
      }
    }

    // Step 4: merge the PR with retry on 409
    let merged = false;
    let error: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await this.mergePr(owner, repo, prNumber);
      if (result.merged) {
        merged = true;
        break;
      }

      error = result.error;

      // Check if it's a 409 conflict → retry after 5s
      if (error && (error.includes("409") || error.toLowerCase().includes("conflict"))) {
        await sleep(5000);
        continue;
      }

      // Check for 429 rate limit → exponential backoff
      if (error && (error.includes("429") || error.toLowerCase().includes("rate limit"))) {
        // Try to extract Retry-After header value
        const retryMatch = error.match(/retry-after[:\s]+(\d+)/i);
        const waitMs = retryMatch
          ? parseInt(retryMatch[1]!, 10) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 30000);
        await sleep(waitMs);
        continue;
      }

      // Non-retryable error
      break;
    }

    return { merged, prUrl, error };
  }
}
