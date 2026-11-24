import type { ToolList } from "@ops-agent/mcp-server/shared";
import type { WriteContext } from "../types.js";
import { rolloutRestart } from "./k8s/rollout-restart.js";

/** The write server's whole surface. */
export const writeTools: ToolList<WriteContext> = [rolloutRestart];
