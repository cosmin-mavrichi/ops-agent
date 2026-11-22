import type { Adapter, ToolDef } from "../types.js";
import { k8sCertificates } from "./k8s/certificates.js";
import { k8sEvents } from "./k8s/events.js";
import { k8sLogs } from "./k8s/logs.js";
import { k8sPods } from "./k8s/pods.js";
import { pgActivity } from "./postgres/activity.js";
import { pgBlocking } from "./postgres/blocking.js";
import { pgSlowQueries } from "./postgres/slow-queries.js";
import { redisHealth } from "./redis/health.js";
import { redisSlowlog } from "./redis/slowlog.js";

/** Single source of truth for the exposed surface. Add new tools here. */
export const allTools: ToolDef<any>[] = [
  pgSlowQueries,
  pgActivity,
  pgBlocking,
  k8sPods,
  k8sEvents,
  k8sLogs,
  k8sCertificates,
  redisHealth,
  redisSlowlog,
];

/** Tools whose adapters are all configured; the rest are not exposed at all. */
export function toolsFor(tools: readonly ToolDef<any>[], configured: readonly Adapter[]): ToolDef<any>[] {
  return tools.filter((tool) => (tool.requires ?? []).every((adapter) => configured.includes(adapter)));
}
