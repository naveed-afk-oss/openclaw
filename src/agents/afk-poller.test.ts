import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process at the module level
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

import { exec as execFn } from "node:child_process";

describe("afk-poller", () => {
  let poller: typeof import("./afk-poller.js");
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    execMock = vi.mocked(execFn);
    poller = await import("./afk-poller.js");
  });

  afterEach(() => {
    vi.resetModules();
  });

  const resolveExec =
    (stdout: string) =>
    (_cmd: string, cb: (error: null, stdout: string, stderr: string) => void) => {
      cb(null, stdout, "");
    };

  describe("pollAfkIssues", () => {
    it("calls GitHub API with correct URL and headers", async () => {
      execMock.mockImplementationOnce(resolveExec("[]"));

      await poller.pollAfkIssues("my-owner", "my-repo");

      const callArgs = execMock.mock.calls[0]?.[0] as string;
      expect(callArgs).toContain("https://api.github.com/repos/my-owner/my-repo/issues");
      expect(callArgs).toContain("labels=afk");
      expect(callArgs).toContain("state=open");
      expect(callArgs).toContain("per_page=20");
      expect(callArgs).toContain("-H");
      expect(callArgs).toContain("Authorization: Bearer");
    });

    it("uses custom labels when provided", async () => {
      execMock.mockImplementationOnce(resolveExec("[]"));

      await poller.pollAfkIssues("owner", "repo", "needs-triage,afk");

      const callArgs = execMock.mock.calls[0]?.[0] as string;
      expect(callArgs).toContain("labels=needs-triage%2Cafk");
    });

    it("filters out pull requests from the result", async () => {
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
          title: "Some PR",
          body: null,
          labels: [{ name: "afk" }],
          html_url: "https://github.com/owner/repo/issues/11",
          pull_request: { url: "https://github.com/owner/repo/pull/11" },
        },
      ];
      execMock.mockImplementationOnce(resolveExec(JSON.stringify(mockedIssues)));

      const result = await poller.pollAfkIssues("owner", "repo");

      expect(result.map((i) => i.number)).not.toContain(11);
      expect(result.map((i) => i.number)).toContain(10);
    });

    it("returns AfkIssue shape with labels as string array", async () => {
      const issue = [
        {
          number: 10,
          title: "AFK: database is down",
          body: "Can't access the DB",
          labels: [{ name: "afk" }, { name: "priority" }],
          html_url: "https://github.com/owner/repo/issues/10",
          pull_request: undefined,
        },
      ];
      execMock.mockImplementationOnce(resolveExec(JSON.stringify(issue)));

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
      execMock.mockImplementationOnce(resolveExec("[]"));

      const result = await poller.pollAfkIssues("owner", "repo");

      expect(result).toEqual([]);
    });

    it("handles null body by converting to empty string", async () => {
      const issueWithNullBody = [
        {
          number: 10,
          title: "Test",
          body: null,
          labels: [{ name: "afk" }],
          html_url: "https://github.com/owner/repo/issues/10",
          pull_request: undefined,
        },
      ];
      execMock.mockImplementationOnce(resolveExec(JSON.stringify(issueWithNullBody)));

      const result = await poller.pollAfkIssues("owner", "repo");

      expect(result[0].body).toBe("");
    });
  });

  describe("getIssueComments", () => {
    it("calls correct comments endpoint", async () => {
      execMock.mockImplementationOnce(resolveExec("[]"));

      await poller.getIssueComments("owner", "repo", 42);

      const callArgs = execMock.mock.calls[0]?.[0] as string;
      expect(callArgs).toContain("https://api.github.com/repos/owner/repo/issues/42/comments");
    });

    it("concatenates comment bodies with newlines", async () => {
      const comments = [{ body: "First comment" }, { body: "Second comment" }];
      execMock.mockImplementationOnce(resolveExec(JSON.stringify(comments)));

      const result = await poller.getIssueComments("owner", "repo", 42);

      expect(result).toBe("First comment\nSecond comment");
    });

    it("returns empty string for no comments", async () => {
      execMock.mockImplementationOnce(resolveExec("[]"));

      const result = await poller.getIssueComments("owner", "repo", 42);

      expect(result).toBe("");
    });
  });
});
