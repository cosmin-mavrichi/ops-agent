export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…[truncated ${dropped} chars — narrow the query]`;
}

export class TimeoutError extends Error {}
export class CancelledError extends Error {}

/**
 * Runs fn with a signal that aborts after `ms` or when `parent` aborts, whichever comes first.
 * Rejects with TimeoutError or CancelledError even if fn ignores the signal, so callers always
 * get an answer on time.
 */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new TimeoutError(`timed out after ${ms}ms`)), ms);
  const signal = parent ? AbortSignal.any([timeout.signal, parent]) : timeout.signal;
  try {
    return await Promise.race([fn(signal), rejectOnAbort(signal)]);
  } finally {
    clearTimeout(timer);
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () =>
      reject(signal.reason instanceof TimeoutError ? signal.reason : new CancelledError("cancelled by client"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}
