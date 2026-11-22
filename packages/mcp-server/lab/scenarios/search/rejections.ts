import { expect } from "vitest";
import { ADMIN_PW } from "../../../test/integration/search/search-fixture.js";
import { type Scenario, until } from "../../scenario.js";

const DOCUMENT_SECRET = "lab-pricing-key-7146";

/** The app: bursts of 20 concurrent searches, logging OpenSearch's answer for each one that fails. */
const storefront = (searchUrl: string) => `
apiVersion: v1
kind: Pod
metadata: { name: storefront, namespace: app }
spec:
  containers:
    - name: web
      image: curlimages/curl:8.23.0
      env:
        - { name: SEARCH_URL, value: "${searchUrl}" }
        - { name: SEARCH_AUTH, value: "admin:${ADMIN_PW}" }
      command:
        - sh
        - -c
        - |
          search() {
            out=$(curl -s -u "$SEARCH_AUTH" "$SEARCH_URL/products/_search?q=lamp")
            case "$out" in
              *'"hits"'*) ;;
              *) echo "search failed: $out" ;;
            esac
          }
          while true; do
            for i in $(seq 1 20); do search & done
            wait
          done
`;

type PoolJson = { nodes: Array<{ thread_pools: Array<{ name: string; rejected_in_window: number }> }> };
const rejectedInWindow = (json: PoolJson) =>
  json.nodes[0]?.thread_pools.find((pool) => pool.name === "search")?.rejected_in_window ?? 0;

export const searchRejections: Scenario = {
  name: "search-rejections",
  rootCause:
    "The OpenSearch node is undersized for the storefront's search load (one search thread, a one-slot queue): " +
    "it rejects searches with 429 rejected_execution_exception, so storefront searches fail.",
  secrets: [ADMIN_PW, DOCUMENT_SECRET],
  // Stands in for a node too small for its traffic: the same rejections, without generating that much load.
  search: { engine: "opensearch", settings: { "thread_pool.search.size": "1", "thread_pool.search.queue_size": "1" } },

  async break(lab) {
    const search = lab.search;
    if (!search) throw new Error("this scenario needs the lab's search engine");
    await search.admin("PUT", "/products", { settings: { number_of_replicas: 0 } });
    await search.admin("PUT", "/products/_doc/1?refresh=true", { name: "lamp", pricing_key: DOCUMENT_SECRET });

    const searchUrl = `http://${search.container.getIpAddress("bridge")}:9200`;
    await lab.k3s.apply(storefront(searchUrl));
    await lab.k3s.kubectl("wait", "pod/storefront", "-n", "app", "--for=condition=Ready", "--timeout=150s");
    await until("OpenSearch to reject searches", async () => {
      const { json } = await lab.call("search_node_pressure", { window_s: 2 });
      expect(rejectedInWindow(json)).toBeGreaterThan(0);
    });
  },

  evidence: [
    {
      tool: "search_node_pressure",
      shows: "the node is rejecting search requests right now",
      check: ({ json }) => {
        expect(rejectedInWindow(json)).toBeGreaterThan(0);
        expect(json.problems.join("\n")).toMatch(/rejected \d+ search requests .*cannot keep up with searches/);
      },
    },
    {
      tool: "k8s_logs",
      args: { namespace: "app", pod: "storefront", tail_lines: 20 },
      shows: "the storefront's searches fail with rejected_execution_exception",
      check: ({ json }) => {
        expect(json.lines.join("\n")).toMatch(/search failed: .*rejected_execution_exception/);
      },
    },
  ],
};
