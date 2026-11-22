import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { formatBytes } from "../../lib/units.js";
import { defineTool, Level, type SearchClient } from "../../types.js";

const HEAP_WARNING_PCT = 85;
const GC_WARNING_SHARE = 0.3;
/** Always shown: the pools behind searches and indexing. Others only when they queue or reject. */
const MAIN_POOLS: ReadonlySet<string> = new Set(["search", "write", "get"]);

interface Breaker {
  readonly limit_size_in_bytes?: number;
  readonly estimated_size_in_bytes?: number;
  readonly tripped?: number;
}

interface ThreadPool {
  readonly threads?: number;
  readonly queue?: number;
  readonly active?: number;
  readonly rejected?: number;
}

interface NodeStats {
  readonly name?: string;
  readonly jvm?: {
    readonly mem?: { readonly heap_used_percent?: number; readonly heap_max_in_bytes?: number };
    readonly gc?: { readonly collectors?: Readonly<Record<string, { readonly collection_time_in_millis?: number }>> };
  };
  readonly breakers?: Readonly<Record<string, Breaker>>;
  readonly thread_pool?: Readonly<Record<string, ThreadPool>>;
}

export interface NodesStats {
  readonly nodes?: Readonly<Record<string, NodeStats>>;
}

const STATS_PATH = "/_nodes/stats/jvm,breaker,thread_pool";
const STATS_QUERY = {
  filter_path: [
    "nodes.*.name",
    "nodes.*.jvm.mem.heap_used_percent",
    "nodes.*.jvm.mem.heap_max_in_bytes",
    "nodes.*.jvm.gc.collectors.old.collection_time_in_millis",
    "nodes.*.breakers",
    "nodes.*.thread_pool.*.threads",
    "nodes.*.thread_pool.*.queue",
    "nodes.*.thread_pool.*.active",
    "nodes.*.thread_pool.*.rejected",
  ].join(","),
};

const counterDelta = (before: number | undefined, after: number | undefined) =>
  Math.max(0, (after ?? 0) - (before ?? 0));

function poolsOf(before: NodeStats | undefined, after: NodeStats) {
  return Object.entries(after.thread_pool ?? {}).flatMap(([name, pool]) => {
    const rejectedInWindow = counterDelta(before?.thread_pool?.[name]?.rejected, pool.rejected);
    const busy = (pool.queue ?? 0) > 0 || rejectedInWindow > 0;
    if (!MAIN_POOLS.has(name) && !busy) return [];
    return [
      {
        name,
        threads: pool.threads ?? 0,
        active: pool.active ?? 0,
        queue: pool.queue ?? 0,
        rejected_in_window: rejectedInWindow,
        rejected_total: pool.rejected ?? 0,
      },
    ];
  });
}

function breakersOf(before: NodeStats | undefined, after: NodeStats) {
  return Object.entries(after.breakers ?? {}).map(([name, breaker]) => ({
    name,
    limit_bytes: breaker.limit_size_in_bytes ?? 0,
    estimated_bytes: breaker.estimated_size_in_bytes ?? 0,
    tripped_in_window: counterDelta(before?.breakers?.[name]?.tripped, breaker.tripped),
    tripped_total: breaker.tripped ?? 0,
  }));
}

type Pool = ReturnType<typeof poolsOf>[number];
type BreakerState = ReturnType<typeof breakersOf>[number];

const POOL_LOAD: Readonly<Record<string, string>> = { search: "searches", write: "indexing", get: "document gets" };

interface Measured {
  readonly node: string;
  readonly heapPct: number;
  readonly gcShare: number;
  readonly pools: readonly Pool[];
  readonly breakers: readonly BreakerState[];
}

function problemsOf({ node, heapPct, gcShare, pools, breakers }: Measured, windowS: number): string[] {
  const problems: string[] = [];
  if (heapPct >= HEAP_WARNING_PCT) {
    problems.push(`node ${node} heap ${heapPct}% used: long garbage collection pauses and tripped breakers follow`);
  }
  if (gcShare >= GC_WARNING_SHARE) {
    problems.push(`node ${node} spent ${Math.round(gcShare * 100)}% of the last ${windowS}s in old-generation GC`);
  }
  for (const pool of pools.filter((candidate) => candidate.rejected_in_window > 0)) {
    const load = POOL_LOAD[pool.name] ?? `${pool.name} work`;
    problems.push(
      `node ${node} rejected ${pool.rejected_in_window} ${pool.name} requests in the last ${windowS}s ` +
        `(${pool.threads} threads, ${pool.queue} queued): it cannot keep up with ${load}`,
    );
  }
  for (const breaker of breakers.filter((candidate) => candidate.tripped_in_window > 0)) {
    const usage = `${formatBytes(breaker.estimated_bytes)} of ${formatBytes(breaker.limit_bytes)}`;
    problems.push(
      `node ${node} ${breaker.name} circuit breaker tripped ${breaker.tripped_in_window} times in the last ` +
        `${windowS}s (${usage}): requests are refused so the heap does not run out`,
    );
  }
  return problems;
}

/** One node's state now, with what changed since the first sample. */
export function summarizeNode(id: string, before: NodeStats | undefined, after: NodeStats, windowS: number) {
  const node = after.name ?? id;
  const heapPct = after.jvm?.mem?.heap_used_percent ?? 0;
  const oldGcMs = counterDelta(
    before?.jvm?.gc?.collectors?.old?.collection_time_in_millis,
    after.jvm?.gc?.collectors?.old?.collection_time_in_millis,
  );
  const measured: Measured = {
    node,
    heapPct,
    gcShare: oldGcMs / (windowS * 1000),
    pools: poolsOf(before, after),
    breakers: breakersOf(before, after),
  };
  return {
    node,
    heap_used_pct: heapPct,
    heap_max_bytes: after.jvm?.mem?.heap_max_in_bytes ?? 0,
    old_gc_ms_in_window: oldGcMs,
    thread_pools: measured.pools,
    breakers: measured.breakers,
    problems: problemsOf(measured, windowS),
  };
}

async function sampleTwice(search: SearchClient, windowS: number, signal: AbortSignal) {
  const before = await search.getJson<NodesStats>(STATS_PATH, STATS_QUERY, signal);
  await sleep(windowS * 1000, undefined, { signal });
  const after = await search.getJson<NodesStats>(STATS_PATH, STATS_QUERY, signal);
  return { before, after };
}

export const searchNodePressure = defineTool({
  name: "search_node_pressure",
  level: Level.Read,
  requires: ["search"],
  title: "Search: OpenSearch/Elasticsearch node pressure",
  description:
    "Load on each OpenSearch or Elasticsearch node, sampled twice a few seconds apart: JVM heap, old-generation " +
    "GC time, thread pool queues and rejections (search, write, get), and circuit breakers that tripped. " +
    "Counters are cumulative since a node started, so problems only count what happened between the two " +
    "samples. Use it when searches or indexing are slow or fail with 429, es_rejected_execution_exception or " +
    "circuit_breaking_exception.",
  input: {
    window_s: z.number().int().min(1).max(5).default(3),
  },
  timeoutMs: 9_000,

  async run({ window_s }, { search, signal }) {
    const { before, after } = await sampleTwice(search, window_s, signal);
    const nodes = Object.entries(after.nodes ?? {}).map(([id, stats]) =>
      summarizeNode(id, before.nodes?.[id], stats, window_s),
    );
    return { window_s, nodes, problems: nodes.flatMap((node) => node.problems) };
  },
});
