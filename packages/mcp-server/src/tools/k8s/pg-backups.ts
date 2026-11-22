import { z } from "zod";
import { defineTool, Level } from "../../types.js";
import {
  allowedNamespaces,
  type Condition,
  clip,
  conditionOf,
  customResourcePath,
  describeSpan,
  HOUR_S,
  k8sLabel,
  secondsSince,
  whenNotInstalled,
} from "./shared.js";

const CLOUDNATIVE_PG_API = "postgresql.cnpg.io/v1";
// walArchivingFailing: the backup waits for WAL that cannot be archived, so it cannot complete either.
const FAILED_PHASES = new Set(["failed", "walArchivingFailing"]);

interface Metadata {
  readonly name?: string;
  readonly namespace?: string;
  readonly creationTimestamp?: string;
}

interface ClusterRef {
  readonly cluster?: { readonly name?: string };
}

/** Only the fields the tool reads. The cluster's deprecated lastSuccessfulBackup is unset with backup plugins. */
export interface PgCluster {
  readonly metadata?: Metadata;
  readonly status?: { readonly phase?: string; readonly conditions?: readonly Condition[] };
}

/** Backups also hold `commandOutput` and credential references; neither is read. */
export interface PgBackup {
  readonly metadata?: Metadata;
  readonly spec?: ClusterRef & { readonly method?: string };
  readonly status?: {
    readonly phase?: string;
    readonly method?: string;
    readonly startedAt?: string;
    readonly stoppedAt?: string;
    readonly error?: string;
  };
}

export interface PgScheduledBackup {
  readonly metadata?: Metadata;
  readonly spec?: ClusterRef & { readonly schedule?: string; readonly suspend?: boolean };
  readonly status?: { readonly lastScheduleTime?: string };
}

interface BackupRun {
  readonly name: string;
  readonly phase: string | null;
  readonly method: string | null;
  readonly started_ago_s: number | null;
  readonly error: string | null;
}

interface ClusterBackups {
  readonly namespace: string;
  readonly name: string;
  readonly phase: string | null;
  readonly wal_archiving: { readonly ok: boolean | null; readonly message: string | null };
  readonly last_successful_backup_ago_s: number | null;
  readonly failed_since_last_success: number;
  readonly latest: BackupRun | null;
  readonly schedules: ReadonlyArray<{ name: string; schedule: string | null; suspended: boolean }>;
  readonly problems: readonly string[];
}

const startOf = (backup: PgBackup) => backup.status?.startedAt ?? backup.metadata?.creationTimestamp ?? "";
const newestFirst = (a: PgBackup, b: PgBackup) => Date.parse(startOf(b)) - Date.parse(startOf(a));
const isCompleted = (backup: PgBackup) => backup.status?.phase === "completed";
const isFailed = (backup: PgBackup) => FAILED_PHASES.has(backup.status?.phase ?? "");

const belongsTo = (cluster: PgCluster) => (resource: { metadata?: Metadata; spec?: ClusterRef }) =>
  resource.metadata?.namespace === cluster.metadata?.namespace &&
  resource.spec?.cluster?.name === cluster.metadata?.name;

function toRun(backup: PgBackup, now: Date): BackupRun {
  return {
    name: backup.metadata?.name ?? "",
    phase: backup.status?.phase ?? null,
    method: backup.status?.method ?? backup.spec?.method ?? null,
    started_ago_s: secondsSince(startOf(backup), now),
    error: clip(backup.status?.error) ?? null,
  };
}

/** The conclusions an operator would draw first, spelled out so the model doesn't have to. */
function problemsOf(summary: Omit<ClusterBackups, "problems">, maxAgeHours: number): string[] {
  const {
    wal_archiving: wal,
    last_successful_backup_ago_s: lastSuccessAgo,
    failed_since_last_success: failed,
  } = summary;
  const problems: string[] = [];

  if (wal.ok === false) {
    problems.push(`WAL archiving is failing, so point-in-time recovery is not possible: ${wal.message ?? ""}`);
  }
  if (lastSuccessAgo === null) problems.push("no backup of this cluster has ever completed");
  if (lastSuccessAgo !== null && lastSuccessAgo > maxAgeHours * HOUR_S) {
    problems.push(`the last successful backup finished ${describeSpan(lastSuccessAgo)} ago`);
  }
  if (failed > 0) {
    const latestError = summary.latest?.error ?? "no error message";
    problems.push(`${failed} backups failed since the last successful one; latest: ${latestError}`);
  }
  if (summary.schedules.length === 0) problems.push("no ScheduledBackup: backups only run when someone starts one");
  for (const { name } of summary.schedules.filter((schedule) => schedule.suspended)) {
    problems.push(`ScheduledBackup ${name} is suspended`);
  }
  return problems;
}

