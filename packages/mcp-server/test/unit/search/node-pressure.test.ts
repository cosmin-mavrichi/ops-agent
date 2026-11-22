import { describe, expect, it } from "vitest";
import { type NodesStats, searchNodePressure, summarizeNode } from "../../../src/tools/search/node-pressure.js";
import type { SearchClient } from "../../../src/types.js";
import { useHarness } from "../../harness.js";

const harness = useHarness();
const GIB = 1024 ** 3;

/** One node under search overload: before and after a 1s window. */
const node = (search: { rejected: number; queue: number }, tripped: number, oldGcMs: number, heap: number) => ({
  name: "search-0",
  jvm: {
    mem: { heap_used_percent: heap, heap_max_in_bytes: GIB },
    gc: { collectors: { old: { collection_time_in_millis: oldGcMs } } },
  },
  breakers: {
    parent: { limit_size_in_bytes: 0.95 * GIB, estimated_size_in_bytes: 0.9 * GIB, tripped },
    fielddata: { limit_size_in_bytes: 0.4 * GIB, estimated_size_in_bytes: 0, tripped: 0 },
  },
  thread_pool: {
    search: { threads: 1, active: 1, queue: search.queue, rejected: search.rejected },
    write: { threads: 2, active: 0, queue: 0, rejected: 7 },
    get: { threads: 2, active: 0, queue: 0, rejected: 0 },
    snapshot: { threads: 1, active: 0, queue: 0, rejected: 0 },
  },
});

const BEFORE: NodesStats = { nodes: { n1: node({ rejected: 1_000, queue: 1 }, 4, 10_000, 90) } };
const AFTER: NodesStats = { nodes: { n1: node({ rejected: 1_042, queue: 1 }, 6, 10_400, 91) } };

/** Answers each request with the next snapshot, the way two samples a window apart would arrive. */
function fakeSearch(snapshots: readonly NodesStats[]) {
  const paths: string[] = [];
  const client: SearchClient = {
    async getJson<T>(path: string) {
      paths.push(path);
      const next = snapshots[Math.min(paths.length - 1, snapshots.length - 1)];
      return next as T;
    },
  };
  return { client, paths };
}

describe("summarizeNode", () => {
  const summary = summarizeNode("n1", BEFORE.nodes?.n1, AFTER.nodes?.n1 ?? {}, 1);

  it("counts only what happened between the two samples", () => {
    const search = summary.thread_pools.find((pool) => pool.name === "search");
    expect(search).toMatchObject({ rejected_in_window: 42, rejected_total: 1_042 });
    const write = summary.thread_pools.find((pool) => pool.name === "write");
    expect(write).toMatchObject({ rejected_in_window: 0, rejected_total: 7 });
    expect(summary.breakers.find((breaker) => breaker.name === "parent")?.tripped_in_window).toBe(2);
  });

  it("hides quiet pools other than search, write and get", () => {
    expect(summary.thread_pools.map((pool) => pool.name)).toEqual(["search", "write", "get"]);
  });

  it("explains heap, GC, rejections and the tripped breaker; not old rejections", () => {
    expect(summary.problems).toEqual([
      "node search-0 heap 91% used: long garbage collection pauses and tripped breakers follow",
      "node search-0 spent 40% of the last 1s in old-generation GC",
      "node search-0 rejected 42 search requests in the last 1s (1 threads, 1 queued): it cannot keep up with searches",
      "node search-0 parent circuit breaker tripped 2 times in the last 1s (921.6 MiB of 972.8 MiB): requests " +
        "are refused so the heap does not run out",
    ]);
  });

  it("has nothing to say about a quiet node", () => {
    const quiet = node({ rejected: 5, queue: 0 }, 0, 100, 40);
    expect(summarizeNode("n1", quiet, quiet, 1).problems).toEqual([]);
  });
});

describe("search_node_pressure (unit)", () => {
  it("samples twice, a window apart", async () => {
    const search = fakeSearch([BEFORE, AFTER]);
    const h = await harness({ tools: [searchNodePressure], search: search.client });
    const res = await h.call("search_node_pressure", { window_s: 1 });
    expect(res.isError, res.text).toBe(false);
    expect(search.paths).toEqual(["/_nodes/stats/jvm,breaker,thread_pool", "/_nodes/stats/jvm,breaker,thread_pool"]);
    expect(res.json.problems).toHaveLength(4);
  });
});
