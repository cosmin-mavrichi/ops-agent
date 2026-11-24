import type { ToolList } from "@ops-agent/mcp-server/shared";
import type { WriteContext } from "../types.js";

/** The write server's whole surface. k8s_rollout_restart comes next (docs/v2-design.md, PR 3). */
export const writeTools: ToolList<WriteContext> = [];
