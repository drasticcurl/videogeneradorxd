/**
 * Reusable retry/backoff helper for transient network errors.
 *
 * Wraps an async operation with exponential backoff. Triggered on:
 *   - Network errors (ECONNREFUSED, ECONNRESET, ENOTFOUND, etc.)
 *   - HTTP 5xx responses
 *   - Timeout errors (request exceeds the configured timeout)
 *
 * Requirements: 11
 */

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Indicates a retryable transient error from the editor sidecar.
 */
export class EditorTransientError extends Error {
  public readonly retryable = true as const;

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EditorTransientError";
  }
}

/**
 * Indicates a non-retryable error from the editor (4xx, invalid response, etc.).
 */
export class EditorPermanentError extends Error {
  public readonly retryable = false as const;

  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "EditorPermanentError";
  }
}

// ---------------------------------------------------------------------------
// Retry options
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 5. */
  maxAttempts?: number;
  /** Initial delay in ms before the first retry. Default: 1000. */
  initialDelayMs?: number;
  /** Multiplier applied on each successive delay. Default: 2. */
  multiplier?: number;
  /** Maximum delay cap in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Optional sleep function (for testing). Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// Backoff schedule helper (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Computes the delay sequence for the given retry options.
 * Returns an array of delays in ms for attempts 1..maxAttempts-1
 * (attempt 0 has no delay).
 */
export function computeBackoffSchedule(opts?: RetryOptions): number[] {
  const { maxAttempts, initialDelayMs, multiplier, maxDelayMs } = {
    ...DEFAULT_OPTIONS,
    ...opts,
  };
  const schedule: number[] = [];
  let delay = initialDelayMs;
  for (let i = 1; i < maxAttempts; i++) {
    schedule.push(Math.min(delay, maxDelayMs));
    delay *= multiplier;
  }
  return schedule;
}

// ---------------------------------------------------------------------------
// Core retry wrapper
// ---------------------------------------------------------------------------

/**
 * Executes `fn` with retry/backoff on transient failures.
 *
 * The caller's `fn` should throw `EditorTransientError` for retryable cases
 * or `EditorPermanentError` for non-retryable cases. Any other thrown value
 * is treated as non-retryable and rethrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const { maxAttempts, initialDelayMs, multiplier, maxDelayMs, sleep } = {
    ...DEFAULT_OPTIONS,
    ...opts,
  };

  let lastError: unknown;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    console.log(`[withRetry] attempt ${attempt + 1}/${maxAttempts}`);
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      // Only retry on transient errors
      if (err instanceof EditorTransientError) {
        if (attempt < maxAttempts - 1) {
          const sleepTime = Math.min(delay, maxDelayMs);
          console.log(`[withRetry] sleeping ${sleepTime}ms before retry`);
          await sleep(sleepTime);
          delay *= multiplier;
          continue;
        }
      }

      // Non-retryable or unknown: rethrow immediately
      if (!(err instanceof EditorTransientError)) {
        throw err;
      }
    }
  }

  // All attempts exhausted
  console.log("[withRetry] ALL RETRIES EXHAUSTED");
  throw lastError;
}
