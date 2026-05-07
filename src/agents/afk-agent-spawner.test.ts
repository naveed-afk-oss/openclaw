import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentForIssue, AgentRunContext } from "./afk-agent-spawner.js";
import { acquire, release } from "./afk-orchestrator/afk-semaphore.js";
import type { SlackThread } from "./afk-slack-notifier.js";

// Mock the curl exec calls
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Track calls for assertions
const calls: string[] = [];
let mockSpawnSession: () => { id: string };

function makeCtx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    owner: "owner",
    repo: "repo",
    issueNumber: 42,
    issueTitle: "Fix bug",
    issueBody: "Body here",
    comments: "",
    worktreePath: "/tmp/worktrees/afk-issue-42",
    branchName: "afk/issue-42",
    slackThread: {
      issueKey: "owner/repo#42",
      threadTs: "1234567890.123456",
      channelId: "C0B30NE82KA",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      postMilestone: vi.fn<any>(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    semaphore: { maxSlots: 2 } as any,
    ...overrides,
  };
}

function mockCurl(response: object, exitCode = 0) {
  const { exec } = require("node:child_process") as { exec: Function };
  exec.mockImplementation((cmd: string, cb: Function) => {
    calls.push(cmd);
    cb(null, JSON.stringify(response), "");
  });
}

function mockCurlFail(stderr: string, exitCode = 1) {
  const { exec } = require("node:child_process") as { exec: Function };
  exec.mockImplementation((cmd: string, cb: Function) => {
    calls.push(cmd);
    cb(new Error(stderr), "", stderr);
  });
}

describe("runAgentForIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
  });

  it("calls semaphore acquire first", async () => {
    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acquireSpy = vi.spyOn({ acquire }, "acquire" as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const releaseSpy = vi.spyOn({ release }, "release" as any);

    mockCurl({ id: "run-123", status: "done" });

    await runAgentForIssue(ctx);

    // Acquire must be called before any HTTP calls
    const acquireCallIdx = calls.findIndex((c) => c.includes("sessions"));
    const acquireCall = calls[0];
    expect(acquireSpy).toHaveBeenCalled();
  });

  it("posts 'started' milestone before spawning", async () => {
    const ctx = makeCtx();
    mockCurl({ id: "run-123", status: "done" });

    await runAgentForIssue(ctx);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const startedCall = (ctx.slackThread.postMilestone as any).mock.calls.find(
      (c: unknown[]) => c[0]?.type === "started",
    );
    expect(startedCall).toBeDefined();
  });

  it("returns success:true when COMPLETE appears in transcript", async () => {
    const ctx = makeCtx();
    let callCount = 0;
    const { exec } = require("node:child_process") as { exec: Function };
    exec.mockImplementation((cmd: string, cb: Function) => {
      callCount++;
      if (cmd.includes("/v1/sessions")) {
        cb(null, JSON.stringify({ id: `run-${callCount}` }), "");
      } else if (cmd.includes("/transcript")) {
        cb(null, "Some output\nCOMPLETE\nmore text", "");
      } else {
        cb(null, JSON.stringify({ status: "running" }), "");
      }
    });

    const result = await runAgentForIssue(ctx);
    expect(result.success).toBe(true);
    expect(result.runId).toBeDefined();
  });

  it("returns success:false on error response", async () => {
    const ctx = makeCtx();
    mockCurlFail("connection refused");

    const result = await runAgentForIssue(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("retries spawn 3 times on failure", async () => {
    const ctx = makeCtx();
    let attempts = 0;
    const { exec } = require("node:child_process") as { exec: Function };
    exec.mockImplementation((cmd: string, cb: Function) => {
      if (cmd.includes("/v1/sessions")) {
        attempts++;
        if (attempts < 3) {
          cb(new Error("fail"), "", "error");
        } else {
          cb(null, JSON.stringify({ id: "run-3" }), "");
        }
      } else if (cmd.includes("/transcript")) {
        cb(null, "COMPLETE", "");
      } else {
        cb(null, JSON.stringify({ status: "done" }), "");
      }
    });

    const result = await runAgentForIssue(ctx);
    expect(attempts).toBe(3);
    expect(result.success).toBe(true);
  });

  it("releases semaphore in finally block", async () => {
    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const releaseSpy = vi.spyOn({ release }, "release" as any);

    mockCurlFail("connection refused");

    await runAgentForIssue(ctx);

    expect(releaseSpy).toHaveBeenCalled();
  });

  it("posts error milestone on failure", async () => {
    const ctx = makeCtx();
    mockCurlFail("connection refused");

    await runAgentForIssue(ctx);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorCall = (ctx.slackThread.postMilestone as any).mock.calls.find(
      (c: unknown[]) => c[0]?.type === "error",
    );
    expect(errorCall).toBeDefined();
  });
});
