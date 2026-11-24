import { createHash } from "node:crypto";

const REVISION = "deployment.kubernetes.io/revision";
const REVISION_HISTORY = "deployment.kubernetes.io/revision-history";
const RESTARTED_AT = "kubectl.kubernetes.io/restartedAt";
// The deployment controller labels each ReplicaSet's template with its own hash, so no two templates match with it.
const TEMPLATE_HASH = "pod-template-hash";
// Helm charts commonly stamp the pod template with a hash of the config they mount, e.g. checksum/config.
const CHECKSUM_PREFIX = "checksum/";

interface Container {
  readonly name: string;
  readonly image?: string;
}

/**
 * Only the fields the timeline reads. A ReplicaSet's pod template holds env, command and args like a pod spec, and
 * its annotations can hold a whole manifest (last-applied-configuration): none of that is typed here, and only the
 * annotation keys named above are ever read.
 */
export interface ReplicaSet {
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly creationTimestamp?: string;
    readonly annotations?: Readonly<Record<string, string>>;
    readonly ownerReferences?: ReadonlyArray<{ readonly kind: string; readonly name: string }>;
  };
  readonly spec?: {
    readonly template?: {
      readonly metadata?: {
        readonly labels?: Readonly<Record<string, string>>;
        readonly annotations?: Readonly<Record<string, string>>;
      };
      readonly spec?: { readonly containers?: readonly Container[]; readonly initContainers?: readonly Container[] };
    };
  };
}

export type RolloutKind = "rollout" | "rollback";

/** One revision of a deployment and what changed from the revision before it. Times are epoch milliseconds. */
export interface Rollout {
  readonly kind: RolloutKind;
  readonly namespace: string;
  readonly deployment: string;
  readonly revision: number;
  /** When the revision's pods were first created; for a rollback, the template's original creation. */
  readonly createdAt: number;
  readonly change: string;
  readonly current: boolean;
}

/** Map.groupBy, which the ES2023 library this package targets does not declare. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): ReadonlyMap<string, readonly T[]> {
  const keys = [...new Set(items.map(keyOf))];
  return new Map(keys.map((key) => [key, items.filter((item) => keyOf(item) === key)]));
}

const revisionOf = (rs: ReplicaSet) => Number(rs.metadata.annotations?.[REVISION]);
// The deployment controller always sets it; without one, nothing says where a ReplicaSet sits in the history.
const hasRevision = (rs: ReplicaSet) => Number.isInteger(revisionOf(rs)) && revisionOf(rs) > 0;
const createdAtOf = (rs: ReplicaSet) => Date.parse(rs.metadata.creationTimestamp ?? "");
const templateAnnotations = (rs: ReplicaSet) => rs.spec?.template?.metadata?.annotations ?? {};

function deploymentOf(rs: ReplicaSet): string | undefined {
  const owner = rs.metadata.ownerReferences?.find((ref) => ref.kind === "Deployment");
  return owner?.name;
}

function imagesOf(rs: ReplicaSet): ReadonlyMap<string, string> {
  const spec = rs.spec?.template?.spec;
  const containers = [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])];
  return new Map(containers.map((container) => [container.name, container.image ?? "unknown"]));
}

function imageChanges(before: ReplicaSet, after: ReplicaSet): readonly string[] {
  const old = imagesOf(before);
  const changed = [...imagesOf(after)].filter(([name, image]) => old.get(name) !== image);
  return changed.map(([name, image]) => `image ${name}: ${old.get(name) ?? "(new container)"} → ${image}`);
}

const checksumsOf = (rs: ReplicaSet) =>
  Object.entries(templateAnnotations(rs)).filter(([key]) => key.startsWith(CHECKSUM_PREFIX));

function changedChecksums(before: ReplicaSet, after: ReplicaSet): readonly string[] {
  const old = new Map(checksumsOf(before));
  return checksumsOf(after)
    .filter(([key, value]) => old.get(key) !== value)
    .map(([key]) => key);
}

function withoutRestartAnnotation(rs: ReplicaSet): Readonly<Record<string, string>> {
  const { [RESTARTED_AT]: _restart, ...annotations } = templateAnnotations(rs);
  return annotations;
}

function withoutHashLabel(rs: ReplicaSet): Readonly<Record<string, string>> {
  const { [TEMPLATE_HASH]: _hash, ...labels } = rs.spec?.template?.metadata?.labels ?? {};
  return labels;
}

/**
 * The template's hash, apart from what every revision or restart sets. Templates hold env values, so they are only
 * hashed and compared: neither the template nor its hash is ever returned.
 */
