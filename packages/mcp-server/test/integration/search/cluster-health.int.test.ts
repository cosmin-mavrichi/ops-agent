import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSearchClient } from "../../../src/adapters/search.js";
import { searchClusterHealth } from "../../../src/tools/search/cluster-health.js";
import { type Harness, startHarness } from "../../harness.js";
import { type Engine, OPS_SEARCH_PW, type SearchFixture, startSearch } from "./search-fixture.js";

const DOCUMENT_SECRET = "planted-search-document-8841";

describe.each(["opensearch", "elasticsearch"] as Engine[])("search_cluster_health against %s", (engine) => {
  let search: SearchFixture;
  let h: Harness;

  beforeAll(async () => {
    search = await startSearch(engine);
    // One replica on one node: the replica cannot be placed, so the cluster is yellow.
    await search.admin("PUT", "/products", { settings: { number_of_shards: 1, number_of_replicas: 1 } });
    await search.admin("PUT", "/products/_doc/1?refresh=true", { name: "lamp", supplier_token: DOCUMENT_SECRET });
    await search.admin("PUT", "/orders", { settings: { number_of_replicas: 0 } });
    await search.admin("PUT", "/orders/_settings", { "index.blocks.read_only_allow_delete": true });
    const client = createSearchClient({ url: search.opsUrl });
    h = await startHarness({ tools: [searchClusterHealth], search: client, knownSecrets: [OPS_SEARCH_PW] });
  }, 240_000);

  afterAll(async () => {
    await h?.close();
    await search?.stop();
  });

  it("reads health, disk, watermarks and blocks as ops_ro", async () => {
    const res = await h.call("search_cluster_health");
    expect(res.isError, res.text).toBe(false);
    expect(res.json.engine).toMatch(engine === "opensearch" ? /^opensearch 3\./ : /^elasticsearch 9\./);
    expect(res.json.status).toBe("yellow");
    expect(res.json.unassigned_example).toMatchObject({ index: "products", primary: false });
    expect(res.json.disk[0].used_pct).toBeLessThan(50);
    expect(res.json.watermarks.flood_stage).toBe("95%");
    expect(res.json.blocked_indices.read_only_allow_delete).toEqual(["orders"]);
    expect(res.json.problems.join("\n")).toContain("1 indices are read-only (read_only_allow_delete)");
  });

  it("never returns documents or the password, and ops_ro cannot read documents itself", async () => {
    const res = await h.call("search_cluster_health");
    expect(res.text).not.toContain(DOCUMENT_SECRET);
    expect(res.text).not.toContain(OPS_SEARCH_PW);

    expect((await search.asOps("GET", "/products/_search")).status).toBe(403);
    expect((await search.asOps("GET", "/products/_doc/1")).status).toBe(403);
    expect((await search.asOps("PUT", "/products/_settings", { "index.blocks.write": true })).status).toBe(403);
  });
});
