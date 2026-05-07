import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockedIssues = [
  {
    number: 10,
    title: "AFK: database is down",
    body: "Can't access the DB",
    labels: [{ name: "afk" }, { name: "priority" }],
    html_url: "https://github.com/owner/repo/issues/10",
    pull_request: undefined,
  },
  {
    number: 11,
    title: "Some regular issue",
    body: null,
    labels: [{ name: "afk" }],
    html_url: "https://github.com/owner/repo/issues/11",
    pull_request: { url: "https://github.com/owner/repo/pull/11" }, // should be filtered
  },
  {
    number: 12,
    title: "AFK: auth broken",
    body: "Login fails",
    labels: [{ name: "other-label" }], // no afk, but filtered by query
    html_url: "https://github.com/owner/repo/issues/12",
    pull_request: undefined,
  },
];

vi.mock("./afk-poller.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./afk-poller.js")>();
  return {
    ...original,
    execCurl: vi.fn(),
  };
});

describe("afk-poller", () => {
  let poller: typeof import("./afk-poller.js");
  let execCurl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./afk-poller.js");
    poller = mod;
    execCurl = mod.execCurl as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("pollAfkIssues", () => {
    it("calls GitHub API with correct URL and headers", async () => {
      execCurl.mockResolvedValueOnce({ stdout: "[]", stderr: "", exitCode: 0 });

      await poller.pollAfkIssues("my-owner", "my-repo");

      const call = execCurl.mock.calls[0]?.[0] as string[];
      expect(call).toContain("https://api.github.com/repos/my-owner/my-repo/issues");
      expect(call).toContain("labels=afk");
      expect(call).toContain("state=open");
      expect(call).toContain("per_page=20");
      expect(call).toContain("-H");
      expect(call).toContain("Authorization: Bearer");
    });

    it("uses custom labels when provided", async () => {
      execCurl.mockResolvedValueOnce({ stdout: "[]", stderr: "", exitCode: 0 });

      await poller.pollAfkIssues("owner", "repo", "needs-triage,afk");

      const call = execCurl.mock.calls[0]?.[0] as string[];
      expect(call.join(" ")).toContain("labels=needs-triage%2Cafk");
    });

    it("filters out pull requests from the result", async () => {
      execCurl.mockResolvedValueOnce({
        stdout: JSON.stringify(mockedIssues),
        stderr: "",
        exitCode: 0,
      });

      const result = await poller.pollAfkIssues("owner", "repo");

      // Issue #11 is a PR — should not appear
      expect(result.map((i) => i.number)).not.toContain(11);
      expect(result.map((i) => i.number)).toContain(10);
    });

    it("returns AfkIssue shape with labels as string array", async () => {
      execCurl.mockResolvedValueOnce({
        stdout: JSON.stringify([mockedIssues[0]]),
        stderr: "",
        exitCode: 0,
      });

      const result = await poller.pollAfkIssues("owner", "repo");

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        number: 10,
        title: "AFK: database is down",
        body: "Can't access the DB",
        labels: ["afk", "priority"],
        html_url: "https://github.com/owner/repo/issues/10",
      });
    });

    it("returns empty array when no issues", async () => {
      execCurl.mockResolvedValueOnce({ stdout: "[]", stderr: "", exitCode: 0 });

      const result = await poller.pollAfkIssues("owner", "repo");

      expect(result).toEqual([]);
    });

    it("handles null body by converting to empty string", async () => {
      const issueWithNullBody = [{ ...mockedIssues[0], body: null }];
      execCurl.mockResolvedValueOnce({
        stdout: JSON.stringify(issueWithNullBody),
        stderr: "",
        exitCode: 0,
      });

      const result = await poller.pollAfkIssues("owner", "repo");

      expect(result[0].body).toBe("");
    });
  });

  describe("getIssueComments", () => {
    it("calls correct comments endpoint", async () => {
      execCurl.mockResolvedValueOnce({ stdout: "[]", stderr: "", exitCode: 0 });

      await poller.getIssueComments("owner", "repo", 42);

      const call = execCurl.mock.calls[0]?.[0] as string[];
      expect(call).toContain("https://api.github.com/repos/owner/repo/issues/42/comments");
    });

    it("concatenates comment bodies with newlines", async () => {
      const comments = [{ body: "First comment" }, { body: "Second comment" }];
      execCurl.mockResolvedValueOnce({ stdout: JSON.stringify(comments), stderr: "", exitCode: 0 });

      const result = await poller.getIssueComments("owner", "repo", 42);

      expect(result).toBe("First comment\nSecond comment");
    });

    it("returns empty string for no comments", async () => {
      execCurl.mockResolvedValueOnce({ stdout: "[]", stderr: "", exitCode: 0 });

      const result = await poller.getIssueComments("owner", "repo", 42);

      expect(result).toBe("");
    });
  });
});
