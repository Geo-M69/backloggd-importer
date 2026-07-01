/**
 * Shared fetch utility with timeout, retry with backoff, and Retry-After support.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for fetch requests (15 seconds). */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Maximum number of retry attempts for 429/5xx responses. */
const MAX_RETRIES = 3;

/** Initial backoff delay in milliseconds (doubles each retry). */
const INITIAL_BACKOFF_MS = 1_000;

/** Maximum backoff delay (cap at 30 seconds). */
const MAX_BACKOFF_MS = 30_000;

/** HTTP status codes that are eligible for retry. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FetchOptions {
  /** Request timeout in milliseconds (default: 15000). */
  timeoutMs?: number;
  /** Maximum number of retries (default: 3). */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

/**
 * Create an AbortSignal that times out after a given number of milliseconds.
 * Returns `undefined` if timeout is zero or not set, so native fetch behaviour
 * is preserved.
 */
function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/**
 * Parse the `Retry-After` header value (seconds or HTTP-date), returning
 * the number of milliseconds to wait, or `null` if unparsable.
 */
function parseRetryAfter(headers: Headers): number | null {
  const val = headers.get('Retry-After');
  if (!val) return null;

  // Try seconds first
  const seconds = Number(val);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }

  // Try HTTP-date format (rare for rate-limit headers, but handle gracefully)
  const parsed = Date.parse(val);
  if (Number.isFinite(parsed)) {
    const wait = parsed - Date.now();
    return wait > 0 ? Math.min(wait, MAX_BACKOFF_MS) : null;
  }

  return null;
}

/**
 * Calculate the delay before the next retry attempt using exponential backoff.
 * Respects the `Retry-After` header if present.
 */
async function backoffDelay(attempt: number, response: Response | null): Promise<void> {
  let delayMs: number;

  if (response) {
    const retryAfter = parseRetryAfter(response.headers);
    if (retryAfter !== null) {
      delayMs = retryAfter;
    } else {
      delayMs = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    }
  } else {
    // Network error — use exponential backoff
    delayMs = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  }

  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A composite error carrying the underlying response so callers can inspect
 * status codes and headers even when the request was not retried.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly response: Response;

  constructor(response: Response) {
    super(`HTTP ${response.status}: ${response.statusText}`);
    this.name = 'HttpError';
    this.status = response.status;
    this.statusText = response.statusText;
    this.response = response;
  }
}

/**
 * Fetch a resource with timeout, retry, and backoff.
 *
 * Retryable statuses: 408, 429, 500, 502, 503, 504.
 * Network errors (fetch throws) and timeouts are also retried.
 *
 * Non-retryable statuses (including 401) are returned as normal Response
 * objects so callers can inspect and handle them (e.g. token refresh).
 * After exhausting retries on retryable statuses, the last error is thrown.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit & FetchOptions = {},
): Promise<Response> {
  const { timeoutMs, maxRetries, ...fetchInit } = init;
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const effectiveMaxRetries = maxRetries ?? MAX_RETRIES;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    try {
      const signal = timeoutSignal(effectiveTimeoutMs);

      // Combine user-provided signal with timeout signal if both exist
      const signals = [signal, fetchInit.signal].filter(Boolean) as AbortSignal[];
      const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

      const response = await fetch(url, { ...fetchInit, signal: combinedSignal });

      // Success — return immediately
      if (response.ok) {
        return response;
      }

      // Non-retryable status — return to caller for inspection (e.g. 401)
      if (!RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }

      // Retryable status — backoff and retry
      lastError = new HttpError(response);
      if (attempt < effectiveMaxRetries) {
        await backoffDelay(attempt, response);
        continue;
      }
    } catch (err) {
      // AbortError / Timeout — retry if attempts remain
      if (err instanceof DOMException && err.name === 'AbortError') {
        lastError = new Error('Request timed out');
        if (attempt < effectiveMaxRetries) {
          await backoffDelay(attempt, null);
          continue;
        }
      }

      // Network errors and others — retry if attempts remain
      if (attempt < effectiveMaxRetries) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await backoffDelay(attempt, null);
        continue;
      }

      throw err;
    }
  }

  throw lastError ?? new Error('Request failed after retries');
}
