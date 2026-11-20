import { describe, expect, it } from "vitest";
import { CancelledError, TimeoutError, truncate, withTimeout } from "../../src/lib/limits.js";

const never = () => new Promise<never>(() => {});

describe("withTimeout", () => {
  it("returns the result when fn finishes in time", async () => {
    await expect(withTimeout(1_000, async () => "done")).resolves.toBe("done");
  });

  it("rejects with TimeoutError even if fn ignores the signal", async () => {
    await expect(withTimeout(20, never)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("aborts the signal it hands to fn on timeout", async () => {
    let seen: AbortSignal | undefined;
    await withTimeout(20, (signal) => {
      seen = signal;
      return never();
    }).catch(() => {});
    expect(seen?.aborted).toBe(true);
  });

  it("rejects with CancelledError when the parent aborts first", async () => {
    const parent = new AbortController();
    const run = withTimeout(10_000, never, parent.signal);
    parent.abort();
    await expect(run).rejects.toBeInstanceOf(CancelledError);
  });

  it("rejects immediately when the parent is already aborted", async () => {
    await expect(withTimeout(10_000, never, AbortSignal.abort())).rejects.toBeInstanceOf(CancelledError);
  });

  it("passes fn's own errors through", async () => {
    const boom = new Error("boom");
    await expect(withTimeout(1_000, () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("cuts long text and says how much was dropped", () => {
    expect(truncate("x".repeat(30), 10)).toBe(`${"x".repeat(10)}\n…[truncated 20 chars — narrow the query]`);
  });
});
