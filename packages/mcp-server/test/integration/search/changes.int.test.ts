import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSearchClient } from "../../../src/adapters/search.js";
import { searchChanges } from "../../../src/tools/search/changes.js";
import { type Harness, startHarness } from "../../harness.js";
import { ADMIN_PW, type Engine, OPS_SEARCH_PW, type SearchFixture, startSearch } from "./search-fixture.js";

const CUSTOMER_EMAIL = "planted.customer.7731@example.com";
const API_TOKEN = "tok_planted_search_changes_5590";

type Change = { kind: string; object: string; at_ago_s: number };

describe.each(["opensearch", "elasticsearch"] as Engine[])("search_changes against %s", (engine) => {
  let search: SearchFixture;
  let h: Harness;
  const outputs: string[] = [];

  beforeAll(async () => {
    search = await startSearch(engine);
    // The change to find: a reindex into a new index, with a document that must never come back.
    await search.admin("PUT", "/products-v2", { settings: { number_of_replicas: 0 } });
    await search.admin("PUT", "/products-v2/_doc/1?refresh=true", { email: CUSTOMER_EMAIL, token: API_TOKEN });
    await search.admin("PUT", "/.hidden-audit", { settings: { number_of_replicas: 0, "index.hidden": true } });
    const client = createSearchClient({ url: search.opsUrl });
    h = await startHarness({ tools: [searchChanges], search: client, knownSecrets: [OPS_SEARCH_PW] });
  }, 240_000);

  afterAll(async () => {
    await h?.close();
    await search?.stop();
  });

  it("shows the node's start and the new index, as ops_ro, newest first", async () => {
    const res = await h.call("search_changes", { since_minutes: 60 });
    outputs.push(res.text);
    expect(res.isError, res.text).toBe(false);
    expect(res.json.nodes).toBe(1);
    const changes: Change[] = res.json.changes;
    const objects = changes.map((change) => change.object);
    expect(objects).toContain("index products-v2");
    // OpenSearch also creates its daily audit log index, which the tool calls routine.
    const auditLog = expect.stringMatching(/^index security-auditlog-/);
    const expectedIndices = engine === "opensearch" ? ["index products-v2", auditLog] : ["index products-v2"];
    expect(objects.filter((object) => object.startsWith("index ")).sort()).toEqual(expectedIndices);
    expect(objects.filter((object) => object.startsWith("index ."))).toEqual([]);
    const agesInOrder = changes.map((change) => change.at_ago_s);
    expect(agesInOrder).toEqual(agesInOrder.toSorted((a, b) => a - b));
    expect(changes.find((change) => change.kind === "node_start")?.at_ago_s).toBeLessThan(600);
  });

  it("never leaks a planted secret", () => {
    expect(outputs).toHaveLength(1);
    for (const secret of [CUSTOMER_EMAIL, API_TOKEN, OPS_SEARCH_PW, ADMIN_PW]) {
      for (const output of outputs) expect(output).not.toContain(secret);
    }
  });
});
