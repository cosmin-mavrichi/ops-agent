import type { Round } from "@ops-agent/mcp-server/shared";
import type { K8sWriteClient } from "./adapters/k8s-write.js";
import type { Approvals } from "./approval.js";

/** Everything a write tool may touch; tests pass fakes. */
export interface WriteContext {
  readonly k8s: K8sWriteClient;
  readonly approvals: Approvals;
  /** What the client sent back: the answer to the form and the server's own sealed state. */
  readonly round: Round;
  readonly signal: AbortSignal;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}
