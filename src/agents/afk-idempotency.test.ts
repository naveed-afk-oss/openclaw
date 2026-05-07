import { exec as execMock } from "node:child_process";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock node:child_process at module level
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Mock afk-claims-store at module level
vi.mock("./afk-claims-store.js", () => ({
  isClaimed: vi.fn().mockResolvedValue(false),
}));

function mockExec(
  impl: (cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) => void,
) {
  vi.mocked(execMock).mockImplementation(
    impl as unknown as (cmd: string) => Promise<{ stdout: string; stderr: string }>,
  );
}

function clearMock() {
  vi.mocked(execMock).mockReset();
}

// ─────────────────────────────────────────────────────────────────────────────
// isIssueResolved
// ─────────────────────────────────────────────────────────────────────────────
describe("isIssueResolved", () => {
  let idempotency: typeof import("./afk-idempotency.js");

  beforeEach(async () => {
    vi.resetModules();
    clearMock();
    const { isClaimed } = await import("./afk-claims-store.js");
    vi.mocked(isClaimed).mockReset().mockResolvedValue(false);
    idempotency = await import("./afk-idempotency.js");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns true when a merged PR is found", async () => {
    mockExec((_cmd, cb) => cb(null, "42\n", ""));

    const result = await idempotency.isIssueResolved("owner", "repo", 42);
    expect(result).toBe(true);
  });

  it("returns false when no merged PR exists (gh exits non-zero)", async () => {
    mockExec((_cmd, cb) => cb(new Error("gh error: no matches"), "", ""));

    const result = await idempotency.isIssueResolved("owner", "repo", 99);
    expect(result).toBe(false);
  });

  it("returns false when stdout is empty", async () => {
    mockExec((_cmd, cb) => cb(null, "", ""));

    const result = await idempotency.isIssueResolved("owner", "repo", 1);
    expect(result).toBe(false);
  });

  it("constructs correct branch name in API query", async () => {
    let capturedCmd = "";
    mockExec((cmd, cb) => {
      capturedCmd = cmd;
      cb(null, "", "");
    });

    await idempotency.isIssueResolved("my-owner", "my-repo", 7);

    expect(capturedCmd).toContain("head=my-owner:afk/issue-7");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hasActiveBranch
// ─────────────────────────────────────────────────────────────────────────────
describe("hasActiveBranch", () => {
  let idempotency: typeof import("./afk-idempotency.js");

  beforeEach(async () => {
    vi.resetModules();
    clearMock();
    const { isClaimed } = await import("./afk-claims-store.js");
    vi.mocked(isClaimed).mockReset().mockResolvedValue(false);
    idempotency = await import("./afk-idempotency.js");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns true when the remote branch exists", async () => {
    mockExec((_cmd, cb) => cb(null, "abc123  refs/heads/afk/issue-42\n", ""));

    const result = await idempotency.hasActiveBranch("owner", "repo", 42);
    expect(result).toBe(true);
  });

  it("returns false when the remote branch does not exist", async () => {
    mockExec((_cmd, cb) => cb(new Error("fatal: couldn't find remote ref"), "", ""));

    const result = await idempotency.hasActiveBranch("owner", "repo", 99);
    expect(result).toBe(false);
  });

  it("returns false when ls-remote returns empty output", async () => {
    mockExec((_cmd, cb) => cb(null, "", ""));

    const result = await idempotency.hasActiveBranch("owner", "repo", 1);
    expect(result).toBe(false);
  });

  it("constructs correct branch name afk/issue-{N}", async () => {
    let capturedCmd = "";
    mockExec((cmd, cb) => {
      capturedCmd = cmd;
      cb(null, "", "");
    });

    await idempotency.hasActiveBranch("my-owner", "my-repo", 5);

    expect(capturedCmd).toContain("refs/heads/afk/issue-5");
    expect(capturedCmd).toContain("my-owner/my-repo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldProcessIssue
// ─────────────────────────────────────────────────────────────────────────────
describe("shouldProcessIssue", () => {
  let idempotency: typeof import("./afk-idempotency.js");

  beforeEach(async () => {
    vi.resetModules();
    clearMock();
    const { isClaimed } = await import("./afk-claims-store.js");
    vi.mocked(isClaimed).mockReset().mockResolvedValue(false);
    idempotency = await import("./afk-idempotency.js");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns proceed=false with reason 'already_merged' when resolved", async () => {
    // isIssueResolved → merged PR found
    mockExec((_cmd, cb) => cb(null, "42\n", ""));

    const result = await idempotency.shouldProcessIssue("owner", "repo", 42);

    expect(result.proceed).toBe(false);
    expect(result.reason).toBe("already_merged");
  });

  it("returns proceed=false with reason 'branch_exists' when active branch found", async () => {
    // isIssueResolved → empty (no merged PR), hasActiveBranch → true
    mockExec((cmd, cb) => {
      if (cmd.includes("pulls")) {
        cb(null, "", ""); // no merged PR
      } else {
        cb(null, "abc123  refs/heads/afk/issue-5\n", ""); // branch exists
      }
    });

    const result = await idempotency.shouldProcessIssue("owner", "repo", 5);

    expect(result.proceed).toBe(false);
    expect(result.reason).toBe("branch_exists");
  });

  it("returns proceed=false with reason 'claimed' when isClaimed returns true", async () => {
    // isIssueResolved → empty, hasActiveBranch → false (throws)
    mockExec((cmd, cb) => {
      if (cmd.includes("pulls")) {
        cb(null, "", "");
      } else {
        cb(new Error("not found"), "", "");
      }
    });

    // Override isClaimed to return true (in the current module scope)
    const { isClaimed } = await import("./afk-claims-store.js");
    vi.mocked(isClaimed).mockReset().mockResolvedValue(true);

    // Re-import the module so it picks up the updated mock value
    vi.resetModules();
    clearMock();
    const { isClaimed: isClaimed2 } = await import("./afk-claims-store.js");
    vi.mocked(isClaimed2).mockReset().mockResolvedValue(true);
    idempotency = await import("./afk-idempotency.js");

    const result = await idempotency.shouldProcessIssue("owner", "repo", 10);

    expect(result.proceed).toBe(false);
    expect(result.reason).toBe("claimed");
  });

  it("returns proceed=true with no reason when all guards pass", async () => {
    // isIssueResolved → empty, hasActiveBranch → false (throws)
    mockExec((cmd, cb) => {
      if (cmd.includes("pulls")) {
        cb(null, "", "");
      } else {
        cb(new Error("not found"), "", "");
      }
    });

    // isClaimed already false from beforeEach setup
    const result = await idempotency.shouldProcessIssue("owner", "repo", 99);

    expect(result.proceed).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
