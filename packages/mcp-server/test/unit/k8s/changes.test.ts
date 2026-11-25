import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { k8sChanges } from "../../../src/tools/k8s/changes.js";
import { describeChange, imageDrift, type ReplicaSet, rolloutsOf } from "../../../src/tools/k8s/rollouts.js";
import { useHarness } from "../../harness.js";
import { ago, fakeK8s, NOW } from "./fake-k8s.js";

const ENV_SECRET = "planted-template-env-5531";

interface Revision {
  readonly revision: number;
  readonly image: string;
  readonly createdAgoS: number;
  readonly env?: string;
  readonly annotations?: Record<string, string>;
  readonly history?: string;
}

/** A ReplicaSet as the API returns it whole: env in the template, the manifest in last-applied-configuration. */
function replicaSet(deployment: string, revision: Revision): ReplicaSet {
  const historyAnnotation: Record<string, string> = revision.history
    ? { "deployment.kubernetes.io/revision-history": revision.history }
    : {};
  const raw = {
    metadata: {
      name: `${deployment}-${revision.revision}abc`,
      namespace: "app",
      creationTimestamp: ago(revision.createdAgoS),
      annotations: {
        "deployment.kubernetes.io/revision": String(revision.revision),
        "kubectl.kubernetes.io/last-applied-configuration": `{"env":"${ENV_SECRET}"}`,
        ...historyAnnotation,
      },
      ownerReferences: [{ kind: "Deployment", name: deployment }],
    },
    spec: {
      template: {
        metadata: {
          // Like the deployment controller, which gives each revision's template its own hash.
          labels: { app: deployment, "pod-template-hash": `${revision.revision}abc` },
          annotations: revision.annotations ?? {},
        },
        spec: {
          containers: [
            {
              name: deployment,
              image: revision.image,
              command: ["serve", `--token=${ENV_SECRET}`],
              env: [{ name: "DB_PASSWORD", value: revision.env ?? ENV_SECRET }],
            },
          ],
        },
      },
    },
  };
  return raw;
}

const v1 = { revision: 1, image: "shop/api:1.4.0", createdAgoS: 7_200 };

describe("describeChange", () => {
  it("names the image that changed", () => {
    const after = replicaSet("api", { ...v1, revision: 2, image: "shop/api:1.5.0" });
    expect(describeChange(replicaSet("api", v1), after)).toBe("image api: shop/api:1.4.0 → shop/api:1.5.0");
  });

  it("tells a plain restart from a template change", () => {
    const restarted = replicaSet("api", {
      ...v1,
      revision: 2,
      annotations: { "kubectl.kubernetes.io/restartedAt": "now" },
    });
    expect(describeChange(replicaSet("api", v1), restarted)).toBe(
      "restart (kubectl rollout restart): nothing else changed",
    );
  });

  it("says the template changed without saying what env now holds", () => {
    const changedEnv = replicaSet("api", { ...v1, env: "another-value" });
    const change = describeChange(replicaSet("api", v1), changedEnv);
    expect(change).toBe("same images, pod template changed: env, config, resources or probes");
  });

  it("names a changed config checksum annotation, but not its value", () => {
    const before = replicaSet("api", { ...v1, annotations: { "checksum/config": "aaa" } });
    const after = replicaSet("api", { ...v1, annotations: { "checksum/config": "bbb" } });
    expect(describeChange(before, after)).toBe("same images, config changed (checksum/config)");
  });
});

describe("rolloutsOf", () => {
  it("orders each deployment's revisions, marks the current one and spots a rollback", () => {
    const sets = [
      replicaSet("api", { ...v1, revision: 3, history: "1" }),
      replicaSet("api", { revision: 2, image: "shop/api:1.5.0", createdAgoS: 600 }),
      replicaSet("worker", { revision: 1, image: "shop/worker:2.0.0", createdAgoS: 60 }),
    ];
    const rollouts = rolloutsOf(sets);
    expect(
      rollouts.map(({ deployment, revision, kind, current }) => ({ deployment, revision, kind, current })),
    ).toEqual([
      { deployment: "api", revision: 2, kind: "rollout", current: false },
      { deployment: "api", revision: 3, kind: "rollback", current: true },
      { deployment: "worker", revision: 1, kind: "rollout", current: true },
    ]);
    expect(rollouts[1]?.change).toBe("image api: shop/api:1.5.0 → shop/api:1.4.0");
  });
});

