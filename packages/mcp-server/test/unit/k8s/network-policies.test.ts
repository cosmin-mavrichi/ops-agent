import { describe, expect, it } from "vitest";
import { describePolicy, type NetworkPolicy, policyChange } from "../../../src/tools/k8s/network-policies.js";
import { ago, NOW } from "./fake-k8s.js";

const policy = (spec: NetworkPolicy["spec"], metadata: Partial<NetworkPolicy["metadata"]> = {}): NetworkPolicy => ({
  metadata: { name: "lockdown", namespace: "app", creationTimestamp: ago(600), ...metadata },
  spec,
});

describe("describePolicy", () => {
  it("names the pods it selects and who may reach them on which ports", () => {
    const onlyWeb = policy({
      podSelector: { matchLabels: { app: "pricing" } },
      policyTypes: ["Ingress"],
      ingress: [{ from: [{ podSelector: { matchLabels: { app: "web" } } }], ports: [{ port: 8080 }] }],
    });
    expect(describePolicy(onlyWeb)).toBe("app=pricing: ingress allowed only from pods app=web on TCP 8080");
  });

  it("says when a direction is denied outright, for every pod", () => {
    const denyAll = policy({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
    expect(describePolicy(denyAll)).toBe("every pod in the namespace: all ingress denied; all egress denied");
  });

  it("restricts egress without policyTypes only when it has egress rules", () => {
    const egress = policy({
      podSelector: { matchLabels: { app: "worker" } },
      egress: [
        {
          to: [{ ipBlock: { cidr: "10.0.0.0/8", except: ["10.0.5.0/24"] } }],
          ports: [{ protocol: "TCP", port: 5432 }],
        },
      ],
    });
    expect(describePolicy(egress)).toBe(
      "app=worker: all ingress denied; egress allowed only to 10.0.0.0/8 except 10.0.5.0/24 on TCP 5432",
    );
  });

  it("describes namespace selectors, label expressions and rules open to anyone", () => {
    const mixed = policy({
      podSelector: { matchExpressions: [{ key: "tier", operator: "In", values: ["db"] }] },
      policyTypes: ["Ingress"],
      ingress: [{ from: [{ podSelector: {}, namespaceSelector: { matchLabels: { team: "data" } } }] }, {}],
    });
    expect(describePolicy(mixed)).toBe(
      "1 label expression: ingress allowed only from pods (any) in namespaces team=data; from anywhere",
    );
  });
  it("names the first rules of a long allowlist and counts the rest", () => {
    const fromPort = (port: number) => ({ ports: [{ port }] });
    const long = policy({ podSelector: {}, policyTypes: ["Ingress"], ingress: [1, 2, 3, 4, 5, 6, 7].map(fromPort) });
    expect(describePolicy(long)).toMatch(/from anywhere on TCP 5; and 2 more rules$/);
  });
});

describe("policyChange", () => {
  it("dates a policy by its last write and tells a change from a creation", () => {
    const edited = policy({ podSelector: {} }, { managedFields: [{ time: ago(600) }, { time: ago(120) }] });
    expect(policyChange(edited)).toMatchObject({ at: NOW.getTime() - 120_000, name: "lockdown" });
    expect(policyChange(edited).change).toMatch(/^changed; now applies to every pod/);

    const created = policy({ podSelector: {} }, { managedFields: [{ time: ago(598) }] });
    expect(policyChange(created)).toMatchObject({ at: NOW.getTime() - 598_000 });
    expect(policyChange(created).change).toMatch(/^created; /);
  });
});