interface Resources {
  readonly backups: readonly PgBackup[];
  readonly schedules: readonly PgScheduledBackup[];
}

export function summarizeCluster(cluster: PgCluster, resources: Resources, now: Date, maxAgeHours: number) {
  const backups = resources.backups.filter(belongsTo(cluster)).toSorted(newestFirst);
  const lastSuccessIndex = backups.findIndex(isCompleted);
  const sinceLastSuccess = lastSuccessIndex === -1 ? backups : backups.slice(0, lastSuccessIndex);
  const lastSuccess = backups[lastSuccessIndex];
  const archiving = conditionOf(cluster.status?.conditions, "ContinuousArchiving");
  const schedules = resources.schedules.filter(belongsTo(cluster)).map((schedule) => ({
    name: schedule.metadata?.name ?? "",
    schedule: schedule.spec?.schedule ?? null,
    suspended: schedule.spec?.suspend === true,
  }));

  const summary = {
    namespace: cluster.metadata?.namespace ?? "",
    name: cluster.metadata?.name ?? "",
    phase: cluster.status?.phase ?? null,
    wal_archiving: {
      ok: archiving === undefined ? null : archiving.status === "True",
      message: clip(archiving?.message) ?? null,
    },
    last_successful_backup_ago_s: secondsSince(lastSuccess?.status?.stoppedAt ?? lastSuccess?.status?.startedAt, now),
    failed_since_last_success: sinceLastSuccess.filter(isFailed).length,
    latest: backups[0] ? toRun(backups[0], now) : null,
    schedules,
  };
  return { ...summary, problems: problemsOf(summary, maxAgeHours) };
}

const NOT_INSTALLED =
  "CloudNativePG is not installed in this cluster (there is no postgresql.cnpg.io/v1 API), so there are no " +
  "Postgres clusters or backups to inspect. Backups made another way are not visible to this tool.";

export const k8sPgBackups = defineTool({
  name: "k8s_pg_backups",
  level: Level.Read,
  requires: ["k8s"],
  title: "Kubernetes: Postgres backups (CloudNativePG)",
  description:
    "Backup health of each CloudNativePG Postgres cluster in the allowed namespaces: when the last successful " +
    "backup finished, backups failed since then with the latest error, the newest backup's state, the " +
    "ScheduledBackups (and whether any is suspended), and whether continuous WAL archiving works. `problems` " +
    "lists what needs attention, clusters with problems first. Use to check that the database can be restored, " +
    "or when a backup alert fires. `max_age_hours` is the age after which the last successful backup counts " +
    "as stale.",
  input: {
    namespace: k8sLabel.optional(),
    max_age_hours: z.number().int().min(1).max(720).default(26),
  },
  timeoutMs: 8_000,

  async run({ namespace, max_age_hours }, { k8s, signal }) {
    const list = <T>(ns: string, plural: "clusters" | "backups" | "scheduledbackups") =>
      k8s.getJson<{ items: T[] }>(customResourcePath(CLOUDNATIVE_PG_API, ns, plural), signal).then((r) => r.items);
    const listNamespace = (ns: string) =>
      Promise.all([
        list<PgCluster>(ns, "clusters"),
        list<PgBackup>(ns, "backups"),
        list<PgScheduledBackup>(ns, "scheduledbackups"),
      ]);

    const namespaces = allowedNamespaces(k8s, namespace);
    const perNamespace = await Promise.all(namespaces.map(listNamespace)).catch(whenNotInstalled(NOT_INSTALLED));

    const clusters = perNamespace.flatMap(([namespaceClusters]) => namespaceClusters);
    const resources = {
      backups: perNamespace.flatMap(([, backups]) => backups),
      schedules: perNamespace.flatMap(([, , schedules]) => schedules),
    };
    const now = new Date();
    const summaries = clusters.map((cluster) => summarizeCluster(cluster, resources, now, max_age_hours));
    const mostProblemsFirst = (a: ClusterBackups, b: ClusterBackups) => b.problems.length - a.problems.length;
    return { total: summaries.length, clusters: summaries.toSorted(mostProblemsFirst) };
  },
});
