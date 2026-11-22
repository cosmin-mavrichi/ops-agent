import { z } from "zod";
import { type K8sClient, ToolError } from "../../types.js";

/** RFC 1123 label (namespaces, container names) and subdomain (pod names); safe to put in a URL path. */
export const k8sLabel = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "must be a Kubernetes name (lowercase letters, digits, '-')");
export const k8sSubdomain = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, "must be a Kubernetes name (lowercase letters, digits, '-', '.')");

/** Requested namespace if allowed, otherwise every allowed one. Never asks the API about others. */
export function allowedNamespaces(k8s: K8sClient, requested: string | undefined): readonly string[] {
  if (requested === undefined) return k8s.namespaces;
  if (!k8s.namespaces.includes(requested)) {
    throw new ToolError(
      "forbidden_namespace",
      `namespace "${requested}" is not inspectable; allowed: ${k8s.namespaces.join(", ") || "none"}`,
    );
  }
  return [requested];
}

/** Throws forbidden_namespace unless `namespace` is in the allowlist. */
export function assertNamespaceAllowed(k8s: K8sClient, namespace: string): void {
  allowedNamespaces(k8s, namespace);
}

export const nsPath = (namespace: string) => `/api/v1/namespaces/${encodeURIComponent(namespace)}`;

const MAX_MESSAGE = 300;

/** Cluster and application messages can be long; the model only needs the gist. */
export const clip = (text: string | undefined) => (text ? text.slice(0, MAX_MESSAGE) : undefined);

export function secondsSince(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const elapsedMs = now.getTime() - Date.parse(iso);
  return Math.max(0, Math.round(elapsedMs / 1000));
}

export const HOUR_S = 3_600;
export const DAY_S = 24 * HOUR_S;

export const toDays = (seconds: number) => Math.round((seconds / DAY_S) * 10) / 10;
const toHours = (seconds: number) => Math.round((seconds / HOUR_S) * 10) / 10;

/** Under a day in hours: something an hour away is not "0 days" away. */
export const describeSpan = (seconds: number) =>
  seconds >= DAY_S ? `${toDays(seconds)} days` : `${toHours(seconds)} hours`;

/** A status condition, as Kubernetes operators report them. */
export interface Condition {
  readonly type?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly message?: string;
}

export const conditionOf = (conditions: readonly Condition[] | undefined, type: string) =>
  conditions?.find((condition) => condition.type === type);

/** A namespaced custom resource collection, e.g. ("cert-manager.io/v1", "app", "certificates"). */
export const customResourcePath = (groupVersion: string, namespace: string, plural: string) =>
  `/apis/${groupVersion}/namespaces/${encodeURIComponent(namespace)}/${plural}`;

/** A 404 on an operator's API means the operator is not installed; says that instead of "not found". */
export function whenNotInstalled(message: string) {
  return (err: unknown): never => {
    if (err instanceof ToolError && err.code === "not_found") throw new ToolError("unavailable", message);
    throw err;
  };
}
