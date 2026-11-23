import { expect } from "vitest";
import { ADMIN_PW } from "../../../test/integration/search/search-fixture.js";
import { type Lab, type Scenario, until } from "../../scenario.js";

const DOCUMENT_SECRET = "lab-supplier-token-2093";
const DATA_PATH = "/usr/share/opensearch/data";
const DATA_MB = 256;
const FILL_TO_PCT = 97;

/** The app: indexes a product every few seconds and logs OpenSearch's answer when it fails. */
const indexer = (searchUrl: string) => `
apiVersion: v1
kind: Pod
metadata: { name: catalog-indexer, namespace: app }
spec:
  containers:
    - name: indexer
      image: curlimages/curl:8.23.0
      env:
        - { name: SEARCH_URL, value: "${searchUrl}" }
        - { name: SEARCH_AUTH, value: "admin:${ADMIN_PW}" }
      command:
        - sh
        - -c
        - |
          while true; do
            out=$(curl -s -u "$SEARCH_AUTH" -H 'Content-Type: application/json' -d '{"sku":"lamp-2"}' "$SEARCH_URL/products/_doc")
            case "$out" in
              *'"result":"created"'*) echo "indexed product" ;;
              *) echo "indexing failed: $out" ;;
            esac
            sleep 3
          done
`;

/** Fills the engine's data filesystem with a junk file, the way logs or a stray dump fill a real one. */
async function fillDataDisk(lab: Lab): Promise<void> {
  const container = lab.search?.container;
  if (!container) throw new Error("this scenario needs the lab's search engine");
  const df = await container.exec(["df", "-m", "--output=avail,size", DATA_PATH]);
  const [avail, size] = (df.output.trim().split("\n").at(-1) ?? "").trim().split(/\s+/).map(Number);
  if (!avail || !size) throw new Error(`unexpected df output: ${df.output}`);
  const fillMb = Math.floor(avail - size * (1 - FILL_TO_PCT / 100));
  await container.exec(["dd", "if=/dev/zero", `of=${DATA_PATH}/stray-dump.bin`, "bs=1M", `count=${fillMb}`]);
}

type BlockedJson = { blocked_indices: Record<string, string[]> };
const readOnlyIndices = (json: BlockedJson) => json.blocked_indices.read_only_allow_delete ?? [];

export const searchDiskFull: Scenario = {
  name: "search-disk-full",
  rootCause:
    "The OpenSearch node's data disk is 97% full, past the flood-stage watermark (95%): OpenSearch made the " +
    "products index read-only, so catalog-indexer's writes fail with cluster_block_exception.",
  symptom: "New products don't show up in search, and the catalog indexer is logging errors.",
  fix: "Free up or add disk on the OpenSearch node; the read-only block lifts once disk use falls below the high watermark.",
  lookAt: "search_cluster_health and the catalog-indexer logs.",
  secrets: [ADMIN_PW, DOCUMENT_SECRET],
  search: { engine: "opensearch", dataMb: DATA_MB },

  async break(lab) {
    const search = lab.search;
    if (!search) throw new Error("this scenario needs the lab's search engine");
    await search.admin("PUT", "/products", { settings: { number_of_replicas: 0 } });
    await search.admin("PUT", "/products/_doc/1?refresh=true", { sku: "lamp-1", supplier_token: DOCUMENT_SECRET });
    // OpenSearch checks disk use every 30s by default; 10s is the minimum it accepts.
    await search.admin("PUT", "/_cluster/settings", { persistent: { "cluster.info.update.interval": "10s" } });

    const searchUrl = `http://${search.container.getIpAddress("bridge")}:9200`;
    await lab.k3s.apply(indexer(searchUrl));
    await lab.k3s.kubectl("wait", "pod/catalog-indexer", "-n", "app", "--for=condition=Ready", "--timeout=150s");
    await fillDataDisk(lab);
    await until("OpenSearch to make products read-only", async () => {
      const { json } = await lab.call("search_cluster_health");
      expect(readOnlyIndices(json)).toContain("products");
    });
  },

  evidence: [
    {
      tool: "search_cluster_health",
      shows: "the node is past the flood-stage watermark and products is read-only",
      check: ({ json }) => {
        const problems = json.problems.join("\n");
        expect(problems).toMatch(/disk 9\d(\.\d)?% used, .* past the flood_stage watermark \(95%\)/);
        expect(readOnlyIndices(json)).toContain("products");
      },
    },
    {
      tool: "k8s_logs",
      args: { namespace: "app", pod: "catalog-indexer", tail_lines: 10 },
      shows: "the indexer's writes are refused because of the flood-stage watermark",
      check: ({ json }) => {
        expect(json.lines.join("\n")).toMatch(/indexing failed: .*cluster_block_exception.*flood-stage watermark/);
      },
    },
  ],
};
