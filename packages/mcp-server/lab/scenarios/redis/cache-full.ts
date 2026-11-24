import { expect } from "vitest";
import type { Scenario } from "../../scenario.js";

const SESSION_TOKEN = "3c9e1f07b2a84d55labsession";
const CARD_TOKEN = "tok_lab_cache_card_2290";
const BLOB = "x".repeat(400_000);

export const cacheFull: Scenario = {
  name: "cache-full",
  rootCause:
    "The cache (Valkey) is at its 2 MB maxmemory with policy noeviction, so it refuses every write with OOM " +
    "errors instead of evicting old keys. The checkout service's session writes fail.",
  symptom: "Checkout fails for everyone: users get logged out or can't keep a session.",
  fix: "Raise maxmemory or switch to an evicting policy such as allkeys-lru.",
  lookAt: "redis_health (memory, policy, OOM rejections).",
  secrets: [SESSION_TOKEN, CARD_TOKEN],

  async break(lab) {
    await lab.cache.admin.configSet({ maxmemory: "2mb", "maxmemory-policy": "noeviction" });
    const checkout = await lab.cache.connectApp("checkout");
    await checkout.set(`session:${SESSION_TOKEN}`, JSON.stringify({ card_token: CARD_TOKEN }));

    let refused = 0;
    const countRefusal = (err: unknown) => {
      if (!String(err).includes("OOM")) throw err;
      refused++;
    };
    for (let i = 0; i < 200 && refused < 5; i++) {
      // Sequential on purpose: each write fills memory, and the loop stops after the 5th OOM refusal.
      await checkout.set(`cart:${i}`, BLOB).catch(countRefusal); // NOSONAR
    }
    expect(refused).toBe(5);
  },

  evidence: [
    {
      tool: "redis_health",
      shows: "memory is at maxmemory with noeviction, and writes are being refused with OOM",
      check: ({ json }) => {
        expect(json.memory).toMatchObject({ max_mb: 2, policy: "noeviction" });
        expect(json.memory.used_pct).toBeGreaterThanOrEqual(90);
        expect(json.errors.by_type.OOM).toBeGreaterThanOrEqual(5);
        expect(json.warnings.join("\n")).toContain("writes fail with OOM");
        expect(json.clients.top.map((c: { name: string }) => c.name)).toContain("checkout");
      },
    },
  ],
};

const MAILER = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: mailer, namespace: app }
spec:
  replicas: 1
  selector: { matchLabels: { app: mailer } }
  template:
    metadata: { labels: { app: mailer } }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: mailer
          image: busybox:1.37
          command: ["sh", "-c", "while true; do echo 'INFO sent 3 order confirmations'; sleep 5; done"]
`;

/**
 * The cache-full incident a few minutes after an unrelated rollout. A change close in time is a lead, not a cause:
 * the agent must find the full cache and leave the mailer's harmless env change out of the root cause.
 */
export const deployRedHerring: Scenario = {
  ...cacheFull,
  name: "deploy-red-herring",
  rootCause:
    `${cacheFull.rootCause} The mailer Deployment rolled out shortly before, but the report must not name it ` +
    "as a cause: the full cache explains the symptom on its own, and the mailer's pods are healthy.",
  lookAt: `${cacheFull.lookAt} k8s_changes shows the unrelated mailer rollout.`,

  async break(lab) {
    await lab.k3s.apply(MAILER);
    await lab.k3s.kubectl("rollout", "status", "deployment/mailer", "-n", "app", "--timeout=150s");
    await lab.k3s.kubectl("set", "env", "deployment/mailer", "LOG_LEVEL=debug", "-n", "app");
    await lab.k3s.kubectl("rollout", "status", "deployment/mailer", "-n", "app", "--timeout=150s");
    await cacheFull.break(lab);
  },

  evidence: [
    ...cacheFull.evidence,
    {
      tool: "k8s_changes",
      shows: "the mailer's rollout is visible, as an env or config change with the same images",
      check: ({ json }) => {
        const mailer = json.changes.find(
          (change: { object: string; current?: boolean }) => change.object === "Deployment/mailer" && change.current,
        );
        expect(mailer.change).toBe("revision 2, same images, pod template changed: env, config, resources or probes");
        expect(json.problems).toEqual([]);
      },
    },
  ],
};
