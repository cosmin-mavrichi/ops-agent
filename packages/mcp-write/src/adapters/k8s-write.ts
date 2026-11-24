import { apiMessage, buildUrl, httpGet, httpPatch, type QueryParams, ToolError } from "@ops-agent/mcp-server/shared";

export interface K8sWriteConfig {
  /** API server base URL. */
  readonly server: string;
  /** PEM CA bundle that signed the API server certificate. */
  readonly ca: string;
  /** Called per request: the session token may be replaced while the server runs. */
  readonly token: () => string;
  readonly namespaces: readonly string[];
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export type PatchMode = "dry_run" | "apply";

export interface DeploymentRestart {
  readonly namespace: string;
  readonly name: string;
  /** From the read the approval was based on: the API server refuses the patch (409) if it changed since. */
  readonly resourceVersion: string;
  /** ISO timestamp for the restartedAt annotation, as `kubectl rollout restart` sets it. */
  readonly restartedAt: string;
  readonly mode: PatchMode;
}

/**
 * The write server's Kubernetes client. It sends GET only to deployments and pods in its namespaces, and one
 * PATCH, the restart annotation, whose body it builds itself: no caller can send any other change.
 */
export interface K8sWriteClient {
  readonly namespaces: readonly string[];
  getJson<T>(path: string, signal?: AbortSignal, query?: QueryParams): Promise<T>;
  restartDeployment<T>(restart: DeploymentRestart, signal?: AbortSignal): Promise<T>;
}

export const RESTARTED_AT = "kubectl.kubernetes.io/restartedAt";
const FIELD_MANAGER = "ops-write";
const NAME = "[a-z0-9]([-a-z0-9]*[a-z0-9])?";
const PLAIN_NAME = new RegExp(`^${NAME}$`);
const READABLE = [
  new RegExp(`^/apis/apps/v1/namespaces/(${NAME})/deployments(/${NAME})?$`),
  new RegExp(`^/api/v1/namespaces/(${NAME})/pods$`),
];

export function deploymentPath(namespace: string, name: string): string {
  return `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;
}

export function createK8sWriteClient(cfg: K8sWriteConfig): K8sWriteClient {
  const requestOptions = (path: string, signal: AbortSignal | undefined) => ({
    headers: { authorization: `Bearer ${cfg.token()}`, accept: "application/json" },
    ca: cfg.ca,
    timeoutMs: cfg.timeoutMs ?? 5_000,
    maxBytes: cfg.maxResponseBytes ?? 4 * 1024 * 1024,
    signal,
    label: `kubernetes ${path}`,
  });

  async function getJson<T>(path: string, signal?: AbortSignal, query: QueryParams = {}): Promise<T> {
    assertReadable(path, cfg.namespaces);
    const { status, body } = await httpGet(buildUrl(cfg.server, path, query), requestOptions(path, signal));
    if (status < 200 || status >= 300) throw statusError(status, path, body);
    return JSON.parse(body) as T;
  }

  async function restartDeployment<T>(restart: DeploymentRestart, signal?: AbortSignal): Promise<T> {
    assertNamespace(restart.namespace, cfg.namespaces);
    assertName(restart.name);
    const path = deploymentPath(restart.namespace, restart.name);
    const dryRun = restart.mode === "dry_run" ? "All" : undefined;
    const query = { fieldManager: FIELD_MANAGER, dryRun };
    const patch = {
      ...requestOptions(path, signal),
      body: JSON.stringify(restartPatch(restart)),
      contentType: "application/strategic-merge-patch+json",
    };
    const { status, body } = await httpPatch(buildUrl(cfg.server, path, query), patch);
    if (status < 200 || status >= 300) throw statusError(status, path, body);
    return JSON.parse(body) as T;
  }

  return { namespaces: cfg.namespaces, getJson, restartDeployment };
}

/** What `kubectl rollout restart` changes, plus the resourceVersion as a precondition. */
export function restartPatch(restart: DeploymentRestart) {
  const annotations = { [RESTARTED_AT]: restart.restartedAt };
  return {
    metadata: { resourceVersion: restart.resourceVersion },
    spec: { template: { metadata: { annotations } } },
  };
}

function assertReadable(path: string, namespaces: readonly string[]): void {
  const namespace = READABLE.map((pattern) => pattern.exec(path)?.[1]).find((match) => match !== undefined);
  if (namespace === undefined) throw new Error(`the write adapter does not read ${path}`);
  assertNamespace(namespace, namespaces);
}

function assertNamespace(namespace: string, namespaces: readonly string[]): void {
  if (!namespaces.includes(namespace)) {
    throw new ToolError("namespace_not_allowed", `namespace ${namespace} is not in OPS_K8S_NAMESPACES`);
  }
}

function assertName(name: string): void {
  if (!PLAIN_NAME.test(name)) throw new Error(`not a Kubernetes name: ${name}`);
}

/** Maps API errors the agent can act on to ToolErrors; anything else stays internal. */
export function statusError(status: number, path: string, body: string): Error {
  const message = apiMessage(body);
  if (status === 401) {
    const renew = "make a new one with kubectl create token ops-write -n ops --duration=1h";
    return new ToolError("unauthorized", `the ops-write token was refused or has expired: ${renew}`);
  }
  if (status === 403) {
    return new ToolError("forbidden", `the ops-write ServiceAccount is not allowed to do this on ${path}`);
  }
  if (status === 404) return new ToolError("not_found", `${path} does not exist`);
  if (status === 409) return new ToolError("conflict", `${path} changed since it was read; propose the action again`);
  if (status === 400 || status === 422) {
    return new ToolError("invalid_request", message ?? `the API server refused the request for ${path}`);
  }
  return new Error(`kubernetes API returned ${status} for ${path}: ${message ?? "no message"}`);
}
