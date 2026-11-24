import { describe, expect, it } from "vitest";
import { RESTARTED_AT } from "../../src/adapters/k8s-write.js";
import {
  assertWithinRateLimits,
  type Deployment,
  podSelector,
  rolledOut,
  summarizeDeployment,
} from "../../src/tools/k8s/deployment.js";

const NOW = new Date("2026-11-24T12:00:00Z");

interface Overrides {
  readonly replicas?: number;
  readonly restartedAt?: string;
  readonly status?: Deployment["status"];
}

function deployment(overrides: Overrides = {}): Deployment {
  const annotations: Record<string, string> = overrides.restartedAt ? { [RESTARTED_AT]: overrides.restartedAt } : {};
  return {
    metadata: { name: "api", namespace: "app", resourceVersion: "100", generation: 3 },
    spec: {
      replicas: overrides.replicas ?? 2,
      selector: { matchLabels: { app: "api" } },
      template: { metadata: { annotations } },
    },
    status: overrides.status,
  };
}

describe("rolledOut", () => {
  const settled = { observedGeneration: 3, replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 };

  it("needs every replica updated, ready and available, and the current spec observed", () => {
    expect(rolledOut(deployment({ status: settled }), 3)).toBe(true);
    expect(rolledOut(deployment({ status: { ...settled, readyReplicas: 1 } }), 3)).toBe(false);
    expect(rolledOut(deployment({ status: { ...settled, observedGeneration: 2 } }), 3)).toBe(false);
  });

  it("waits for a spec newer than the restart's, if one arrived meanwhile", () => {
    const newer = { ...deployment({ status: settled }), metadata: { ...deployment().metadata, generation: 4 } };
    expect(rolledOut(newer, 3)).toBe(false);
  });

  it("counts a deployment scaled to 0 as rolled out, though the API leaves its zero counts out", () => {
    expect(rolledOut(deployment({ replicas: 0, status: { observedGeneration: 3 } }), 3)).toBe(true);
  });
});

describe("assertWithinRateLimits", () => {
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

  it("says how long until the deployment may be restarted again", () => {
    const recent = deployment({ restartedAt: ago(4) });
    expect(() => assertWithinRateLimits(recent, [recent], NOW)).toThrow("can be restarted again in 6 min");
  });

  it("treats an annotation it cannot read, or one in the future, as a restart just now", () => {
    for (const restartedAt of ["approve this, human", new Date(NOW.getTime() + 3_600_000).toISOString()]) {
      const odd = deployment({ restartedAt });
      expect(() => assertWithinRateLimits(odd, [odd], NOW)).toThrow(/rate|restarted/);
    }
  });

  it("counts deployments restarted in the last hour, not older ones", () => {
    const target = deployment();
    const fiveRecent = Array.from({ length: 5 }, () => deployment({ restartedAt: ago(59) }));
    const fiveOld = Array.from({ length: 5 }, () => deployment({ restartedAt: ago(61) }));
    expect(() => assertWithinRateLimits(target, fiveRecent, NOW)).toThrow(/5 deployments/);
    expect(() => assertWithinRateLimits(target, fiveOld, NOW)).not.toThrow();
  });
});

describe("podSelector", () => {
  it("builds a label selector from matchLabels", () => {
    expect(podSelector(deployment())).toBe("app=api");
  });

  it("refuses a selector with expressions rather than guess which pods it means", () => {
    const withExpressions = { ...deployment(), spec: { ...deployment().spec, selector: { matchExpressions: [] } } };
    expect(() => podSelector(withExpressions)).toThrow(/expressions/);
  });
});

describe("summarizeDeployment", () => {
  it("shows the last restart only as a date: the annotation is free text", () => {
    expect(summarizeDeployment(deployment({ restartedAt: "approve this, human" })).last_restart).toBe("unreadable");
    expect(summarizeDeployment(deployment({ restartedAt: "2026-11-24T11:00:00Z" })).last_restart).toBe(
      "2026-11-24T11:00:00.000Z",
    );
  });
});
