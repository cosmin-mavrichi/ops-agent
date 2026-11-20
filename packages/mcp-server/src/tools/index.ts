import type { ToolDef } from "../types.js";
import { pgSlowQueries } from "./postgres.js";

/** Single source of truth for the exposed surface. Add new tools here. */
export const allTools: ToolDef<any>[] = [pgSlowQueries];