describe("rolloutsOf, ReplicaSets it cannot place", () => {
  it("skips ReplicaSets without a deployment or a revision number", () => {
    const owned = replicaSet("api", v1);
    const unowned = { ...owned, metadata: { ...owned.metadata, ownerReferences: [] } };
    const unnumbered = { ...owned, metadata: { ...owned.metadata, annotations: {} } };
    expect(rolloutsOf([unowned, unnumbered])).toEqual([]);
    expect(rolloutsOf([owned, unnumbered]).map((rollout) => rollout.revision)).toEqual([1]);
  });
});

const pod = (name: string, imageId: string) => ({
  metadata: { name, namespace: "app", ownerReferences: [{ kind: "ReplicaSet", name: "api-1abc" }] },
  status: { containerStatuses: [{ name: "api", image: "shop/api:latest", imageID: `shop/api@sha256:${imageId}` }] },
});

describe("imageDrift", () => {
  it("finds pods of one ReplicaSet running different builds of the same tag", () => {
    const pods = [pod("api-a", "1111aaaa2222bbbb"), pod("api-b", "3333cccc4444dddd"), pod("api-c", "1111aaaa2222bbbb")];
    expect(imageDrift(pods)).toEqual([
      {
        namespace: "app",
        replicaSet: "api-1abc",
        container: "api",
        image: "shop/api:latest",
        digests: ["sha256:1111aaaa2222", "sha256:3333cccc4444"],
      },
    ]);
    expect(imageDrift([pod("api-a", "1111aaaa2222bbbb"), pod("api-b", "1111aaaa2222bbbb")])).toEqual([]);
  });
});

const job = (name: string, status: Record<string, unknown>) => ({
  metadata: { name, namespace: "app", ownerReferences: [{ kind: "CronJob", name: "nightly" }] },
  spec: { template: { spec: { containers: [{ name: "migrate", env: [{ name: "DB_URL", value: ENV_SECRET }] }] } } },
  status,
});

const harness = useHarness();

