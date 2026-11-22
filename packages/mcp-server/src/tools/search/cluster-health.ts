import { formatBytes } from "../../lib/units.js";
import { defineTool, Level, type SearchClient } from "../../types.js";
import {
  type ClusterSettings,
  type Disk,
  isPast,
  type Watermark,
  type WatermarkLevel,
  watermarksFrom,
} from "./watermarks.js";

const MAX_TEXT = 300;
const MAX_DECIDERS = 5;
const clip = (text: string | undefined) => text?.slice(0, MAX_TEXT);

interface Root {
  readonly version?: { readonly distribution?: string; readonly number?: string };
}

interface Health {
  readonly status: "green" | "yellow" | "red";
  readonly number_of_nodes: number;
  readonly number_of_data_nodes: number;
  readonly active_primary_shards: number;
  readonly active_shards: number;
  readonly relocating_shards: number;
  readonly initializing_shards: number;
  readonly unassigned_shards: number;
  /** Elasticsearch only. */
  readonly unassigned_primary_shards?: number;
  readonly delayed_unassigned_shards: number;
  readonly number_of_pending_tasks: number;
}

/** A row of _cat/allocation?bytes=b; the UNASSIGNED row has nulls. */
interface AllocationRow {
  readonly node: string;
  readonly shards: string | null;
  readonly "disk.used": string | null;
  readonly "disk.avail": string | null;
  readonly "disk.total": string | null;
}

interface Explain {
  readonly index?: string;
  readonly shard?: number;
  readonly primary?: boolean;
  readonly unassigned_info?: { readonly reason?: string; readonly at?: string; readonly details?: string };
  readonly allocate_explanation?: string;
  readonly node_allocation_decisions?: ReadonlyArray<{
    readonly node_name?: string;
    readonly deciders?: ReadonlyArray<{
      readonly decider?: string;
      readonly decision?: string;
      readonly explanation?: string;
    }>;
  }>;
}

type IndexBlocks = Readonly<Record<string, { readonly settings?: Readonly<Record<string, string>> }>>;

export interface NodeDisk extends Disk {
  readonly node: string;
  readonly usedPct: number;
  readonly shards: number;
}

export function disksFrom(rows: readonly AllocationRow[]): NodeDisk[] {
  return rows.flatMap((row) => {
    const total = Number(row["disk.total"]);
    const free = Number(row["disk.avail"]);
    if (row.node === "UNASSIGNED" || !total || Number.isNaN(free)) return [];
    const usedPct = Math.round(((total - free) / total) * 1000) / 10;
    return [{ node: row.node, totalBytes: total, freeBytes: free, usedPct, shards: Number(row.shards ?? 0) }];
  });
}

const DISK_EFFECTS: Readonly<Record<WatermarkLevel, string>> = {
  flood_stage: "indices with a shard on it are made read-only",
  high: "shards are moved off it and no new ones are placed on it",
  low: "no new replica shards are placed on it",
};

/** The highest watermark a node is past, worded with its effect. */
export function diskProblem(disk: NodeDisk, watermarks: readonly Watermark[]): string | undefined {
  const past = watermarks.find((watermark) => isPast(watermark, disk));
  if (past === undefined) return undefined;
  const usage = `${disk.usedPct}% used, ${formatBytes(disk.freeBytes)} free`;
  return `node ${disk.node} disk ${usage}: past the ${past.level} watermark (${past.value}); ${DISK_EFFECTS[past.level]}`;
}

/** Indices with each block set, e.g. { read_only_allow_delete: ["products"] }. */
export function blockedIndices(settings: IndexBlocks): Record<string, string[]> {
  const blocked: Record<string, string[]> = {};
  for (const [index, { settings: values = {} }] of Object.entries(settings)) {
    for (const [key, value] of Object.entries(values)) {
      if (value !== "true") continue;
      const block = key.replace("index.blocks.", "");
      blocked[block] = [...(blocked[block] ?? []), index];
    }
  }
  return blocked;
}

const MAX_NAMED = 10;
const isSystemIndex = (name: string) => name.startsWith(".");
const applicationIndicesFirst = (a: string, b: string) => Number(isSystemIndex(a)) - Number(isSystemIndex(b));

/** Up to ten names, the application's own indices before the engine's dot-prefixed system ones. */
function nameSome(names: readonly string[]): string {
  const ordered = names.toSorted(applicationIndicesFirst);
  if (ordered.length <= MAX_NAMED) return ordered.join(", ");
  return `${ordered.slice(0, MAX_NAMED).join(", ")} and ${ordered.length - MAX_NAMED} more`;
}

export function healthProblems(health: Health): string[] {
  if (health.status === "red") {
    const count = health.unassigned_primary_shards ?? "some";
    return [`status red: ${count} primary shards are unassigned; their data cannot be searched and writes to it fail`];
  }
  if (health.status !== "yellow") return [];
  const hint = health.number_of_data_nodes === 1 ? " (one data node cannot hold a replica of its own shards)" : "";
  return [
    `status yellow: ${health.unassigned_shards} replica shards are unassigned, so there is no copy to fail over to${hint}`,
  ];
}

