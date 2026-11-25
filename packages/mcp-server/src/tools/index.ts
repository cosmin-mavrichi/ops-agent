import type { Adapter, ToolDef } from "../types.js";
import { k8sCertificates } from "./k8s/certificates.js";
import { k8sChanges } from "./k8s/changes.js";
import { k8sEvents } from "./k8s/events.js";
import { k8sLogs } from "./k8s/logs.js";
import { k8sPgBackups } from "./k8s/pg-backups.js";
import { k8sPods } from "./k8s/pods.js";
import { pgActivity } from "./postgres/activity.js";
import { pgBlocking } from "./postgres/blocking.js";
import { pgChanges } from "./postgres/changes.js";
import { pgJobQueues } from "./postgres/job-queues.js";
import { pgSlowQueries } from "./postgres/slow-queries.js";
import { promHttpHealth } from "./prometheus/http-health.js";
import { promVolumeUsage } from "./prometheus/volume-usage.js";
import { redisHealth } from "./redis/health.js";
import { redisSlowlog } from "./redis/slowlog.js";
import { searchClusterHealth } from "./search/cluster-health.js";
import { searchNodePressure } from "./search/node-pressure.js";
import { opsTriage } from "./triage.js";

/** Single source of truth for the exposed surface. Add new tools here. */
export const allTools: ToolDef<any>[] = [
  opsTriage,
  pgSlowQueries,
  pgActivity,
  pgBlocking,
  pgJobQueues,
  pgChanges,
  k8sPods,
  k8sEvents,
  k8sLogs,
  k8sChanges,
  k8sCertificates,
  k8sPgBackups,
  redisHealth,
  redisSlowlog,
  promVolumeUsage,
  promHttpHealth,
  searchClusterHealth,
  searchNodePressure,
];

/** Tools whose adapters are all configured; the rest are not exposed at all. */
export function toolsFor(tools: readonly ToolDef<any>[], configured: readonly Adapter[]): ToolDef<any>[] {
  return tools.filter((tool) => (tool.requires ?? []).every((adapter) => configured.includes(adapter)));
}
