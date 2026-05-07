import { describe, it, expect, beforeEach, vi } from "vitest";
import { AfkPrMerger } from "./afk-pr-merger.js";

// ── mock curl helper ──────────────────────────────────────────────────────────

type CurlMock = vi.Mock<() => Promise<{ stdout: string; stderr: string; exitCode: number }>>;

function mockCurl(fn: CurlMock) {
  return fn;
}

function mockSuccess(stdout: string): { stdout: string; stderr: string; exitCode: number } {
  return { stdout, stderr: "", exitCode: 0 };
}

// ── shared beforeEach ─────────────────────────────────────────────────────────

let merger: AfkPrMerger;

beforeEach(() => {
  merger = new AfkPrMerger("fake-gh-token");
});

// ── prExists ──────────────────────────────────────────────────────────────────

describe("prExists", () => {
  it("returns exists:true with prUrl and prNumber when open PR found", async () => {
    const mock = mockCurl(
      vi
        .spyOn(merger as any, "execCurl")
        .mockImplementation(async () =>
          mockSuccess(
            JSON.stringify([
              { number: 42, html_url: "https://github.com/org/repo/pull/42", state: "open" },
            ]),
          ),
        ),
    );

    const result = await merger.prExists("org", "repo", "afk/issue-42");

    expect(result.exists).toBe(true);
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
  });

  it("returns exists:false when no open PR found", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(JSON.stringify([])),
    );

    const result = await merger.prExists("org", "repo", "afk/issue-99");

    expect(result.exists).toBe(false);
    expect(result.prNumber).toBeUndefined();
    expect(result.prUrl).toBeUndefined();
  });

  it("ignores closed PRs in the response", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(
        JSON.stringify([
          { number: 7, html_url: "https://github.com/org/repo/pull/7", state: "closed" },
        ]),
      ),
    );

    const result = await merger.prExists("org", "repo", "afk/issue-7");

    expect(result.exists).toBe(false);
  });
});

// ── createPr ──────────────────────────────────────────────────────────────────

describe("createPr", () => {
  it("returns PR number and URL from GitHub API response", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(JSON.stringify({ number: 55, html_url: "https://github.com/org/repo/pull/55" })),
    );

    const result = await merger.createPr("org", "repo", "afk/issue-8", "main", 8);

    expect(result.prNumber).toBe(55);
    expect(result.prUrl).toBe("https://github.com/org/repo/pull/55");
  });

  it("uses issue number in title", async () => {
    const curlSpy = vi.spyOn(merger as any, "execCurl");
    curlSpy.mockImplementation(async () =>
      mockSuccess(JSON.stringify({ number: 1, html_url: "https://github.com/org/repo/pull/1" })),
    );

    await merger.createPr("org", "repo", "afk/issue-42", "main", 42);

    const callStr: string = curlSpy.mock.calls[0]![0] as string;
    // The curl args are joined with spaces; the title appears inside the -d JSON body
    expect(callStr).toContain("Auto: Fix issue #42");
  });

  it("throws when API returns a message error", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(JSON.stringify({ message: "Validation Failed", number: undefined })),
    );

    await expect(merger.createPr("org", "repo", "afk/issue-1", "main", 1)).rejects.toThrow(
      "GitHub API error: Validation Failed",
    );
  });
});

// ── isMergeable ───────────────────────────────────────────────────────────────

describe("isMergeable", () => {
  it("returns true when PR is mergeable", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(
        JSON.stringify({ mergeable: true, mergeable_state: "clean", merged: false, state: "open" }),
      ),
    );

    const result = await merger.isMergeable("org", "repo", 42);

    expect(result).toBe(true);
  });

  it("returns false when PR has merge conflicts (mergeable: false)", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(JSON.stringify({ mergeable: false, merged: false, state: "open" })),
    );

    const result = await merger.isMergeable("org", "repo", 42);

    expect(result).toBe(false);
  });

  it("returns false when PR is blocked", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(
        JSON.stringify({
          mergeable: true,
          mergeable_state: "blocked",
          merged: false,
          state: "open",
        }),
      ),
    );

    const result = await merger.isMergeable("org", "repo", 42);

    expect(result).toBe(false);
  });

  it("returns false when PR is already merged", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(JSON.stringify({ mergeable: true, merged: true, state: "closed" })),
    );

    const result = await merger.isMergeable("org", "repo", 42);

    expect(result).toBe(false);
  });
});

// ── mergePr ───────────────────────────────────────────────────────────────────

describe("mergePr", () => {
  it("returns merged:true on success", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(JSON.stringify({ merged: true })),
    );

    const result = await merger.mergePr("org", "repo", 42);

    expect(result.merged).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns merged:false with error message on failure", async () => {
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () =>
      mockSuccess(JSON.stringify({ merged: false, message: "Merge conflict" })),
    );

    const result = await merger.mergePr("org", "repo", 42);

    expect(result.merged).toBe(false);
    expect(result.error).toContain("Merge conflict");
  });
});

// ── 409 conflict retry ────────────────────────────────────────────────────────

