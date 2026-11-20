import { afterEach, describe, expect, it } from "vitest";
import { pgSlowQueries } from "../../../src/tools/postgres.js";
import type { SqlClient } from "../../../src/types.js";
import { startHarness } from "../../harness.js";

/** Fake that records SQL and answers by matching on the statement. */
function fakePg(opts: { extension?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("pg_extension WHERE")) return [{ ok: opts.extension ?? true }] as any;
      if (sql.includes("pg_stat_statements_info"))
        return [{ stats_since: new Date("2026-11-18T00:00:00Z"), dealloc: "0" }] as any;
      return [
        {
          queryid: "42",
          query: "SELECT * FROM reviews WHERE product_id = $1",
          calls: "1000",
          total_ms: "52000.0",
          mean_ms: "52.00",
          max_ms: "900.0",
          rows: "20000",
          hit_ratio: "97.5",
          temp_mb: "0.0",
        },
      ] as any;
    },
  };
  return { client, calls };
}

let h: Awaited<ReturnType<typeof startHarness>> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("pg_slow_queries (unit)", () => {
  it("maps rows into numbers the model can reason about", async () => {
    const pg = fakePg();
    h = await startHarness({ tools: [pgSlowQueries], pg: pg.client });
    const res = await h.call("pg_slow_queries", { limit: 5 });
    expect(res.isError).toBe(false);
    expect(res.json.queries[0]).toMatchObject({ calls: 1000, mean_ms: 52, rows_per_call: 20, cache_hit_pct: 97.5 });
    expect(pg.calls.at(-1)?.params).toEqual([5]);
  });

  it("only ever puts whitelisted columns into ORDER BY", async () => {
    const pg = fakePg();
    h = await startHarness({ tools: [pgSlowQueries], pg: pg.client });
    await h.call("pg_slow_queries", { order_by: "mean_time" });
    expect(pg.calls.at(-1)?.sql).toMatch(/ORDER BY s\.mean_exec_time DESC/);

    const bad = await h.call("pg_slow_queries", { order_by: "1; DROP TABLE reviews" });
    expect(bad.isError).toBe(true);
  });

  it("caps limit at 20", async () => {
    h = await startHarness({ tools: [pgSlowQueries], pg: fakePg().client });
    expect((await h.call("pg_slow_queries", { limit: 500 })).isError).toBe(true);
  });

  it("explains a missing extension instead of failing opaquely", async () => {
    h = await startHarness({ tools: [pgSlowQueries], pg: fakePg({ extension: false }).client });
    const res = await h.call("pg_slow_queries");
    expect(res.json.error).toBe("unavailable");
  });
});
