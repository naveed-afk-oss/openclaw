import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const calls: string[] = [];
let mockCallIndex = 0;
let mockCallResults: Array<{ stdout: string; stderr: string; exit: number }> = [];

function resetMock() {
  mockCallResults = [];
  mockCallIndex = 0;
  calls.length = 0;
}

// --- Mock the child_process exec used internally ---
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

import { exec as execSync } from "node:child_process";

function mockExec(
  impl: (cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) => void,
) {
  vi.mocked(execSync).mockImplementation(impl as typeof execSync);
}

function mockSuccess(stdout = "", stderr = "") {
  mockCallResults.push({ stdout, stderr, exit: 0 });
}

function nextCall(): {
  cmd: string;
  cb: (err: Error | null, stdout: string, stderr: string) => void;
} | null {
  const idx = mockCallIndex++;
  const impl = vi.mocked(execSync).mock.calls[idx] as Array<
    [string, (err: Error | null, stdout: string, stderr: string) => void]
  >;
  if (!impl) return null;
  return { cmd: impl[0], cb: impl[1] };
}

function fireNextResult(stdout = "", stderr = "", err: Error | null = null) {
  const call = nextCall();
  if (call) call.cb(err, stdout, stderr);
}

describe("afk-branch-manager", () => {
  let branchManager: typeof import("./afk-branch-manager.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    resetMock();

    branchManager = await import("./afk-branch-manager.js");
  });

  afterEach(() => {
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // worktreePath
  // -------------------------------------------------------------------------
  describe("worktreePath", () => {
    it("returns {repoRoot}/.git/worktrees/afk-issue-{N}", () => {
      const result = branchManager.worktreePath("/home/user/repo", 42);
      expect(result).toBe("/home/user/repo/.git/worktrees/afk-issue-42");
    });

    it("handles arbitrary issue numbers", () => {
      expect(branchManager.worktreePath("/repo", 1)).toBe("/repo/.git/worktrees/afk-issue-1");
      expect(branchManager.worktreePath("/repo", 999)).toBe("/repo/.git/worktrees/afk-issue-999");
    });
  });

  // -------------------------------------------------------------------------
  // branchExists
  // -------------------------------------------------------------------------
  describe("branchExists", () => {
    it("returns true when ls-remote finds the branch ref", async () => {
      mockExec((_cmd, cb) => cb(null, "abc123  refs/heads/afk/issue-42\n", ""));

      const result = await branchManager.branchExists("owner", "repo", "afk/issue-42");

      expect(result).toBe(true);
    });

    it("returns false when ls-remote returns empty output", async () => {
      mockExec((_cmd, cb) => cb(null, "", ""));

      const result = await branchManager.branchExists("owner", "repo", "afk/issue-99");

      expect(result).toBe(false);
    });

    it("returns false on error (network, auth, etc.)", async () => {
      mockExec((_cmd, cb) => cb(new Error("auth failed"), "", ""));

      const result = await branchManager.branchExists("owner", "repo", "afk/issue-42");

      expect(result).toBe(false);
    });

    it("constructs correct remote URL with token", async () => {
      process.env.GH_TOKEN = "secret123";
      let capturedCmd = "";
      mockExec((cmd, cb) => {
        capturedCmd = cmd;
        cb(null, "abc123  refs/heads/main\n", "");
      });

      await branchManager.branchExists("my-owner", "my-repo", "afk/issue-1");

      expect(capturedCmd).toContain("x-access-token:secret123");
      expect(capturedCmd).toContain("my-owner/my-repo");
      delete process.env.GH_TOKEN;
    });
  });

  // -------------------------------------------------------------------------
  // createBranch
  // -------------------------------------------------------------------------
  describe("createBranch", () => {
    it("returns 'afk/issue-{N}' as the branch name", async () => {
      mockExec((_cmd, cb) => cb(null, "", ""));

      const result = await branchManager.createBranch("owner", "repo", 42, "main", "/tmp/repo");

      expect(result).toBe("afk/issue-42");
    });

    it("calls git fetch for the base branch", async () => {
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.createBranch("owner", "repo", 1, "develop", "/tmp/repo");

      expect(cmds.some((c) => c.includes("fetch") && c.includes("develop"))).toBe(true);
    });

    it("calls git checkout -b with the new branch name", async () => {
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.createBranch("owner", "repo", 7, "main", "/tmp/repo");

      expect(
        cmds.some((c) => c.includes("checkout") && c.includes("-b") && c.includes("afk/issue-7")),
      ).toBe(true);
    });

    it("calls git push -u origin with the new branch", async () => {
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.createBranch("owner", "repo", 3, "main", "/tmp/repo");

      expect(
        cmds.some(
          (c) =>
            c.includes("push") &&
            c.includes("-u") &&
            c.includes("origin") &&
            c.includes("afk/issue-3"),
        ),
      ).toBe(true);
    });

    it("uses 'main' as default base branch when not specified", async () => {
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.createBranch(
        "owner",
        "repo",
        5,
        undefined as unknown as string,
        "/tmp/repo",
      );

      expect(cmds.some((c) => c.includes("fetch") && c.includes("origin/main"))).toBe(true);
    });

    it("sets remote URL with GH_TOKEN before push", async () => {
      process.env.GH_TOKEN = "token456";
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.createBranch("owner", "repo", 1, "main", "/tmp/repo");

      const setUrlCall = cmds.find((c) => c.includes("remote set-url"));
      expect(setUrlCall).toBeTruthy();
      expect(setUrlCall).toContain("x-access-token:token456");
      expect(setUrlCall).toContain("owner/repo");

      delete process.env.GH_TOKEN;
    });
  });

  // -------------------------------------------------------------------------
  // createWorktree
  // -------------------------------------------------------------------------
  describe("createWorktree", () => {
    it("returns the correct worktree path", async () => {
      mockExec((_cmd, cb) => cb(null, "", ""));

      const result = await branchManager.createWorktree("/home/user/repo", 42, "afk/issue-42");

      expect(result).toBe("/home/user/repo/.git/worktrees/afk-issue-42");
    });

    it("calls git worktree prune before adding", async () => {
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.createWorktree("/tmp/repo", 1, "afk/issue-1");

      expect(cmds.some((c) => c.includes("worktree prune"))).toBe(true);
    });

    it("calls git worktree add with branch name and path", async () => {
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.createWorktree("/tmp/repo", 5, "afk/issue-5");

      const worktreeAddCall = cmds.find((c) => c.includes("worktree add"));
      expect(worktreeAddCall).toBeTruthy();
      expect(worktreeAddCall).toContain("/tmp/repo/.git/worktrees/afk-issue-5");
      expect(worktreeAddCall).toContain("afk/issue-5");
    });

    it("is idempotent: does not throw when worktree already exists", async () => {
      let callCount = 0;
      mockExec((_cmd, cb) => {
        callCount++;
        if (callCount === 1) {
          cb(null, "", ""); // prune — ok
        } else if (callCount === 2) {
          cb(new Error("fatal: worktree 'afk-issue-3' already exists"), "", ""); // worktree add — exists, ignore
        } else {
          cb(null, "", "");
        }
      });

      const result = await branchManager.createWorktree("/tmp/repo", 3, "afk/issue-3");

      expect(result).toBe("/tmp/repo/.git/worktrees/afk-issue-3");
    });
  });

  // -------------------------------------------------------------------------
  // cleanupBranch
  // -------------------------------------------------------------------------
  describe("cleanupBranch", () => {
    it("removes the worktree with --force", async () => {
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.cleanupBranch("owner", "repo", 42, "/tmp/repo");

      const removeCall = cmds.find((c) => c.includes("worktree remove"));
      expect(removeCall).toContain("afk-issue-42");
      expect(removeCall).toContain("--force");
    });

    it("deletes the local branch", async () => {
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.cleanupBranch("owner", "repo", 42, "/tmp/repo");

      const branchDeleteCall = cmds.find(
        (c) => c.includes("branch") && c.includes("-D") && c.includes("afk/issue-42"),
      );
      expect(branchDeleteCall).toBeTruthy();
    });

    it("deletes the remote branch via push --delete", async () => {
      const cmds: string[] = [];
      mockExec((cmd, cb) => {
        cmds.push(cmd);
        cb(null, "", "");
      });

      await branchManager.cleanupBranch("owner", "repo", 42, "/tmp/repo");

      const pushDeleteCall = cmds.find(
        (c) =>
          c.includes("push") &&
          c.includes("--delete") &&
          c.includes("origin") &&
          c.includes("afk/issue-42"),
      );
      expect(pushDeleteCall).toBeTruthy();
    });

    it("does not throw if worktree is already gone", async () => {
      mockExec((cmd, cb) => {
        // worktree remove fails — that's fine
        cb(new Error("fatal: worktree not found"), "", "");
      });

      await expect(
        branchManager.cleanupBranch("owner", "repo", 99, "/tmp/repo"),
      ).resolves.toBeUndefined();
    });

    it("does not throw if remote branch is already deleted", async () => {
      let callCount = 0;
      mockExec((cmd, cb) => {
        callCount++;
        // First two succeed (worktree remove, branch -D), push --delete fails but is ignored
        if (cmd.includes("push") && cmd.includes("delete")) {
          cb(new Error("remote ref not found"), "", "");
        } else {
          cb(null, "", "");
        }
      });

      await expect(
        branchManager.cleanupBranch("owner", "repo", 5, "/tmp/repo"),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getHeadSha
  // -------------------------------------------------------------------------
  describe("getHeadSha", () => {
    it("returns the current HEAD SHA", async () => {
      mockExec((cmd, cb) => {
        cb(null, "abc123def456\n", "");
      });

      const result = await branchManager.getHeadSha("/tmp/repo");

      expect(result).toBe("abc123def456");
    });
  });
});
