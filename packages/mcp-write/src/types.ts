import type { Redactor, Round } from "@ops-agent/mcp-server/shared";
import type { K8sWriteClient } from "./adapters/k8s-write.js";
import type { Approvals } from "./approval.js";
import type { Exclusive } from "./exclusive.js";
import type { RolloutTiming } from "./tools/k8s/rollout-check.js";

/** Everything a write tool may touch; tests pass fakes. */
export interface WriteContext {
  readonly k8s: K8sWriteClient;
  readonly approvals: Approvals;
  /**
   * One per process, like `approvals`: a check and the action it allows run together, so two approvals running
   * side by side cannot both pass a limit that only one of them fits under.
   */
  readonly exclusive: Exclusive;
  /** What the client sent back: the answer to the form and the server's own sealed state. */
  readonly round: Round;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  /** How long a restart's post-check waits; tests shrink it. */
  readonly rollout: RolloutTiming;
  /** For text a tool logs itself (the reason, an error): the registry redacts only what it returns and audits. */
  readonly redact: Redactor;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}
