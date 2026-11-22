import type { K3sFixture } from "../test/integration/k8s/k8s-fixture.js";
import { type PromFixture, startPrometheus } from "../test/integration/prometheus/prom-fixture.js";

// What a cluster's monitoring stack holds: kubelet metrics access for Prometheus. The ops agent never gets
// it (nodes/metrics sits next to nodes/proxy); it only queries Prometheus.
const PROMETHEUS_RBAC = `
apiVersion: v1
kind: Namespace
metadata: { name: monitoring }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: prometheus, namespace: monitoring }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: prometheus-kubelet }
rules: [{ apiGroups: [""], resources: [nodes/metrics], verbs: [get] }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: prometheus-kubelet }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: prometheus-kubelet }
subjects: [{ kind: ServiceAccount, name: prometheus, namespace: monitoring }]
`;

const KUBELET_PORT = 10250;

export interface Monitoring {
  readonly prometheus: PromFixture;
  /** Prometheus's ServiceAccount token, for leak checks. */
  readonly token: string;
}

/** Prometheus outside the cluster, scraping the k3s node's kubelet as a ServiceAccount. */
export async function startMonitoring(k3s: K3sFixture): Promise<Monitoring> {
  await k3s.apply(PROMETHEUS_RBAC);
  const token = await k3s.kubectl("create", "token", "prometheus", "-n", "monitoring", "--duration=2h");
  const node = `${k3s.container.getIpAddress("bridge")}:${KUBELET_PORT}`;

  const prometheus = await startPrometheus(`  - job_name: kubelet
    scheme: https
    # k3s signs the kubelet's serving certificate with its own CA, for the node's name.
    tls_config: { insecure_skip_verify: true }
    authorization: { credentials: ${JSON.stringify(token)} }
    static_configs: [{ targets: [${JSON.stringify(node)}] }]`);
  return { prometheus, token };
}
