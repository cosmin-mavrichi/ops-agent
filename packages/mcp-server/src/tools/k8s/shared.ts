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

export const nsPath = (namespace: string) => `/api/v1/namespaces/${encodeURIComponent(namespace)}`;

const MAX_MESSAGE = 300;

/** Cluster and application messages can be long; the model only needs the gist. */
export const clip = (text: string | undefined) => (text ? text.slice(0, MAX_MESSAGE) : undefined);

export function secondsSince(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const elapsedMs = now.getTime() - Date.parse(iso);
  return Math.max(0, Math.round(elapsedMs / 1000));
}