function fingerprint(rs: ReplicaSet): string {
  const template = rs.spec?.template;
  const metadata = { ...template?.metadata, labels: withoutHashLabel(rs), annotations: withoutRestartAnnotation(rs) };
  return createHash("sha256")
    .update(JSON.stringify({ ...template, metadata }))
    .digest("hex");
}

const sameExceptRestart = (before: ReplicaSet, after: ReplicaSet) => fingerprint(before) === fingerprint(after);

/** What changed between two consecutive revisions, without saying what env or config now holds. */
export function describeChange(before: ReplicaSet | undefined, after: ReplicaSet): string {
  if (before === undefined) return "oldest revision kept in the history";
  const images = imageChanges(before, after);
  if (images.length > 0) return images.join("; ");
  if (sameExceptRestart(before, after)) return "restart (kubectl rollout restart): nothing else changed";
  const checksums = changedChecksums(before, after);
  if (checksums.length > 0) return `same images, config changed (${checksums.join(", ")})`;
  return "same images, pod template changed: env, config, resources or probes";
}

// An old ReplicaSet brought back gets a new revision and lists its old ones in revision-history.
const kindOf = (rs: ReplicaSet): RolloutKind => (rs.metadata.annotations?.[REVISION_HISTORY] ? "rollback" : "rollout");

function rolloutsOfOne(namespace: string, deployment: string, sets: readonly ReplicaSet[]): readonly Rollout[] {
  const byRevision = sets.toSorted((a, b) => revisionOf(a) - revisionOf(b));
  const latest = byRevision.at(-1);
  return byRevision.map((rs, index) => ({
    kind: kindOf(rs),
    namespace,
    deployment,
    revision: revisionOf(rs),
    createdAt: createdAtOf(rs),
    change: describeChange(byRevision[index - 1], rs),
    current: rs === latest,
  }));
}

/** Every deployment's revisions still on record (revisionHistoryLimit, 10 by default), oldest first per deployment. */
export function rolloutsOf(sets: readonly ReplicaSet[]): readonly Rollout[] {
  const groups = groupBy(
    sets.filter((rs) => deploymentOf(rs) !== undefined && hasRevision(rs)),
    (rs) => `${rs.metadata.namespace}/${deploymentOf(rs)}`,
  );
  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    const deployment = first ? deploymentOf(first) : undefined;
    if (!first || !deployment) return [];
    return rolloutsOfOne(first.metadata.namespace, deployment, group);
  });
}

/** Only ownership and the images each container runs. */
export interface PodImages {
  readonly metadata: {
    readonly namespace: string;
    readonly ownerReferences?: ReadonlyArray<{ readonly kind: string; readonly name: string }>;
  };
  readonly status?: {
    readonly containerStatuses?: ReadonlyArray<{
      readonly name: string;
      readonly image?: string;
      readonly imageID?: string;
    }>;
  };
}

export interface ImageDrift {
  readonly namespace: string;
  readonly replicaSet: string;
  readonly container: string;
  readonly image: string;
  readonly digests: readonly string[];
}

const shortDigest = (imageId: string) => imageId.split("@").at(-1)?.slice(0, 19) ?? imageId;

interface RunningImage {
  readonly namespace: string;
  readonly replicaSet: string;
  readonly container: string;
  readonly image: string;
  readonly digest: string;
}

function runningImages(pod: PodImages): RunningImage[] {
  const replicaSet = pod.metadata.ownerReferences?.find((ref) => ref.kind === "ReplicaSet")?.name;
  if (!replicaSet) return [];
  const statuses = (pod.status?.containerStatuses ?? []).filter((status) => status.imageID);
  return statuses.map((status) => ({
    namespace: pod.metadata.namespace,
    replicaSet,
    container: status.name,
    image: status.image ?? "unknown",
    digest: shortDigest(status.imageID ?? ""),
  }));
}

/**
 * Pods of one ReplicaSet share a template, so their images should be one build. Different digests mean a tag such as
 * `latest` was pulled again and moved between pods.
 */
export function imageDrift(pods: readonly PodImages[]): ImageDrift[] {
  const keyOf = (running: RunningImage) => `${running.namespace}/${running.replicaSet}/${running.container}`;
  const groups = groupBy(pods.flatMap(runningImages), keyOf);
  return [...groups.values()].flatMap((group) => {
    const digests = [...new Set(group.map((running) => running.digest))].toSorted();
    const [first] = group;
    if (!first || digests.length < 2) return [];
    const { digest: _one, ...where } = first;
    return [{ ...where, digests }];
  });
}
