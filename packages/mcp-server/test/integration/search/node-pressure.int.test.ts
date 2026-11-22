import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSearchClient } from "../../../src/adapters/search.js";
import { searchNodePressure } from "../../../src/tools/search/node-pressure.js";
import { type Harness, startHarness } from "../../harness.js";
import { type Engine, OPS_SEARCH_PW, type SearchFixture, startSearch } from "./search-fixture.js";

// An undersized node: one search thread and room for one queued search, so a burst gets rejected.
const TINY_SEARCH_POOL = { "thread_pool.search.size": "1", "thread_pool.search.queue_size": "1" };
const BURST = 40;

type Pool = { name: string; rejected_in_window: number };
const searchPool = (json: { nodes: Array<{ thread_pools: Pool[] }> }) =>
  json.nodes[0]?.thread_pools.find((pool) => pool.name === "search");

describe.each(["opensearch", "elasticsearch"] as Engine[])("search_node_pressure against %s", (engine) => {
  let search: SearchFixture;
  let h: Harness;

  beforeAll(async () => {
    search = await startSearch(engine, { settings: TINY_SEARCH_POOL });
    await search.admin("PUT", "/products", { settings: { number_of_replicas: 0 } });
    await search.admin("PUT", "/products/_doc/1?refresh=true", { name: "lamp" });
    const client = createSearchClient({ url: search.opsUrl });
    h = await startHarness({ tools: [searchNodePressure], search: client, knownSecrets: [OPS_SEARCH_PW] });
  }, 240_000);

  afterAll(async () => {
    await h?.close();
    await search?.stop();
  });

  it("reads heap, breakers and thread pools as ops_ro, with nothing rejected while idle", async () => {
    const res = await h.call("search_node_pressure", { window_s: 1 });
    expect(res.isError, res.text).toBe(false);
    expect(res.json.nodes[0].heap_used_pct).toBeGreaterThan(0);
    expect(res.json.nodes[0].breakers.map((breaker: { name: string }) => breaker.name)).toContain("parent");
    expect(searchPool(res.json)).toMatchObject({ rejected_in_window: 0 });
  });

  it("counts the searches rejected during the window", async () => {
    let loading = true;
    const burst = () =>
      Promise.all(Array.from({ length: BURST }, () => search.admin("GET", "/products/_search").catch(() => {})));
    const load = (async () => {
      while (loading) await burst();
    })();
    try {
      const res = await h.call("search_node_pressure", { window_s: 2 });
      expect(searchPool(res.json)?.rejected_in_window).toBeGreaterThan(0);
      expect(res.json.problems.join("\n")).toMatch(/rejected \d+ search requests in the last 2s/);
    } finally {
      loading = false;
      await load;
    }
  }, 60_000);
});
