import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const CLAIMS_FILE = "/data/.clawdbot/afk-claims.json";

// Shared in-memory store for the fs mock — exposed so tests can seed it
const sharedMemoryStore: Record<string, string> = {};

vi.mock("node:fs");

describe("afk-claims-store", () => {
  let store: typeof import("./afk-claims-store.js");

  beforeEach(async () => {
    vi.resetModules();
    // Reset the shared memory store for this test
    for (const k of Object.keys(sharedMemoryStore)) delete sharedMemoryStore[k];
    vi.doMock("node:fs", () => ({
      promises: {
        readFile: vi.fn(async (filePath: string) => {
          if (filePath === CLAIMS_FILE) {
            if (sharedMemoryStore[CLAIMS_FILE] === undefined) {
              const err = new Error("ENOENT") as Error & { code: string };
              err.code = "ENOENT";
              throw err;
            }
            return sharedMemoryStore[CLAIMS_FILE];
          }
          throw new Error("Unexpected path: " + filePath);
        }),
        writeFile: vi.fn(async (filePath: string, data: string) => {
          if (filePath === CLAIMS_FILE) {
            sharedMemoryStore[CLAIMS_FILE] = data;
          }
        }),
        mkdir: vi.fn(async () => {}),
      },
    }));
    store = await import("./afk-claims-store.js");
    store.__testingResetStore();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("claimIssue", () => {
    it("claims a new issue and returns true", async () => {
      const result = await store.claimIssue("owner", "repo", 42);
      expect(result).toBe(true);
    });

    it("returns false when issue is already claimed", async () => {
      await store.claimIssue("owner", "repo", 42);
      const result = await store.claimIssue("owner", "repo", 42);
      expect(result).toBe(false);
    });

    it("claims the same issue number across different repos independently", async () => {
      await store.claimIssue("owner", "repo-a", 1);
      await store.claimIssue("owner", "repo-b", 1);
      // Both should be claimed separately
      const a = await store.isClaimed("owner", "repo-a", 1);
      const b = await store.isClaimed("owner", "repo-b", 1);
      expect(a).toBe(true);
      expect(b).toBe(true);
    });

    it("allows different owners for the same repo", async () => {
      await store.claimIssue("owner-a", "repo", 1);
      const sameOwnerResult = await store.claimIssue("owner-a", "repo", 1);
      expect(sameOwnerResult).toBe(false);
      const otherOwner = await store.isClaimed("owner-b", "repo", 1);
      expect(otherOwner).toBe(false);
    });
  });

  describe("isClaimed", () => {
    it("returns false for unclaimed issues", async () => {
      const result = await store.isClaimed("owner", "repo", 99);
      expect(result).toBe(false);
    });

    it("returns true for claimed issues", async () => {
      await store.claimIssue("owner", "repo", 99);
      const result = await store.isClaimed("owner", "repo", 99);
      expect(result).toBe(true);
    });
  });

  describe("expireClaims", () => {
    it("removes claims older than 2 hours", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000 - 1).toISOString();
      const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const seeded = store.__testingSeedStore({
        "owner/repo#1": twoHoursAgo,
        "owner/repo#2": recent,
      });
      // Also seed the fs mock so subsequent load() calls see the seeded data
      sharedMemoryStore[CLAIMS_FILE] = seeded;

      store.expireClaims();

      // Verify via public API: expired claim should no longer be claimed
      const oldClaimed = await store.isClaimed("owner", "repo", 1);
      expect(oldClaimed).toBe(false);
      // Recent claim should still be claimed
      const recentClaimed = await store.isClaimed("owner", "repo", 2);
      expect(recentClaimed).toBe(true);
    });
  });
});
