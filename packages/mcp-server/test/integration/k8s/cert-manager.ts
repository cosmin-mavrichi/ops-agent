import type { K3sFixture } from "./k8s-fixture.js";

// Pinned like npm packages: a release at least 7 days old (see pnpm-workspace.yaml minimumReleaseAge).
const CERT_MANAGER_VERSION = "v1.21.3";
const RELEASE = `https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}`;
const CRDS = ["certificates.cert-manager.io", "issuers.cert-manager.io"].map((crd) => `crd/${crd}`);

/** Only the CustomResourceDefinitions: the API exists, but no controller fills in status. */
export async function installCertManagerCrds(k3s: K3sFixture): Promise<void> {
  await k3s.kubectl("apply", "-f", `${RELEASE}/cert-manager.crds.yaml`);
  await k3s.waitEstablished(...CRDS);
}

/** The whole of cert-manager, controllers included, as a cluster would run it. */
export async function installCertManager(k3s: K3sFixture): Promise<void> {
  await k3s.kubectl("apply", "-f", `${RELEASE}/cert-manager.yaml`);
  await k3s.waitEstablished(...CRDS);
  await k3s.kubectl("wait", "--for=condition=Available", "deployment", "--all", "-n", "cert-manager", "--timeout=180s");
}