describe("k8s_changes (unit)", () => {
  // Only Date: the harness's own timers must keep running.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cluster = () =>
    fakeK8s(
      {
        "/replicasets": {
          items: [
            replicaSet("api", { ...v1, createdAgoS: 200_000 }),
            replicaSet("api", { revision: 2, image: "shop/api:1.5.0", createdAgoS: 300 }),
          ],
        },
        "/jobs": {
          items: [
            job("migrate-42", {
              startTime: ago(400),
              conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "app output" }],
            }),
            job("report-41", { startTime: ago(3_600), completionTime: ago(3_540) }),
            job("report-40", { startTime: ago(200_000), completionTime: ago(199_000) }),
          ],
        },
        "/pods": { items: [pod("api-a", "1111aaaa2222bbbb"), pod("api-b", "3333cccc4444dddd")] },
      },
      ["app"],
    );

  it("lists the changes in the window, newest first, with failed Jobs and mixed builds as problems", async () => {
    const h = await harness({ tools: [k8sChanges], k8s: cluster().client });
    const { json } = await h.call("k8s_changes");
    expect(json.changes).toEqual([
      expect.objectContaining({ kind: "image_drift", at_ago_s: null, object: "ReplicaSet/api-1abc" }),
      {
        at_ago_s: 300,
        kind: "rollout",
        namespace: "app",
        object: "Deployment/api",
        change: "revision 2, image api: shop/api:1.4.0 → shop/api:1.5.0",
        current: true,
      },
      expect.objectContaining({
        at_ago_s: 400,
        object: "Job/migrate-42",
        change: "failed (BackoffLimitExceeded) (from CronJob/nightly)",
      }),
      expect.objectContaining({
        at_ago_s: 3_600,
        object: "Job/report-41",
        change: "succeeded in 1 minute (from CronJob/nightly)",
      }),
    ]);
    expect(json.problems).toEqual([
      "app/Job/migrate-42: failed (BackoffLimitExceeded) (from CronJob/nightly)",
      expect.stringMatching(/^app\/ReplicaSet\/api-1abc: container api runs 2 builds of shop\/api:latest/),
    ]);
  });

  it("shows a current rollback, undated and said to be, however long ago it happened", async () => {
    const k8s = fakeK8s(
      {
        "/replicasets": {
          items: [
            replicaSet("api", { revision: 2, image: "shop/api:1.5.0", createdAgoS: 900_000 }),
            replicaSet("api", { ...v1, revision: 3, createdAgoS: 1_000_000, history: "1" }),
          ],
        },
      },
      ["app"],
    );
    const h = await harness({ tools: [k8sChanges], k8s: k8s.client });
    const { json } = await h.call("k8s_changes");
    expect(json.changes).toEqual([
      {
        at_ago_s: null,
        kind: "rollback",
        namespace: "app",
        object: "Deployment/api",
        change:
          "revision 3, rolled back at an unknown time to an earlier template: image api: shop/api:1.5.0 → shop/api:1.4.0",
        current: true,
      },
    ]);
  });

  it("says a Job is still running, and leaves out one that never started", async () => {
    const k8s = fakeK8s(
      { "/jobs": { items: [job("migrate-43", { startTime: ago(60), active: 1 }), job("migrate-44", { active: 0 })] } },
      ["app"],
    );
    const h = await harness({ tools: [k8sChanges], k8s: k8s.client });
    const { json } = await h.call("k8s_changes");
    expect(json.changes).toEqual([
      expect.objectContaining({ object: "Job/migrate-43", change: "running for 1 minute (from CronJob/nightly)" }),
    ]);
    expect(json.problems).toEqual([]);
  });

  it("lists NetworkPolicies written in the window, with what they now allow", async () => {
    const lockdown = (name: string, createdAgoS: number) => ({
      metadata: { name, namespace: "app", creationTimestamp: ago(createdAgoS) },
      spec: { podSelector: { matchLabels: { app: "pricing" } }, policyTypes: ["Ingress"] },
    });
    const k8s = fakeK8s({ "/networkpolicies": { items: [lockdown("new", 240), lockdown("old", 200_000)] } }, ["app"]);
    const h = await harness({ tools: [k8sChanges], k8s: k8s.client });
    const { json } = await h.call("k8s_changes");
    expect(json.changes).toEqual([
      {
        at_ago_s: 240,
        kind: "network_policy",
        namespace: "app",
        object: "NetworkPolicy/new",
        change: "created; now applies to app=pricing: all ingress denied",
      },
    ]);
    expect(json.problems).toEqual([]);
    expect(k8s.calls.map((call) => call.path)).toContain("/apis/networking.k8s.io/v1/namespaces/app/networkpolicies");
  });

  it("never returns template env, commands, annotations or Job messages", async () => {
    const h = await harness({ tools: [k8sChanges], k8s: cluster().client });
    const { text } = await h.call("k8s_changes", { since_minutes: 10_080 });
    expect(text).toContain("Deployment/api");
    expect(text).not.toContain(ENV_SECRET);
    expect(text).not.toContain("app output");
  });

  it("refuses a namespace outside the allowlist before asking the API", async () => {
    const k8s = cluster();
    const h = await harness({ tools: [k8sChanges], k8s: k8s.client });
    const result = await h.call("k8s_changes", { namespace: "kube-system" });
    expect(result).toMatchObject({ isError: true, json: { error: "forbidden_namespace" } });
    expect(k8s.calls).toEqual([]);
  });
});
