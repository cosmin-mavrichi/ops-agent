import { describe, expect, it } from "vitest";
import { blockProblems, searchClusterHealth } from "../../../src/tools/search/cluster-health.js";
import type { SearchClient } from "../../../src/types.js";
import { useHarness } from "../../harness.js";

const harness = useHarness();
const GIB = 1024 ** 3;

/** One full node of a red OpenSearch cluster whose flood stage blocked two indices. */
const FULL_CLUSTER: Record<string, unknown> = {
  "/": { version: { distribution: "opensearch", number: "3.9.0" } },
  "/_cluster/health": {
    status: "red",
    number_of_nodes: 1,
    number_of_data_nodes: 1,
    active_primary_shards: 4,
    active_shards: 4,
    relocating_shards: 0,
    initializing_shards: 0,
    unassigned_shards: 1,
    delayed_unassigned_shards: 0,
    number_of_pending_tasks: 0,
  },
  "/_cat/allocation": [
    {
      node: "search-0",
      shards: "4",
      "disk.used": String(9.7 * GIB),
      "disk.avail": String(0.3 * GIB),
      "disk.total": String(10 * GIB),
    },
    { node: "UNASSIGNED", shards: "1", "disk.used": null, "disk.avail": null, "disk.total": null },
  ],
  "/_cluster/settings": {
    defaults: {
      cluster: {
        routing: {
          allocation: {
            disk: { watermark: { low: "85%", high: "90%", flood_stage: "95%", enable_for_single_data_node: "false" } },
          },
        },
      },
    },
  },
  "/_all/_settings/index.blocks.*": {
    products: { settings: { "index.blocks.read_only_allow_delete": "true" } },
    orders: { settings: { "index.blocks.read_only_allow_delete": "true" } },
    archive: { settings: { "index.blocks.write": "true" } },
  },
  "/_cluster/allocation/explain": {
    index: "logs-2026.11.22",
    shard: 0,
    primary: true,
    unassigned_info: { reason: "INDEX_CREATED", at: "2026-11-22T10:00:00Z" },
    allocate_explanation: "cannot allocate because allocation is not permitted to any of the nodes",
    node_allocation_decisions: [
      {
        node_name: "search-0",
        deciders: [
          { decider: "disk_threshold", decision: "NO", explanation: "the node is above the high watermark" },
          { decider: "same_shard", decision: "YES", explanation: "fine" },
        ],
      },
    ],
  },
};

/** Fake cluster answering by path; records every path and query it was asked for. */
function fakeSearch(answers: Record<string, unknown>) {
  const calls: Array<{ path: string; query: unknown }> = [];
  const client: SearchClient = {
    async getJson<T>(path: string, query?: unknown) {
      calls.push({ path, query });
      if (!(path in answers)) throw new Error(`no fake answer for ${path}`);
      return answers[path] as T;
    },
  };
  return { client, calls };
}

describe("search_cluster_health (unit)", () => {
  it("explains a red cluster: unassigned primary, full disk, read-only indices", async () => {
    const h = await harness({ tools: [searchClusterHealth], search: fakeSearch(FULL_CLUSTER).client });
    const res = await h.call("search_cluster_health");
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({
      engine: "opensearch 3.9.0",
      status: "red",
      disk: [{ node: "search-0", used_pct: 97 }],
      watermarks: { flood_stage: "95%" },
      unassigned_example: {
        index: "logs-2026.11.22",
        primary: true,
        blocking_deciders: [{ decider: "disk_threshold", explanation: "the node is above the high watermark" }],
      },
    });
    expect(res.json.problems).toEqual([
      "status red: some primary shards are unassigned; their data cannot be searched and writes to it fail",
      "node search-0 disk 97% used, 307.2 MiB free: past the flood_stage watermark (95%); indices with a shard on it are made read-only",
      "2 indices are read-only (read_only_allow_delete) and reject writes: products, orders. The flood-stage " +
        "watermark sets this block, and it is lifted once disk use falls below the high watermark",
      "1 indices block writes (read_only or write block, set by hand or a policy): archive",
    ]);
  });

  it("does not ask for an allocation explanation when every shard is assigned", async () => {
    const health = { ...(FULL_CLUSTER["/_cluster/health"] as object), status: "green", unassigned_shards: 0 };
    const search = fakeSearch({ ...FULL_CLUSTER, "/_cluster/health": health });
    const h = await harness({ tools: [searchClusterHealth], search: search.client });
    const res = await h.call("search_cluster_health");
    expect(res.json.unassigned_example).toBeNull();
    expect(search.calls.map((call) => call.path)).not.toContain("/_cluster/allocation/explain");
  });

  it("still answers when the shard got assigned before the explanation was asked for", async () => {
    const search = fakeSearch(FULL_CLUSTER);
    const explainFails: SearchClient = {
      getJson: (path, query, signal) =>
        path === "/_cluster/allocation/explain"
          ? Promise.reject(new Error("search returned 400"))
          : search.client.getJson(path, query, signal),
    };
    const h = await harness({ tools: [searchClusterHealth], search: explainFails });
    const res = await h.call("search_cluster_health");
    expect(res.isError, res.text).toBe(false);
    expect(res.json.unassigned_example).toBeNull();
  });
});

describe("blockProblems", () => {
  it("names the application's indices before the engine's system ones", () => {
    const problem = blockProblems({
      read_only_allow_delete: [".opendistro_security", ".plugins-ml-config", "products"],
    });
    expect(problem[0]).toContain(": products, .opendistro_security, .plugins-ml-config.");
  });

  it("names at most ten indices", () => {
    const many = Array.from({ length: 12 }, (_, i) => `logs-${i}`);
    expect(blockProblems({ read_only_allow_delete: many })[0]).toContain("logs-9 and 2 more");
  });
});
