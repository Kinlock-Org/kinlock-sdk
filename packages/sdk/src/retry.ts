/**
 * Exponential backoff with full jitter for transient Soroban RPC and Horizon rate limits.
 * Roadmap M2-04, Issue #68.
 *
 * Retries HTTP 429 (rate limits), HTTP 503 (service unavailable), and transient network errors.
 * Fails immediately on 400 Bad Request and contract logic errors.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3). Total calls = maxRetries + 1. */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 200ms). */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 5000ms). */
  maxDelayMs?: number;
  /** Predicate determining whether an error is retryable. */
  shouldRetry?: (error: unknown) => boolean;
  /** Custom sleeper function (injected for deterministic testing). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Custom random generator returning [0, 1) (injected for deterministic testing). */
  randomFn?: () => number;
}

/**
 * Determines whether an error is transient (e.g. rate limit, 503, network disconnect).
 * Never retries 400 Bad Request, auth failures, or contract simulation aborts.
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;

  // Inspect error objects (e.g. HTTP responses, SDK errors)
  if (typeof error === "object") {
    const err = error as Record<string, unknown>;

    // Contract errors or input errors must never be retried
    if (err.kind === "INVALID_INPUT" || err.kind === "CONTRACT_ERROR") return false;

    // Check status codes if present
    const status = (err.status ??
      err.statusCode ??
      (err.response as Record<string, unknown> | undefined)?.status) as number | undefined;

    if (typeof status === "number") {
      // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found fail immediately
      if (status === 400 || status === 401 || status === 403 || status === 404) {
        return false;
      }
      if (status === 429 || status === 502 || status === 503 || status === 504) {
        return true;
      }
    }

    // Node.js network error codes
    const code = err.code as string | undefined;
    if (
      code &&
      [
        "ECONNRESET",
        "ETIMEDOUT",
        "ENOTFOUND",
        "ECONNREFUSED",
        "EAI_AGAIN",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(code)
    ) {
      return true;
    }
  }

  // Parse message strings
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Explicit non-transient keywords
  if (
    lower.includes("bad request") ||
    lower.includes("status: 400") ||
    lower.includes("status code 400") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid input")
  ) {
    return false;
  }

  // Transient keywords
  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("503") ||
    lower.includes("service unavailable") ||
    lower.includes("502") ||
    lower.includes("bad gateway") ||
    lower.includes("504") ||
    lower.includes("gateway timeout") ||
    lower.includes("connection reset") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("network error")
  ) {
    return true;
  }

  return false;
}

/**
 * Calculates backoff delay with full jitter:
 * delay = random() * min(maxDelayMs, baseDelayMs * 2 ** attempt)
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs = 200,
  maxDelayMs = 5000,
  randomFn: () => number = Math.random,
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(randomFn() * cap);
}

/**
 * Wraps an async function with exponential backoff and full jitter.
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 200;
  const maxDelayMs = options?.maxDelayMs ?? 5000;
  const shouldRetry = options?.shouldRetry ?? isTransientError;
  const sleep =
    options?.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options?.randomFn ?? Math.random;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !shouldRetry(err)) {
        throw err;
      }
      const delay = calculateBackoff(attempt, baseDelayMs, maxDelayMs, random);
      await sleep(delay);
    }
  }

  throw lastError;
}