describe("mergePr — 409 conflict retry", () => {
  it("retries after 5s on 409 conflict", async () => {
    let callCount = 0;
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return mockSuccess(JSON.stringify({ merged: false, error: "409 Conflict" }));
      }
      return mockSuccess(JSON.stringify({ merged: true }));
    });

    const result = await merger.mergePr("org", "repo", 42);

    expect(result.merged).toBe(true);
    expect(callCount).toBe(2);
  });

  it("retries after 5s on mergeable state conflict", async () => {
    let callCount = 0;
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return mockSuccess(JSON.stringify({ merged: false, error: "Merge conflict" }));
      }
      return mockSuccess(JSON.stringify({ merged: true }));
    });

    const result = await merger.mergePr("org", "repo", 42);

    expect(result.merged).toBe(true);
    expect(callCount).toBe(2);
  });
});

// ── 429 rate limit backoff ───────────────────────────────────────────────────

describe("mergePr — 429 rate limit backoff", () => {
  it("retries with exponential backoff on 429", async () => {
    let callCount = 0;
    const startTime = Date.now();

    vi.spyOn(merger as any, "execCurl").mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) {
        return mockSuccess(JSON.stringify({ merged: false, error: "429 API rate limit exceeded" }));
      }
      return mockSuccess(JSON.stringify({ merged: true }));
    });

    const result = await merger.mergePr("org", "repo", 42);

    expect(result.merged).toBe(true);
    expect(callCount).toBe(4); // 3 failures + 1 success
    // Exponential backoff: 2^1*1000=2000ms, 2^2*1000=4000ms → total ~6s elapsed
    expect(Date.now() - startTime).toBeGreaterThan(5000);
  });

  it("respects Retry-After header value from error", async () => {
    let callCount = 0;
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return mockSuccess(JSON.stringify({ error: "429 Retry-After: 10" }));
      }
      return mockSuccess(JSON.stringify({ merged: true }));
    });

    const startTime = Date.now();
    await merger.mergePr("org", "repo", 42);

    // Should have waited ~10s (Retry-After), not 2s (exponential)
    expect(Date.now() - startTime).toBeGreaterThan(9000);
  });
});

// ── runMergePipeline ──────────────────────────────────────────────────────────

describe("runMergePipeline", () => {
  it("merges existing mergeable PR directly without creating a new one", async () => {
    let callCount = 0;
    const curlSpy = vi.spyOn(merger as any, "execCurl");

    // First call: prExists finds an existing PR
    // Second call: isMergeable says yes
    // Third call: mergePr succeeds
    curlSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return mockSuccess(
          JSON.stringify([
            { number: 10, html_url: "https://github.com/org/repo/pull/10", state: "open" },
          ]),
        );
      }
      if (callCount === 2) {
        return mockSuccess(
          JSON.stringify({
            mergeable: true,
            mergeable_state: "clean",
            merged: false,
            state: "open",
          }),
        );
      }
      return mockSuccess(JSON.stringify({ merged: true }));
    });

    const result = await merger.runMergePipeline("org", "repo", "afk/issue-10", "main", 10);

    expect(result.merged).toBe(true);
    expect(result.prUrl).toBe("https://github.com/org/repo/pull/10");
    expect(callCount).toBe(3); // prExists + isMergeable + mergePr
  });

  it("creates a new PR when none exists, then merges", async () => {
    let callCount = 0;
    const curlSpy = vi.spyOn(merger as any, "execCurl");

    // 1: prExists → no PR
    // 2: createPr
    // 3–14: isMergeable polling (12 attempts, mergeable on attempt 3)
    // 15: mergePr
    curlSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return mockSuccess(JSON.stringify([])); // prExists → none
      }
      if (callCount === 2) {
        return mockSuccess(
          JSON.stringify({ number: 77, html_url: "https://github.com/org/repo/pull/77" }),
        ); // createPr
      }
      if (callCount <= 13) {
        // Poll attempts 1-11: not mergeable
        if (callCount === 3) {
          return mockSuccess(
            JSON.stringify({
              mergeable: true,
              mergeable_state: "clean",
              merged: false,
              state: "open",
            }),
          );
        }
        return mockSuccess(JSON.stringify({ mergeable: false, merged: false, state: "open" }));
      }
      return mockSuccess(JSON.stringify({ merged: true })); // mergePr
    });

    const result = await merger.runMergePipeline("org", "repo", "afk/issue-5", "main", 5);

    expect(result.merged).toBe(true);
    expect(result.prUrl).toBe("https://github.com/org/repo/pull/77");
    expect(result.prUrl).toContain("77");
  });

  it("returns error when PR not mergeable after 60s timeout", async () => {
    let callCount = 0;
    vi.spyOn(merger as any, "execCurl").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return mockSuccess(JSON.stringify([])); // prExists → none
      }
      if (callCount === 2) {
        return mockSuccess(
          JSON.stringify({ number: 99, html_url: "https://github.com/org/repo/pull/99" }),
        ); // createPr
      }
      // Always not mergeable for all 12 polling attempts
      return mockSuccess(JSON.stringify({ mergeable: false, merged: false, state: "open" }));
    });

    const result = await merger.runMergePipeline("org", "repo", "afk/issue-99", "main", 99);

    expect(result.merged).toBe(false);
    expect(result.error).toBe("PR not mergeable after 60s timeout");
    expect(callCount).toBeGreaterThanOrEqual(13); // 1 prExists + 1 createPr + 12 poll
  });
});
