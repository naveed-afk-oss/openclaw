import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  isRetryableStatus,
  parseRetryAfter,
  RetryOptions,
  DEFAULT_RETRYABLE_STATUSES,
} from "./afk-retry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock setTimeout so tests are instant
// ─────────────────────────────────────────────────────────────────────────────
const fakeTimers: { ms: number; resolve: (() => void) | null } = { ms: 0, resolve: null };
let scheduledCallbacks: Array<() => void> = [];

vi.mock("node:timers", () => ({
  setTimeout: vi.fn((fn: () => void, ms: number) => {
    scheduledCallbacks.push(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }),
}));

function flushTimers() {
  const callbacks = [...scheduledCallbacks];
  scheduledCallbacks = [];
  callbacks.forEach((cb) => cb());
}

function runAllTimers() {
  const callbacks = [...scheduledCallbacks];
  scheduledCallbacks = [];
  callbacks.forEach((cb) => cb());
}

// ─────────────────────────────────────────────────────────────────────────────
// isRetryableStatus
// ─────────────────────────────────────────────────────────────────────────────
describe("isRetryableStatus", () => {
  it("returns true for 429 (Too Many Requests)", () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it("returns true for 500 (Internal Server Error)", () => {
    expect(isRetryableStatus(500)).toBe(true);
  });

  it("returns true for 502 (Bad Gateway)", () => {
    expect(isRetryableStatus(502)).toBe(true);
  });

  it("returns true for 503 (Service Unavailable)", () => {
    expect(isRetryableStatus(503)).toBe(true);
  });

  it("returns true for 504 (Gateway Timeout)", () => {
    expect(isRetryableStatus(504)).toBe(true);
  });

  it("returns false for 200 (OK)", () => {
    expect(isRetryableStatus(200)).toBe(false);
  });

  it("returns false for 400 (Bad Request)", () => {
    expect(isRetryableStatus(400)).toBe(false);
  });

  it("returns false for 401 (Unauthorized)", () => {
    expect(isRetryableStatus(401)).toBe(false);
  });

  it("returns false for 404 (Not Found)", () => {
    expect(isRetryableStatus(404)).toBe(false);
  });

  it("returns false for 403 (Forbidden)", () => {
    expect(isRetryableStatus(403)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseRetryAfter
// ─────────────────────────────────────────────────────────────────────────────
describe("parseRetryAfter", () => {
  it("parses plain integer seconds", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter("30")).toBe(30_000);
  });

  it("parses decimal seconds", () => {
    expect(parseRetryAfter("1.5")).toBe(1_500);
  });

  it("returns 0 for null", () => {
    expect(parseRetryAfter(null)).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseRetryAfter("")).toBe(0);
  });

  it("returns 0 for unparseable strings", () => {
    expect(parseRetryAfter("not-a-number")).toBe(0);
  });

  it("parses HTTP-date (RFC 7231) in the future", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).toBeGreaterThan(50_000);
    expect(result).toBeLessThanOrEqual(60_000);
  });

  it("returns 0 for past HTTP-date", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withRetry
// ─────────────────────────────────────────────────────────────────────────────
describe("withRetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    scheduledCallbacks = [];
    fakeTimers.ms = 0;
    fakeTimers.resolve = null;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns success on first try when fn succeeds", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result.success).toBe(true);
    expect(result.result).toBe("ok");
    expect(result.attempts).toBe(1);
  });

  it("returns success after one retry when fn fails then succeeds", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      }
      return "fixed";
    });

    const result = await withRetry(fn, { baseDelayMs: 0, maxAttempts: 3 });
    expect(result.success).toBe(true);
    expect(result.result).toBe("fixed");
    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("returns failure after exhausting max attempts", async () => {
    const fn = vi.fn().mockImplementation(async () => {
      throw Object.assign(new Error("persistent failure"), { status: 500 });
    });

    const result = await withRetry(fn, { maxAttempts: 4, baseDelayMs: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toBe("persistent failure");
    expect(result.attempts).toBe(4);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("retries on network errors (ECONNREFUSED)", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error("connection refused") as Error & { code: string };
        err.code = "ECONNREFUSED";
        throw err;
      }
      return "recovered";
    });

    const result = await withRetry(fn, { baseDelayMs: 0, maxAttempts: 3 });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("retries on ETIMEDOUT errors", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error("timeout") as Error & { code: string };
        err.code = "ETIMEDOUT";
        throw err;
      }
      return "recovered";
    });

    const result = await withRetry(fn, { baseDelayMs: 0, maxAttempts: 2 });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("does NOT retry on non-retryable errors (e.g. 400)", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      const err = new Error("bad request") as Error & { status: number };
      err.status = 400;
      throw err;
    });

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 });

    // Should fail immediately — 400 is not in default retryable statuses
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 status in error object", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("rate limited") as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return "rate limit lifted";
    });

    const result = await withRetry(fn, { baseDelayMs: 0, maxAttempts: 3 });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("respects custom retryableStatuses", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      const err = new Error("bad gateway") as Error & { status: number };
      err.status = 502;
      throw err;
    });

    // With default it would retry; with empty list it should not
    const result = await withRetry(fn, {
      retryableStatuses: [],
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it("uses Retry-After delay when err.retryAfterMs is present", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("429") as Error & { status: number; retryAfterMs: number };
        err.status = 429;
        err.retryAfterMs = 10_000;
        throw err;
      }
      return "retry-after-respected";
    });

    const result = await withRetry(fn, { baseDelayMs: 1000, maxAttempts: 3 });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("caps delay at maxDelayMs", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("retryable") as Error & { status: number };
        err.status = 500;
        throw err;
      }
      return "capped";
    });

    const result = await withRetry(fn, {
      baseDelayMs: 1_000,
      multiplier: 10,
      maxDelayMs: 5_000,
      maxAttempts: 5,
    });

    // With base=1000, mult=10, attempt 1→ delay=1000; attempt 2→ delay=10000, capped to 5000
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("returns error message on final failure", async () => {
    const fn = vi.fn().mockImplementation(async () => {
      throw Object.assign(new Error("final failure message"), { status: 502 });
    });

    const result = await withRetry(fn, { maxAttempts: 2, baseDelayMs: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toBe("final failure message");
    expect(result.attempts).toBe(2);
  });
});
