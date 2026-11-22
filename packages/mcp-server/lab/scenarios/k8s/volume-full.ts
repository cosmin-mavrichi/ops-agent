import { expect } from "vitest";
import type { Volume } from "../../../src/tools/prometheus/volume-usage.js";
import { type Lab, type Scenario, until } from "../../scenario.js";

const STORAGE_KEY = "lab-uploads-storage-key-3307";
// A filesystem with a real size: kubelet reports a volume's usage from its filesystem, so the claim's
// nominal size alone would not do. The local PersistentVolume below points at it.
const NODE_PATH = "/mnt/uploads";
const SIZE_MIB = 64;
const FILLED_MIB = 61;

const volumeManifest = (node: string) => `
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: local }
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
---
apiVersion: v1
kind: PersistentVolume
metadata: { name: uploads-pv }
spec:
  capacity: { storage: ${SIZE_MIB}Mi }
  accessModes: [ReadWriteOnce]
  storageClassName: local
  local: { path: ${NODE_PATH} }
  nodeAffinity:
    required:
      nodeSelectorTerms: [{ matchExpressions: [{ key: kubernetes.io/hostname, operator: In, values: [${node}] }] }]
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: uploads, namespace: app }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local
  resources: { requests: { storage: ${SIZE_MIB}Mi } }
---
apiVersion: v1
kind: Pod
metadata: { name: uploads-api, namespace: app }
spec:
  containers:
    - name: api
      image: busybox:1.37
      env: [{ name: STORAGE_KEY, value: ${STORAGE_KEY} }]
      volumeMounts: [{ name: uploads, mountPath: /data }]
      command:
        - sh
        - -c
        - >-
          dd if=/dev/zero of=/data/archive bs=1M count=${FILLED_MIB} 2>/dev/null;
          echo "uploads-api ready";
          while true; do
            dd if=/dev/zero of=/data/incoming.part bs=1M count=8 2>&1 | grep -i "space" | sed 's/^/upload failed: /';
            rm -f /data/incoming.part; sleep 5;
          done
  volumes: [{ name: uploads, persistentVolumeClaim: { claimName: uploads } }]
`;

async function mountSizedFilesystem(lab: Lab): Promise<string> {
  const mount = `mkdir -p ${NODE_PATH} && mount -t tmpfs -o size=${SIZE_MIB}m tmpfs ${NODE_PATH}`;
  const result = await lab.k3s.container.exec(["sh", "-c", mount]);
  if (result.exitCode !== 0) throw new Error(`mounting ${NODE_PATH} on the node failed: ${result.output}`);
  return lab.k3s.kubectl("get", "nodes", "-o", "jsonpath={.items[0].metadata.name}");
}

const findUploads = (json: { volumes: readonly Volume[] }) => json.volumes.find((volume) => volume.pvc === "uploads");

export const volumeFull: Scenario = {
  name: "volume-full",
  rootCause:
    "The uploads PersistentVolumeClaim in app is 95% full: uploads-api can no longer write incoming " +
    "files (No space left on device).",
  secrets: [STORAGE_KEY],

  async break(lab) {
    const node = await mountSizedFilesystem(lab);
    await lab.k3s.apply(volumeManifest(node));
    await lab.k3s.kubectl("wait", "pod/uploads-api", "-n", "app", "--for=condition=Ready", "--timeout=150s");
    // The kubelet computes volume usage about once a minute, then Prometheus scrapes it.
    await until("Prometheus to see the full volume", async () => {
      const { json } = await lab.call("prom_volume_usage", { namespace: "app" });
      expect(findUploads(json)?.used_pct).toBeGreaterThanOrEqual(90);
    });
  },

  evidence: [
    {
      tool: "prom_volume_usage",
      args: { namespace: "app" },
      shows: "the uploads volume is nearly full",
      check: ({ json }) => {
        const uploads = findUploads(json);
        expect(uploads?.problems.join("\n")).toMatch(/^9\d(\.\d)?% full \(/);
      },
    },
    {
      tool: "k8s_logs",
      args: { namespace: "app", pod: "uploads-api", tail_lines: 20 },
      shows: "writes fail with no space left on device",
      check: ({ json }) => {
        expect(json.lines.join("\n")).toMatch(/upload failed: .*No space left on device/i);
      },
    },
  ],
};
