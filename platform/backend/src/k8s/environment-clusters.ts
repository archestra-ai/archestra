import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as k8s from "@kubernetes/client-node";
import type { schema } from "@/database/schema";
import logger from "@/logging";
import EnvironmentModel from "@/models/environment";
import { secretManager } from "@/secrets-manager";
import {
  type ClusterAgentEndpoint,
  clusterAgentKubeconfig,
  openClusterAgentPodStream,
  readClusterAgentCredential,
} from "./cluster-agent";
import {
  type EnvironmentKubeconfig,
  parseEnvironmentKubeconfig,
} from "./environment-kubeconfig";
import {
  createK8sClients,
  type K8sClients,
  type K8sCluster,
  loadKubeConfig,
} from "./shared";

// === Public API ===

/** The part of an environment row that says which cluster it deploys into. */
export type EnvironmentClusterBinding = Pick<
  typeof schema.environmentsTable.$inferSelect,
  | "id"
  | "kubeconfigSecretId"
  | "kubeconfigServer"
  | "kubeconfigVersion"
  | "clusterAgent"
  | "deletingAt"
>;

/**
 * Why the clients are wanted. Everything deploys or operates workloads,
 * which an environment being deleted refuses; only the deletion's own
 * cleanup of the cluster passes `forCleanup`.
 */
interface ClusterPurpose {
  forCleanup?: boolean;
}

/**
 * An environment's cluster cannot be used: the environment or its kubeconfig
 * is gone, or the stored kubeconfig is unreadable. Callers must not fall back
 * to the platform's own cluster: the workload they are after is not there.
 */
class EnvironmentClusterUnavailableError extends Error {
  constructor(environmentId: string, reason: string) {
    super(
      `The Kubernetes cluster of environment ${environmentId} is unavailable: ${reason}`,
    );
  }
}

/** How long the file of a replaced kubeconfig stays readable. */
const SUPERSEDED_KUBECONFIG_FILE_LIFETIME_MS = 60_000;

/**
 * Label on every workload the platform creates in the cluster of an
 * environment that deploys into a cluster of its own; the value is the
 * environment's id. Cleanup in such a cluster touches only what carries the
 * label of the environment being cleaned up: a kubeconfig can name any
 * cluster and namespace, including ones that hold workloads of the platform's
 * own cluster or of another installation.
 */
export const ENVIRONMENT_CLUSTER_LABEL = "archestra.io/environment-cluster";

/**
 * Clients for a kubeconfig that is not (or not yet) an environment's: one
 * being tested or validated before it is stored. `normalizedKubeconfig` is
 * the output of `parseEnvironmentKubeconfig`.
 */
export function clientsForKubeconfig(normalizedKubeconfig: string): K8sClients {
  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromString(normalizedKubeconfig);
  return createK8sClients(kubeConfig, "default");
}

/** The stored kubeconfig of a bound environment, validated again on the way out. */
/** The stored token and CA of an environment's cluster agent. */
export async function readStoredClusterAgentCredential(
  secretId: string,
): Promise<{ token: string; ca?: string } | undefined> {
  const secret = await secretManager().getSecret(secretId, { skipCache: true });
  return readClusterAgentCredential(secret?.secret);
}

export async function readEnvironmentKubeconfig(
  environment: EnvironmentClusterBinding,
): Promise<EnvironmentKubeconfig> {
  return readStoredKubeconfig(environment);
}

/** The secret value an environment's kubeconfig is stored as. */
export function kubeconfigSecretValue(normalizedKubeconfig: string): {
  kubeconfig: string;
} {
  return { kubeconfig: normalizedKubeconfig };
}

/**
 * Hands out the Kubernetes clients for the cluster an environment deploys
 * into: the platform's own cluster, or the one its kubeconfig names.
 *
 * Each bound environment gets exactly one client set per process, for the
 * life of the process. Its cluster never changes (the binding is fixed when
 * the environment is created); only its credential rotates, and a rotation is
 * loaded into the existing `KubeConfig` object, which every client reads its
 * credential from at request time. So objects that hold these clients
 * (deployments, watch streams, tunnels) never go stale.
 */
