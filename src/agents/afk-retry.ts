export interface RetryOptions {
  /** Maximum number of attempts. Default: 5 */
  maxAttempts?: number;
  /** Initial delay in milliseconds. Default: 1000 */
  baseDelayMs?: number;
  /** Multiplier for exponential backoff. Default: 2 */
  multiplier?: number;
  /** Maximum delay in milliseconds. Default: 30000 */
  maxDelayMs?: number;
  /** HTTP status codes that warrant a retry. Default: [429, 500, 502, 503, 504] */
  retryableStatuses?: number[];
}

export interface RetryResult<T> {
  success: boolean;
  /** The return value of `fn()` on success */
  result?: T;
  /** Error message when all retries are exhausted */
  error?: string;
  /** Total attempts made (1 on first-success, up to maxAttempts on failure) */
  attempts: number;
}

/** Default retryable HTTP status codes */
export const DEFAULT_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

/**
 * Determine whether an HTTP status code warrants a retry.
 * Returns `true` for 429 and 5xx errors by default.
 */
export function isRetryableStatus(status: number): boolean {
  return DEFAULT_RETRYABLE_STATUSES.includes(status);
}

/**
 * Parse a Retry-After header value into milliseconds.
 * Handles both HTTP-date (RFC 7231) and delay-seconds formats.
 * Returns 0 for null/unparseable input.
 */
export function parseRetryAfter(header: string | null): number {
  if (!header) return 0;

  // Try delay-seconds format first (plain integer)
  const seconds = Number(header.trim());
  if (!isNaN(seconds)) {
    return Math.floor(seconds * 1000);
  }

  // Fall back to HTTP-date (RFC 7231)
  try {
    const date = new Date(header.trim());
    if (!isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }
  } catch {
    // fall through
  }

  return 0;
}

/**
 * Execute an async function with exponential backoff retry.
 *
 * Retries on:
 * - Network errors (any error with `code` starting with "ECONN" or "ETIMEDOUT", or message containing "ECONNREFUSED")
 * - HTTP responses with retryable status codes (default: 429, 500–504)
 *
 * When a Retry-After header is detected on a 429 response, that value is used
 * instead of the exponential backoff for that specific retry.
 *
 * @param fn - The async operation to execute.
 * @param options - Tuning parameters.
 * @returns A `RetryResult` with the result or error and attempt count.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<RetryResult<T>> {
  const maxAttempts = options?.maxAttempts ?? 5;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const multiplier = options?.multiplier ?? 2;
  const maxDelayMs = options?.maxDelayMs ?? 30000;
  const retryableStatuses = options?.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;

  let lastError: string = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { success: true, result, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);

      // Check if this error is retryable
      const retryable = isRetryableError(err, retryableStatuses);
      const isLastAttempt = attempt === maxAttempts;

      if (!retryable || isLastAttempt) {
        return { success: false, error: lastError, attempts: attempt };
      }

      // Extract Retry-After from error if available (e.g. from response headers)
      let retryAfterMs = 0;
      if (err && typeof err === "object" && "retryAfterMs" in err) {
        retryAfterMs = (err as { retryAfterMs: number }).retryAfterMs;
      }

      // Calculate delay
      const delayMs =
        retryAfterMs > 0
          ? Math.min(retryAfterMs, maxDelayMs)
          : Math.min(baseDelayMs * Math.pow(multiplier, attempt - 1), maxDelayMs);

      // Wait before retrying
      await sleep(delayMs);
    }
  }

  // Should never reach here, but just in case
  return { success: false, error: lastError, attempts: maxAttempts };
}

function isRetryableError(err: unknown, retryableStatuses: number[]): boolean {
  // Network errors are retryable
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code?.startsWith("ECONN") || code?.startsWith("ETIMEDOUT") || code === "ENOTFOUND") {
      return true;
    }
    if (err.message.includes("ECONNREFUSED")) {
      return true;
    }
    // Check for retryable HTTP status in error object
    if ("status" in err && typeof (err as { status: number }).status === "number") {
      return retryableStatuses.includes((err as { status: number }).status);
    }
    // Plain errors (no code, no status) are retryable — assume transient
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
