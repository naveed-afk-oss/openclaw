export interface AfkIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  html_url: string;
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  html_url: string;
  pull_request?: unknown;
}

function ghHeaders(): string[] {
  const token = process.env.GH_TOKEN ?? "";
  return ["-H", `Authorization: Bearer ${token}`, "-H", "Accept: application/vnd.github+json"];
}

function parseIssues(raw: string): AfkIssue[] {
  const items: GhIssue[] = JSON.parse(raw);
  return items
    .filter((item) => !("pull_request" in item))
    .map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      labels: item.labels.map((l) => l.name),
      html_url: item.html_url,
    }));
}

/**
 * Poll open issues labeled with `afk` (or custom `labels` param) for a repository.
 * Uses GH_TOKEN env var with curl. Filters out pull requests.
 */
export async function pollAfkIssues(
  owner: string,
  repo: string,
  labels = "afk",
): Promise<AfkIssue[]> {
  const args = [
    "-s",
    ...ghHeaders(),
    "https://api.github.com/repos/{owner}/{repo}/issues"
      .replace("{owner}", owner)
      .replace("{repo}", repo) + `?labels=${encodeURIComponent(labels)}&state=open&per_page=20`,
  ];
  const { stdout } = await execCurl(args);
  return parseIssues(stdout);
}

interface GhComment {
  body: string;
}

/**
 * Fetch all comments on a given issue. Bodies are concatenated in order.
 */
export async function getIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const args = [
    "-s",
    ...ghHeaders(),
    `https://api.github.com/repos/{owner}/{repo}/issues/${issueNumber}/comments`
      .replace("{owner}", owner)
      .replace("{repo}", repo),
  ];
  const { stdout } = await execCurl(args);
  const comments: GhComment[] = JSON.parse(stdout);
  return comments.map((c) => c.body).join("\n");
}

// Exposed for testing — replace with mock in tests
export async function execCurl(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { exec } = await import("node:child_process");
  return new Promise((resolve) => {
    exec(["curl", ...args].join(" "), (error, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: error ? 1 : 0 });
    });
  });
}