class EnvironmentClusters {
  private localCluster: K8sCluster | null = null;
  private readonly bound = new Map<string, BoundCluster>();
  private readonly loading = new Map<string, Promise<BoundCluster>>();
  private kubeconfigDirectory: string | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  /**
   * The platform's own cluster. Throws when the orchestrator is disabled or
   * its kubeconfig cannot be loaded, as `loadKubeConfig` does.
   */
  local(): K8sCluster {
    if (!this.localCluster) {
      const { kubeConfig, namespace } = loadKubeConfig();
      this.localCluster = {
        ...createK8sClients(kubeConfig, namespace),
        environmentId: null,
      };
    }
    return this.localCluster;
  }

  /**
   * The cluster an environment deploys into. No environment (the default
   * environment has no row) and an environment without a kubeconfig both mean
   * the platform's own cluster.
   */
  async forEnvironment(
    environment: EnvironmentClusterBinding | null | undefined,
    purpose: ClusterPurpose = {},
  ): Promise<K8sCluster> {
    if (!environment) return this.local();
    assertNotBeingDeleted(environment, purpose);
    // An environment bound to its own cluster never becomes one of the
    // platform's cluster, whatever happened to its kubeconfig or agent.
    if (!environment.kubeconfigServer) return this.local();
    return (await this.boundCluster(environment)).cluster;
  }

  /**
   * The cluster recorded for a workload: null is the platform's own cluster,
   * an environment id that environment's. An id that no longer names a bound
   * environment throws; it never resolves to the platform's own cluster.
   */
  async forEnvironmentId(
    environmentId: string | null,
    purpose: ClusterPurpose = {},
  ): Promise<K8sCluster> {
    if (environmentId === null) return this.local();
    const environment = await EnvironmentModel.findById(environmentId);
    if (!environment) {
      throw new EnvironmentClusterUnavailableError(
        environmentId,
        "the environment no longer exists",
      );
    }
    assertNotBeingDeleted(environment, purpose);
    if (!environment.kubeconfigServer) {
      throw new EnvironmentClusterUnavailableError(
        environmentId,
        "the environment has no cluster of its own",
      );
    }
    return (await this.boundCluster(environment)).cluster;
  }

  /**
   * Whether this process has loaded the cluster of at least one environment
   * that deploys into a cluster of its own. Such clusters are loaded when the
   * platform starts and when an environment is created.
   */
  get hasEnvironmentClusters(): boolean {
    return this.bound.size > 0;
  }

  /**
   * Begin an operation that creates or changes workloads in the cluster of
   * the environment `environmentId` (null: the platform's own cluster), and
   * resolve to the function that ends it. Call it before the operation's
   * first effect, and call the returned function when the operation has
   * ended, however it ended.
   *
   * For the cluster of an environment this records the operation, so that
   * the environment is not deleted while it runs; it throws when the
   * environment is already being deleted. The platform's own cluster needs
   * no record.
   */
  async beginWrite(environmentId: string | null): Promise<() => Promise<void>> {
    if (environmentId === null) return async () => {};
    const writeId = await EnvironmentModel.beginClusterWrite(environmentId);
    if (!writeId) {
      throw new EnvironmentClusterUnavailableError(
        environmentId,
        "the environment is being deleted or no longer exists",
      );
    }
    let ended = false;
    return async () => {
      if (ended) return;
      ended = true;
      try {
        await EnvironmentModel.endClusterWrite(writeId);
      } catch (error) {
        // The record expires on its own; until then it only delays a delete.
        logger.warn(
          { err: error, environmentId },
          "Failed to remove an environment cluster write record",
        );
      }
    };
  }

