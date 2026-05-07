import { describe, it, expect, vi, beforeEach } from "vitest";
import { runOrchestratorCycle, OrchestratorConfig } from "./afk-orchestrator.js";
import type { AfkSlackNotifier } from "./afk-slack-notifier.js";

// Mock all external dependencies
vi.mock("./afk-poller.js", () => ({
  pollAfkIssues: vi.fn(),
  getIssueComments: vi.fn(),
}));

vi.mock("./afk-claims-store.js", () => ({
  claimIssue: vi.fn(),
  isClaimed: vi.fn(),
}));

vi.mock("./afk-branch-manager.js", () => ({
  branchExists: vi.fn(),
  createBranch: vi.fn(),
  createWorktree: vi.fn(),
}));

vi.mock("./afk-orchestrator/afk-semaphore.js", () => ({
  createSemaphore: vi.fn(() => ({ maxSlots: 2 })),
  acquire: vi.fn(() => Promise.resolve(true)),
  release: vi.fn(),
}));

vi.mock("./afk-slack-notifier.js", () => ({
  AfkSlackNotifier: vi.fn(() => ({
    createThread: vi.fn(() =>
      Promise.resolve({
        issueKey: "owner/repo#42",
        threadTs: "1234567890.123456",
        channelId: "C0B30NE82KA",
        postMilestone: vi.fn(),
      }),
    ),
    postMilestone: vi.fn(),
  })),
}));

vi.mock("./afk-agent-spawner.js", () => ({
  runAgentForIssue: vi.fn(() => Promise.resolve({ success: true, runId: "run-123" })),
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn((cmd: string, cb: Function) => {
    cb(null, "/home/malik/openclaw", "");
  }),
}));

import { runAgentForIssue } from "./afk-agent-spawner.js";
import { branchExists, createBranch, createWorktree } from "./afk-branch-manager.js";
import { claimIssue, isClaimed } from "./afk-claims-store.js";
import { createSemaphore } from "./afk-orchestrator/afk-semaphore.js";
import { pollAfkIssues, getIssueComments } from "./afk-poller.js";
import { AfkSlackNotifier } from "./afk-slack-notifier.js";

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    owner: "naveed-afk-oss",
    repo: "openclaw",
    channelId: "C0B30NE82KA",
    maxConcurrent: 2,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<{ number: number; title: string; body: string }> = {}) {
  return {
    number: 42,
    title: "Fix bug",
    body: "There is a bug",
    labels: ["afk"],
    html_url: "https://github.com/naveed-afk-oss/openclaw/issues/42",
    ...overrides,
  };
}

describe("runOrchestratorCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("polls for AFK-labeled issues", async () => {
    vi.mocked(pollAfkIssues).mockResolvedValue([]);

    await runOrchestratorCycle(makeConfig());

    expect(pollAfkIssues).toHaveBeenCalledWith("naveed-afk-oss", "openclaw");
  });

  it("skips already-claimed issues", async () => {
    vi.mocked(pollAfkIssues).mockResolvedValue([makeIssue()]);
    vi.mocked(claimIssue).mockResolvedValue(false); // already claimed

    await runOrchestratorCycle(makeConfig());

    expect(claimIssue).toHaveBeenCalledWith("naveed-afk-oss", "openclaw", 42);
    expect(createBranch).not.toHaveBeenCalled();
  });

  it("skips issues where branch already exists (idempotent resume)", async () => {
    vi.mocked(pollAfkIssues).mockResolvedValue([makeIssue()]);
    vi.mocked(claimIssue).mockResolvedValue(true);
    vi.mocked(branchExists).mockResolvedValue(true); // branch already exists

    await runOrchestratorCycle(makeConfig());

    expect(createBranch).not.toHaveBeenCalled();
    expect(runAgentForIssue).not.toHaveBeenCalled();
    // Claim is kept so the other runner can finish
  });

  it("creates branch and worktree for unclaimed issues", async () => {
    const issue = makeIssue({ number: 42, title: "Fix bug", body: "Details" });
    vi.mocked(pollAfkIssues).mockResolvedValue([issue]);
    vi.mocked(claimIssue).mockResolvedValue(true);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(createBranch).mockResolvedValue("afk/issue-42");
    vi.mocked(createWorktree).mockResolvedValue("/home/malik/openclaw/.git/worktrees/afk-issue-42");
    vi.mocked(getIssueComments).mockResolvedValue("");

    await runOrchestratorCycle(makeConfig());

    expect(createBranch).toHaveBeenCalledWith(
      "naveed-afk-oss",
      "openclaw",
      42,
      "main",
      expect.any(String),
    );
    expect(createWorktree).toHaveBeenCalled();
  });

  it("creates Slack thread and runs agent for each processed issue", async () => {
    const issue = makeIssue({ number: 42 });
    vi.mocked(pollAfkIssues).mockResolvedValue([issue]);
    vi.mocked(claimIssue).mockResolvedValue(true);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(createBranch).mockResolvedValue("afk/issue-42");
    vi.mocked(createWorktree).mockResolvedValue("/tmp/worktrees/afk-issue-42");
    vi.mocked(getIssueComments).mockResolvedValue("A comment");
    const notifierSpy = vi.mocked(AfkSlackNotifier as unknown as ReturnType<typeof vi.fn>);
    const mockNotifierInstance = notifierSpy.mock.results[0]?.value;

    await runOrchestratorCycle(makeConfig());

    expect(runAgentForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 42,
        issueTitle: "Fix bug",
        issueBody: "Details",
        comments: "A comment",
      }),
    );
  });

  it("handles errors per-issue without failing the whole cycle", async () => {
    const issue1 = makeIssue({ number: 1 });
    const issue2 = makeIssue({ number: 2 });
    vi.mocked(pollAfkIssues).mockResolvedValue([issue1, issue2]);
    vi.mocked(claimIssue).mockResolvedValue(true);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(createBranch).mockRejectedValueOnce(new Error("git fail"));
    vi.mocked(createWorktree).mockResolvedValue("/tmp/worktrees/afk-issue-1");

    // Should not throw
    await runOrchestratorCycle(makeConfig());
  });

  it("creates semaphore with configured maxConcurrent", async () => {
    vi.mocked(pollAfkIssues).mockResolvedValue([]);

    await runOrchestratorCycle(makeConfig({ maxConcurrent: 5 }));

    expect(createSemaphore).toHaveBeenCalledWith(5);
  });
});
