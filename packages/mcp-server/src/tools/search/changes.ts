import { z } from "zod";
import { MINUTE_S } from "../../lib/units.js";
import { defineTool, Level, type SearchClient } from "../../types.js";

const MAX_CHANGES = 50;

export const NODES_PATH = "/_nodes/stats/jvm";
const NODES_QUERY = { filter_path: "nodes.*.name,nodes.*.roles,nodes.*.jvm.uptime_in_millis" };
// `_all` leaves out hidden and system indices; only the one setting comes back.
export const CREATED_PATH = "/_all/_settings/index.creation_date";

interface NodeUptime {
  readonly name?: string;
  readonly roles?: readonly string[];
  readonly jvm?: { readonly uptime_in_millis?: number };
}

export interface NodesUptime {
  readonly nodes?: Readonly<Record<string, NodeUptime>>;
}

/** Index name → its settings; the engines send `creation_date` as a string of epoch milliseconds. */
export type IndicesCreated = Readonly<
  Record<string, { readonly settings?: { readonly index?: { readonly creation_date?: string } } }>
>;

interface SearchChange {
  readonly at_ago_s: number;
  readonly kind: "node_start" | "index_created";
  readonly object: string;
  readonly change: string;
}

// Internal by convention, and not always marked hidden (OpenSearch's .opendistro_security).
const isInternal = (name: string) => name.startsWith(".");
const DAILY_INDEX = /\d{4}[.-]\d{2}[.-]\d{2}$/;
const ROLLOVER_INDEX = /-\d{6}$/;

function indexCreated(name: string): string {
  if (DAILY_INDEX.test(name)) return "dated index created: a new one each day or month is routine";
  if (ROLLOVER_INDEX.test(name)) return "rollover: a new write index, routine when the previous one filled up";
  return "index created";
}

const roleList = (roles: readonly string[] | undefined) => (roles?.length ? roles.join(", ") : "none");

export function nodeStarts(stats: NodesUptime): SearchChange[] {
  return Object.entries(stats.nodes ?? {}).flatMap(([id, node]) => {
    const uptimeMs = node.jvm?.uptime_in_millis;
    if (uptimeMs === undefined) return [];
    return [
      {
        at_ago_s: Math.round(uptimeMs / 1000),
        kind: "node_start",
        object: `node ${node.name ?? id}`,
        change: `node started (a restart, upgrade or new node; roles: ${roleList(node.roles)}): its shards recovered`,
      },
    ];
  });
}

export function indexCreations(indices: IndicesCreated, now: Date): SearchChange[] {
  return Object.entries(indices).flatMap(([name, { settings }]) => {
    const createdMs = Number(settings?.index?.creation_date);
    if (isInternal(name) || !Number.isFinite(createdMs)) return [];
    const agoS = Math.max(0, Math.round((now.getTime() - createdMs) / 1000));
    return [{ at_ago_s: agoS, kind: "index_created", object: `index ${name}`, change: indexCreated(name) }];
  });
}

async function readCluster(search: SearchClient, signal: AbortSignal) {
  const [nodes, indices] = await Promise.all([
    search.getJson<NodesUptime>(NODES_PATH, NODES_QUERY, signal),
    search.getJson<IndicesCreated>(CREATED_PATH, {}, signal),
  ]);
  return { nodes, indices };
}

const newestFirst = (a: SearchChange, b: SearchChange) => a.at_ago_s - b.at_ago_s;

export const searchChanges = defineTool({
  name: "search_changes",
  level: Level.Read,
  requires: ["search"],
  title: "OpenSearch/Elasticsearch: what changed",
  description:
    "What changed in the search cluster (OpenSearch or Elasticsearch), newest first: nodes that started (a " +
    "restart, upgrade or new node; its shards recover meanwhile, so searches can be slow or partial) and indices " +
    "created (a reindex, a new index or a rollover). Most incidents start right after a change: compare " +
    "`at_ago_s` with when the trouble began. A change close in time is a lead, not proof. Hidden and system " +
    "indices are left out; never returns documents or mappings.",
  input: {
    since_minutes: z.number().int().min(1).max(10_080).default(1_440),
  },
  timeoutMs: 8_000,

  async run({ since_minutes }, { search, signal }) {
    const { nodes, indices } = await readCluster(search, signal);
    const windowS = since_minutes * MINUTE_S;
    const all = [...nodeStarts(nodes), ...indexCreations(indices, new Date())];
    const changes = all.filter((change) => change.at_ago_s <= windowS).toSorted(newestFirst);
    const nodeCount = Object.keys(nodes.nodes ?? {}).length;
    return { total: changes.length, nodes: nodeCount, changes: changes.slice(0, MAX_CHANGES) };
  },
});