  /** Run `operation` as one that writes to that cluster; see `beginWrite`. */
  async withWrite<T>(
    environmentId: string | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    const end = await this.beginWrite(environmentId);
    try {
      return await operation();
    } finally {
      await end();
    }
  }

  /**
   * Path of a kubeconfig file for kubectl, for a bound environment's cluster;
   * undefined for the platform's own cluster, where kubectl uses the process's
   * own credentials. The path changes when the credential rotates.
   */
  kubeconfigPath(cluster: K8sCluster): string | undefined {
    if (cluster.environmentId === null) return undefined;
    return this.bound.get(cluster.environmentId)?.kubeconfigPath;
  }

  /** Stop using a deleted environment's cluster and remove its kubeconfig file. */
  forget(environmentId: string): void {
    const entry = this.bound.get(environmentId);
    if (!entry) return;
    this.bound.delete(environmentId);
    removeFile(entry.kubeconfigPath);
  }

  /** Stop the background refresh and remove every kubeconfig file. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const environmentId of [...this.bound.keys()]) {
      this.forget(environmentId);
    }
    this.loading.clear();
    this.localCluster = null;
  }

  /**
   * Bring every loaded cluster in line with the database: pick up credentials
   * another platform replica rotated, and drop environments that were deleted.
   * Runs on a timer so that code holding these clients without going through
   * `forEnvironment` is never left on an old credential.
   */
  async refresh(): Promise<void> {
    if (this.bound.size === 0) return;
    const versions = new Map(
      (await EnvironmentModel.listKubeconfigVersions()).map((row) => [
        row.id,
        row,
      ]),
    );
    for (const [environmentId, entry] of [...this.bound]) {
      const current = versions.get(environmentId);
      if (!current) {
        this.forget(environmentId);
        continue;
      }
      if (current.kubeconfigVersion === entry.version) continue;
      try {
        await this.boundCluster(current);
      } catch (error) {
        logger.warn(
          { err: error, environmentId },
          "Failed to reload a rotated environment kubeconfig",
        );
      }
    }
  }

  // === Private helpers ===

  private async boundCluster(
    environment: EnvironmentClusterBinding,
  ): Promise<BoundCluster> {
    const existing = this.bound.get(environment.id);
    if (existing && existing.version >= environment.kubeconfigVersion) {
      return existing;
    }
    let pending = this.loading.get(environment.id);
    if (!pending) {
      pending = this.loadCurrent(environment.id).finally(() => {
        this.loading.delete(environment.id);
      });
      this.loading.set(environment.id, pending);
    }
    const loaded = await pending;
    // The load this caller joined began before its credential was written.
    if (loaded.version < environment.kubeconfigVersion) {
      return this.boundCluster(environment);
    }
    return loaded;
  }

  /**
   * Load the credential the environment has now. The caller's row is not
   * trusted for it: it may predate a rotation, whose old secret is gone.
   */
  private async loadCurrent(environmentId: string): Promise<BoundCluster> {
    const current = await EnvironmentModel.findById(environmentId);
    if (!current?.kubeconfigSecretId) {
      throw new EnvironmentClusterUnavailableError(
        environmentId,
        "the environment or its kubeconfig no longer exists",
      );
    }
    try {
      return await this.load(current);
    } catch (error) {
      // The row read above may already be the old one: a rotation that
      // committed in between removed the secret it names.
      const latest = await EnvironmentModel.findById(environmentId);
      if (
        !latest?.kubeconfigSecretId ||
        latest.kubeconfigSecretId === current.kubeconfigSecretId
      ) {
        throw error;
      }
      return this.load(latest);
    }
  }