export function blockProblems(blocked: Readonly<Record<string, string[]>>): string[] {
  const problems: string[] = [];
  const floodBlocked = blocked.read_only_allow_delete ?? [];
  if (floodBlocked.length > 0) {
    problems.push(
      `${floodBlocked.length} indices are read-only (read_only_allow_delete) and reject writes: ` +
        `${nameSome(floodBlocked)}. The flood-stage watermark sets this block, and it is lifted once disk use ` +
        "falls below the high watermark",
    );
  }
  const manual = [...new Set([...(blocked.read_only ?? []), ...(blocked.write ?? [])])];
  if (manual.length > 0) {
    problems.push(
      `${manual.length} indices block writes (read_only or write block, set by hand or a policy): ${nameSome(manual)}`,
    );
  }
  return problems;
}

function summarizeExplain(explain: Explain) {
  const deciders = (explain.node_allocation_decisions ?? []).flatMap((node) =>
    (node.deciders ?? [])
      .filter((decider) => decider.decision === "NO")
      .map((decider) => ({ node: node.node_name, decider: decider.decider, explanation: clip(decider.explanation) })),
  );
  return {
    index: explain.index,
    shard: explain.shard,
    primary: explain.primary,
    reason: explain.unassigned_info?.reason,
    since: explain.unassigned_info?.at,
    details: clip(explain.unassigned_info?.details),
    explanation: clip(explain.allocate_explanation),
    blocking_deciders: deciders.slice(0, MAX_DECIDERS),
  };
}

async function explainUnassigned(search: SearchClient, signal: AbortSignal) {
  // Answers 400 when nothing is unassigned any more (the shard was assigned meanwhile).
  return search.getJson<Explain>("/_cluster/allocation/explain", {}, signal).then(summarizeExplain, () => null);
}

const WATERMARK_QUERY = { include_defaults: true, filter_path: "*.cluster.routing.allocation.disk.watermark*" };
const BLOCKS_QUERY = { flat_settings: true, expand_wildcards: "all" };

export const searchClusterHealth = defineTool({
  name: "search_cluster_health",
  level: Level.Read,
  requires: ["search"],
  title: "Search: OpenSearch/Elasticsearch cluster health",
  description:
    "Health of the OpenSearch or Elasticsearch cluster: status, shard counts, why a shard is unassigned " +
    "(allocation explain), disk use per node against the disk watermarks, and indices made read-only. " +
    "Use it when searches fail or return partial results, indexing fails (cluster_block_exception, " +
    "'disk usage exceeded flood-stage watermark'), or the cluster is yellow or red. Never reads documents.",
  input: {},
  timeoutMs: 8_000,

  async run(_args, { search, signal }) {
    const [root, health, allocation, settings, blocks] = await Promise.all([
      search.getJson<Root>("/", {}, signal),
      search.getJson<Health>("/_cluster/health", {}, signal),
      search.getJson<AllocationRow[]>("/_cat/allocation", { format: "json", bytes: "b" }, signal),
      search.getJson<ClusterSettings>("/_cluster/settings", WATERMARK_QUERY, signal),
      search.getJson<IndexBlocks>("/_all/_settings/index.blocks.*", BLOCKS_QUERY, signal),
    ]);
    const unassigned = health.unassigned_shards > 0 ? await explainUnassigned(search, signal) : null;
    const watermarks = watermarksFrom(settings, health.number_of_data_nodes);
    const disks = disksFrom(allocation);
    const blocked = blockedIndices(blocks);
    const diskProblems = disks.flatMap((disk) => diskProblem(disk, watermarks) ?? []);

    return {
      engine: `${root.version?.distribution ?? "elasticsearch"} ${root.version?.number ?? "?"}`,
      status: health.status,
      nodes: health.number_of_nodes,
      data_nodes: health.number_of_data_nodes,
      shards: {
        active_primary: health.active_primary_shards,
        active: health.active_shards,
        relocating: health.relocating_shards,
        initializing: health.initializing_shards,
        unassigned: health.unassigned_shards,
        delayed_unassigned: health.delayed_unassigned_shards,
      },
      pending_tasks: health.number_of_pending_tasks,
      unassigned_example: unassigned,
      disk: disks.map((disk) => ({
        node: disk.node,
        used_pct: disk.usedPct,
        free_bytes: disk.freeBytes,
        shards: disk.shards,
      })),
      watermarks: Object.fromEntries(watermarks.map((watermark) => [watermark.level, watermark.value])),
      blocked_indices: blocked,
      problems: [...healthProblems(health), ...diskProblems, ...blockProblems(blocked)],
    };
  },
});
