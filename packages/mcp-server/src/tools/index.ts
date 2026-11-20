import type { Adapter, ToolDef } from "../types.js";
import { k8sEvents, k8sPods } from "./k8s.js";
import { k8sLogs } from "./k8s-logs.js";
import { pgActivity, pgBlocking } from "./pg-sessions.js";
import { pgSlowQueries } from "./postgres.js";

/** Single source of truth for the exposed surface. Add new tools here. */
export const allTools: ToolDef<any>[] = [pgSlowQueries, pgActivity, pgBlocking, k8sPods, k8sEvents, k8sLogs];

/** Tools whose adapters are all configured; the rest are not exposed at all. */
export function toolsFor(tools: readonly ToolDef<any>[], configured: readonly Adapter[]): ToolDef<any>[] {
  return tools.filter((tool) => (tool.requires ?? []).every((adapter) => configured.includes(adapter)));
}