  private async load(
    environment: EnvironmentClusterBinding,
  ): Promise<BoundCluster> {
    const stored = await readStoredCredential(environment);
    const kubeconfig = stored.kubeconfig;
    const kubeconfigPath = this.writeKubeconfigFile(environment.id, kubeconfig);

    const existing = this.bound.get(environment.id);
    if (existing) {
      existing.agentEndpoint = stored.agentEndpoint;
      // Rotation: same cluster, new credential. Loading it into the existing
      // KubeConfig updates every client built from it.
      existing.cluster.kubeConfig.loadFromString(kubeconfig);
      if (existing.kubeconfigPath !== kubeconfigPath) {
        // A code-sandbox session that was just handed the old path may not
        // have opened it yet.
        const superseded = existing.kubeconfigPath;
        setTimeout(() => {
          // The path is the kubeconfig's hash: a rotation back to the same
          // credential makes it the current file again.
          if (this.bound.get(environment.id)?.kubeconfigPath !== superseded) {
            removeFile(superseded);
          }
        }, SUPERSEDED_KUBECONFIG_FILE_LIFETIME_MS).unref();
      }
      existing.kubeconfigPath = kubeconfigPath;
      existing.version = environment.kubeconfigVersion;
      return existing;
    }

    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromString(kubeconfig);
    const entry: BoundCluster = {
      cluster: {
        // A bound environment always names its own namespace; the clients'
        // default namespace is only the fallback the platform's own cluster uses.
        ...createK8sClients(kubeConfig, "default"),
        environmentId: environment.id,
      },
      version: environment.kubeconfigVersion,
      kubeconfigPath,
      agentEndpoint: stored.agentEndpoint,
    };
    if (stored.agentEndpoint) {
      // Reads the entry's endpoint per stream: a rotated token applies to the
      // next stream without rebuilding anything that holds these clients.
      entry.cluster.openPodStream = (target) => {
        if (!entry.agentEndpoint) {
          throw new EnvironmentClusterUnavailableError(
            environment.id,
            "its cluster agent is no longer configured",
          );
        }
        return openClusterAgentPodStream(entry.agentEndpoint, target);
      };
    }
    this.bound.set(environment.id, entry);
    this.startRefreshing();
    return entry;
  }

  /**
   * Write the kubeconfig where kubectl (run by the Dagger CLI) can read it and
   * nothing else can: a directory only this user can enter, a file only this
   * user can read, created fresh rather than written through an existing path.
   */
  private writeKubeconfigFile(
    environmentId: string,
    kubeconfig: string,
  ): string {
    if (!this.kubeconfigDirectory) {
      removeStaleKubeconfigDirectories();
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), KUBECONFIG_DIRECTORY_PREFIX),
      );
      // Says which process the directory belongs to, for a later process to
      // know it can remove it once this one is gone.
      fs.writeFileSync(path.join(directory, PID_FILE), String(process.pid), {
        mode: 0o600,
      });
      process.once("exit", () => {
        fs.rmSync(directory, { recursive: true, force: true });
      });
      this.kubeconfigDirectory = directory;
    }
    const digest = createHash("sha256").update(kubeconfig).digest("hex");
    const filePath = path.join(
      this.kubeconfigDirectory,
      `${environmentId}-${digest}`,
    );
    try {
      fs.writeFileSync(filePath, kubeconfig, { mode: 0o600, flag: "wx" });
    } catch (error) {
      // The name carries the content's hash, so an existing file already
      // holds exactly this kubeconfig.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return filePath;
  }

  private startRefreshing(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((error) => {
        logger.warn(
          { err: error },
          "Failed to refresh environment Kubernetes clusters",
        );
      });
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }
}

export const environmentClusters = new EnvironmentClusters();

// === Internal helpers ===

interface BoundCluster {
  cluster: K8sCluster;
  /** The environment's `kubeconfigVersion` the credential was loaded at. */
  version: number;
  kubeconfigPath: string;
  /** For a cluster reached through its cluster agent: the agent and its token. */
  agentEndpoint?: ClusterAgentEndpoint;
}

const REFRESH_INTERVAL_MS = 30_000;

