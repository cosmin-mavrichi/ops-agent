import type { K3sFixture } from "./k8s-fixture.js";

// Pinned like npm packages: a release at least 7 days old (see pnpm-workspace.yaml minimumReleaseAge).
const CLOUDNATIVE_PG_VERSION = "1.30.1";
const MANIFEST = `https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${CLOUDNATIVE_PG_VERSION}/cnpg-${CLOUDNATIVE_PG_VERSION}.yaml`;
const CRDS = ["clusters", "backups", "scheduledbackups"].map((plural) => `crd/${plural}.postgresql.cnpg.io`);

// The Cluster CRD is larger than the annotation that client-side apply keeps, so apply server-side.
async function applyServerSide(k3s: K3sFixture, yaml: string): Promise<void> {
  const target = "/tmp/cloudnative-pg.yaml";
  await k3s.container.copyContentToContainer([{ content: yaml, target }]);
  await k3s.kubectl("apply", "--server-side", "-f", target);
}

/** Only the CustomResourceDefinitions: the API exists, but no operator fills in status. */
export async function installCloudNativePgCrds(k3s: K3sFixture): Promise<void> {
  const response = await fetch(MANIFEST);
  if (!response.ok) throw new Error(`downloading ${MANIFEST} failed: ${response.status}`);
  const documents = (await response.text()).split(/^---$/m);
  const crds = documents.filter((doc) => /^kind: CustomResourceDefinition$/m.test(doc));
  await applyServerSide(k3s, crds.join("\n---\n"));
  await k3s.waitEstablished(...CRDS);
}

/** The operator too, as a cluster would run it. */
export async function installCloudNativePg(k3s: K3sFixture): Promise<void> {
  await k3s.kubectl("apply", "--server-side", "-f", MANIFEST);
  await k3s.waitEstablished(...CRDS);
  await k3s.kubectl("rollout", "status", "deployment/cnpg-controller-manager", "-n", "cnpg-system", "--timeout=180s");
}
