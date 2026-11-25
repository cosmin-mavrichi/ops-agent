import { describe, expect, it } from "vitest";
import {
  CREATED_PATH,
  type IndicesCreated,
  indexCreations,
  NODES_PATH,
  type NodesUptime,
  nodeStarts,
  searchChanges,
} from "../../../src/tools/search/changes.js";
import type { QueryParams, SearchClient } from "../../../src/types.js";
import { useHarness } from "../../harness.js";

const harness = useHarness();
const NOW = new Date("2026-11-20T12:00:00Z");
const createdAgo = (seconds: number) => String(NOW.getTime() - seconds * 1000);

const NODES: NodesUptime = {
  nodes: {
    a1: { name: "search-0", roles: ["cluster_manager", "data"], jvm: { uptime_in_millis: 300_400 } },
    b2: { name: "search-1", roles: ["data"], jvm: { uptime_in_millis: 9 * 86_400_000 } },
    c3: { roles: [] },
  },
};

const INDICES: IndicesCreated = {
  "products-v2": { settings: { index: { creation_date: createdAgo(600) } } },
  "products-v1": { settings: { index: { creation_date: createdAgo(40 * 86_400) } } },
  broken: { settings: {} },
  ".kibana_1": { settings: { index: { creation_date: createdAgo(60) } } },
  "logs-2026.11.20": { settings: { index: { creation_date: createdAgo(30) } } },
  "orders-000002": { settings: { index: { creation_date: createdAgo(20) } } },
};

function fakeSearch(replies: Readonly<Record<string, unknown>>) {
  const requests: Array<{ path: string; query?: QueryParams }> = [];
  const client: SearchClient = {
    async getJson<T>(path: string, query?: QueryParams) {
      requests.push({ path, query });
      return replies[path] as T;
    },
  };
  return { client, requests };
}

describe("nodeStarts", () => {
  it("dates each node's start from its JVM uptime, with its roles", () => {
    expect(nodeStarts(NODES)).toEqual([
      {
        at_ago_s: 300,
        kind: "node_start",
        object: "node search-0",
        change: "node started (a restart, upgrade or new node; roles: cluster_manager, data): its shards recovered",
      },
      expect.objectContaining({ at_ago_s: 777_600, object: "node search-1" }),
    ]);
  });
});

describe("indexCreations", () => {
  it("dates each index from its creation_date, skipping internal ones and one without a date", () => {
    expect(indexCreations(INDICES, NOW)).toEqual([
      { at_ago_s: 600, kind: "index_created", object: "index products-v2", change: "index created" },
      expect.objectContaining({ at_ago_s: 3_456_000, object: "index products-v1" }),
      expect.objectContaining({ object: "index logs-2026.11.20" }),
      expect.objectContaining({ object: "index orders-000002" }),
    ]);
  });

  it("calls dated and rollover indices routine", () => {
    const changeOf = (name: string) => indexCreations(INDICES, NOW).find((change) => change.object === name)?.change;
    expect(changeOf("index logs-2026.11.20")).toBe("dated index created: a new one each day or month is routine");
    expect(changeOf("index orders-000002")).toBe(
      "rollover: a new write index, routine when the previous one filled up",
    );
  });
});

describe("search_changes (unit)", () => {
  it("reads only node uptimes and creation dates, and keeps the window newest first", async () => {
    const createdMinutesAgo = (minutes: number) => String(Date.now() - minutes * 60_000);
    const indices: IndicesCreated = {
      "products-v2": { settings: { index: { creation_date: createdMinutesAgo(10) } } },
      "products-v1": { settings: { index: { creation_date: createdMinutesAgo(120) } } },
    };
    const search = fakeSearch({ [NODES_PATH]: NODES, [CREATED_PATH]: indices });
    const h = await harness({ tools: [searchChanges], search: search.client });

    const res = await h.call("search_changes", { since_minutes: 60 });
    expect(res.isError, res.text).toBe(false);
    expect(search.requests.map((request) => request.path).sort()).toEqual([CREATED_PATH, NODES_PATH]);
    expect(res.json).toMatchObject({ total: 2, nodes: 3 });
    expect(res.json.changes.map((change: { object: string }) => change.object)).toEqual([
      "node search-0",
      "index products-v2",
    ]);
  });
});