/**
 * The one place that stops work in an environment that is being deleted.
 * Every path into an environment's own cluster takes its clients from this
 * registry, so once the deletion's mark is committed no replica can start
 * anything there, and the deletion's cleanup is final.
 */
function assertNotBeingDeleted(
  environment: EnvironmentClusterBinding,
  purpose: ClusterPurpose,
): void {
  if (environment.deletingAt && !purpose.forCleanup) {
    throw new EnvironmentClusterUnavailableError(
      environment.id,
      "the environment is being deleted",
    );
  }
}
const KUBECONFIG_DIRECTORY_PREFIX = "archestra-environment-kubeconfig-";
const PID_FILE = "pid";

/**
 * Remove the kubeconfig directories of platform processes that no longer
 * exist. A process removes its own on exit, but not when it is killed or the
 * host goes down; the files it leaves are readable only by the same user, and
 * are cleaned up here by the next process that starts.
 */
function removeStaleKubeconfigDirectories(): void {
  let names: string[];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(KUBECONFIG_DIRECTORY_PREFIX)) continue;
    const directory = path.join(os.tmpdir(), name);
    try {
      if (fs.lstatSync(directory).uid !== process.getuid?.()) continue;
      const pid = Number(
        fs.readFileSync(path.join(directory, PID_FILE), "utf8"),
      );
      if (Number.isInteger(pid) && isProcessAlive(pid)) continue;
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Another process's directory in the middle of being created or
      // removed: leave it to that process or to the next start.
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The credential an environment's clients load: its kubeconfig, or for a
 * cluster reached through its cluster agent, a kubeconfig whose server is the
 * agent, with the agent's token.
 */
async function readStoredCredential(
  environment: EnvironmentClusterBinding,
): Promise<{ kubeconfig: string; agentEndpoint?: ClusterAgentEndpoint }> {
  if (!environment.clusterAgent) {
    return { kubeconfig: (await readStoredKubeconfig(environment)).normalized };
  }
  if (!environment.kubeconfigSecretId || !environment.kubeconfigServer) {
    throw new EnvironmentClusterUnavailableError(
      environment.id,
      "its cluster agent is not configured",
    );
  }
  // The secrets cache is per process: after a rotation handled by another
  // replica it would still hold the old token.
  const secret = await secretManager().getSecret(
    environment.kubeconfigSecretId,
    { skipCache: true },
  );
  const credential = readClusterAgentCredential(secret?.secret);
  if (!credential) {
    throw new EnvironmentClusterUnavailableError(
      environment.id,
      "its cluster agent token is missing",
    );
  }
  const agentEndpoint = { url: environment.kubeconfigServer, ...credential };
  return { kubeconfig: clusterAgentKubeconfig(agentEndpoint), agentEndpoint };
}

async function readStoredKubeconfig(
  environment: EnvironmentClusterBinding,
): Promise<EnvironmentKubeconfig> {
  if (!environment.kubeconfigSecretId) {
    throw new EnvironmentClusterUnavailableError(
      environment.id,
      "the environment has no kubeconfig",
    );
  }
  // The secrets cache is per process: after a rotation handled by another
  // replica it would still hold the old credential.
  const secret = await secretManager().getSecret(
    environment.kubeconfigSecretId,
    { skipCache: true },
  );
  const value = secret?.secret;
  const stored =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).kubeconfig
      : undefined;
  if (typeof stored !== "string") {
    throw new EnvironmentClusterUnavailableError(
      environment.id,
      "its stored kubeconfig is missing",
    );
  }
  // Stored documents were validated when saved. Parsing again keeps a secret
  // edited outside the platform from reaching kubectl with fields that the
  // platform refuses.
  try {
    return parseEnvironmentKubeconfig(stored);
  } catch (error) {
    throw new EnvironmentClusterUnavailableError(
      environment.id,
      error instanceof Error ? error.message : "its kubeconfig is invalid",
    );
  }
}

function removeFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    logger.warn({ err: error }, "Failed to remove an environment kubeconfig");
  }
}
