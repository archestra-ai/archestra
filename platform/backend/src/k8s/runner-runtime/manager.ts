import type { Readable, Writable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";
import type * as k8s from "@kubernetes/client-node";
import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import type WebSocket from "ws";
import config from "@/config";
import { getK8sCapabilities } from "@/k8s/capabilities";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import { resolveRuntimeOwnerReferences } from "@/k8s/mcp-server-runtime/runtime-owner";
import {
  createK8sClients,
  getK8sNamespace,
  isK8sConflictError,
  isK8sNotFoundError,
  loadKubeConfig,
  withK8sApiRetry,
} from "@/k8s/shared";
import logger from "@/logging";
import { AgentRunModel, VirtualApiKeyModel } from "@/models";
import McpDeploymentLeaseModel, {
  ClusterLeaseHeldError,
} from "@/models/mcp-deployment-lease";
import { reportRunnerSteer } from "@/observability/metrics/runner";
import type { RunnerLaunchSpec } from "@/services/runners/backends";
import {
  RUNNER_ATTACH_SCRIPT,
  RUNNER_ATTACHMENTS_DIR,
  RUNNER_ATTACHMENTS_MANIFEST,
  RUNNER_INPUTS_READY_FILE,
} from "@/services/runners/runtime-contract";
import type {
  AgentDeploymentSteerMode,
  AgentExecutionInput,
  AgentRun,
} from "@/types";
import {
  buildRunnerJob,
  buildRunnerPlatformEgressPolicy,
  buildRunnerSecret,
  buildRunnerTerminalIntegrationScript,
  type KubernetesRunnerLaunchSpec,
  RUNNER_CONTAINER_NAME,
  RUNNER_TMUX_SESSION,
} from "./manifests";
import { RUNNER_LEASE_SCOPE, runnerNames, runnerPodSelector } from "./naming";
import {
  buildRunnerEnvironmentEgressPolicies,
  RUNNER_EGRESS_POLICY_CRDS,
  type RunnerEgressPolicyObject,
} from "./network-policy";

/** `K8sClients` is internal to the shared module, so it is derived here. */
type K8sClients = ReturnType<typeof createK8sClients>;

/**
 * The Kubernetes side of a runner session: create the pod carrying a task,
 * deliver steer messages into it, attach to it, and tear it down.
 *
 * Deliberately holds no lifecycle state. Whether the work is going well is the
 * A2A task's business — this manager only answers for the pod, so the two can
 * never disagree about what is happening.
 */
class RunnerRuntimeManager {
  private clients: K8sClients | null = null;
  /** Cached: loading a kubeconfig touches the filesystem. */
  private clusterReachable: boolean | null = null;

  get isEnabled(): boolean {
    return config.agentBackgroundExecution.enabled && this.canReachCluster();
  }

  /**
   * Create the Kubernetes objects for one session. The Secret is written
   * before the Job so the pod cannot start against a half-populated
   * environment, and the network policy before both so a pod is never
   * schedulable without its egress isolation in force.
   */
  async launch(spec: RunnerLaunchSpec): Promise<void> {
    const clients = this.requireClients();
    const names = runnerNames(spec.frozenName);
    const { runtimeScope, ...runtimeSpec } = spec;
    const withOwner: KubernetesRunnerLaunchSpec = {
      ...runtimeSpec,
      namespace: runtimeScope,
      ownerReferences: await resolveRuntimeOwnerReferences(
        clients.rbacApi,
        runtimeScope,
      ).catch((error) => {
        logger.warn(
          { error },
          "Could not resolve runtime owner references for an Agent run",
        );
        return undefined;
      }),
    };

    const existingJob = await clients.batchApi
      .readNamespacedJob({
        name: names.job,
        namespace: withOwner.namespace,
      })
      .catch((error) => {
        if (isK8sNotFoundError(error)) return null;
        throw error;
      });
    if (existingJob) {
      logger.info(
        { taskId: withOwner.taskId, job: names.job },
        "Adopting an existing runner job with the same frozen name",
      );
      return;
    }

    await withK8sApiRetry(
      () =>
        clients.coreApi.createNamespacedSecret({
          namespace: withOwner.namespace,
          body: buildRunnerSecret(withOwner),
        }),
      { label: "create runner secret" },
    );

    const capabilities = (await getK8sCapabilities()).networkPolicy;
    const clusterDnsIps = await clusterDnsResolver.getClusterDnsIps(
      clients.coreApi,
    );
    await this.applyEgressPolicies(
      buildRunnerEnvironmentEgressPolicies({
        spec: withOwner,
        capabilities,
        clusterDnsIps,
      }),
    );
    await this.applyNetworkPolicy(
      buildRunnerPlatformEgressPolicy({
        spec: withOwner,
        platformNamespace: process.env.POD_NAMESPACE || getK8sNamespace(),
        platformPodLabels: config.agentBackgroundExecution.platformPodSelector,
        platformPorts: [config.api.port],
      }),
    );

    await withK8sApiRetry(
      () =>
        clients.batchApi.createNamespacedJob({
          namespace: withOwner.namespace,
          body: buildRunnerJob(withOwner),
        }),
      { label: "create runner job" },
    ).catch((error) => {
      if (!isK8sConflictError(error)) throw error;
      logger.info(
        { taskId: withOwner.taskId, job: names.job },
        "Adopting an existing runner job with the same frozen name",
      );
    });
  }

  /**
   * Copy durable inputs into the shared runtime volume, then atomically release
   * the bootstrap. The ready marker makes retries and reconciler adoption
   * idempotent: a control-plane restart cannot launch the Agent against a
   * half-written file set.
   */
  async stageInputs(params: {
    session: AgentRun;
    inputs: AgentExecutionInput[];
  }): Promise<void> {
    if (params.inputs.length === 0) return;
    const pod = await this.waitForRunningPod({
      session: params.session,
      timeoutMessage:
        "Timed out waiting for the Agent pod to accept input files",
    });
    if (!pod) {
      throw new Error("This session ended before its input files were staged");
    }
    const alreadyReady = await this.execInPod({
      session: params.session,
      podName: pod,
      command: ["/bin/sh", "-c", `test -f ${RUNNER_INPUTS_READY_FILE}`],
    })
      .then(() => true)
      .catch(() => false);
    if (alreadyReady) return;

    for (const input of params.inputs) {
      await this.execInPod({
        session: params.session,
        podName: pod,
        command: [
          "/bin/sh",
          "-c",
          'umask 077; mkdir -p "$1"; cat > "$2"',
          "archestra-stage-input",
          RUNNER_ATTACHMENTS_DIR,
          input.runtimePath,
        ],
        stdin: NodeReadable.from([input.fileData]),
      });
    }

    const manifest = Buffer.from(
      JSON.stringify(
        params.inputs.map((input) => ({
          name: input.originalName,
          path: input.runtimePath,
          mediaType: input.mimeType,
          size: input.fileSize,
        })),
      ),
      "utf8",
    );
    await this.execInPod({
      session: params.session,
      podName: pod,
      command: [
        "/bin/sh",
        "-c",
        'umask 077; cat > "$1" && touch "$2"',
        "archestra-stage-input",
        RUNNER_ATTACHMENTS_MANIFEST,
        RUNNER_INPUTS_READY_FILE,
      ],
      stdin: NodeReadable.from([manifest]),
    });
  }

  /**
   * Deliver a message into a live session.
   *
   * `pipe` writes to the FIFO the runner-agent reads, so the message lands at a
   * turn boundary and can never interleave with a tool call in flight.
   * `tmux_keys` types into the session, the only option for a CLI that owns its
   * own input loop.
   */
  async steer(params: {
    session: AgentRun;
    steerMode: AgentDeploymentSteerMode;
    message: string;
  }): Promise<void> {
    const podName = await this.findPodName(params.session);
    if (!podName) {
      throw new Error("This session has no running pod to steer");
    }
    // A steer is one message. Newlines are stripped rather than escaped because
    // both delivery paths treat them as submit: send-keys passes them to the
    // pty as Enter, and the FIFO reader takes a line at a time.
    const message = params.message.replace(/[\r\n]+/g, " ").trim();
    if (!message) {
      throw new Error("A steer message cannot be only whitespace");
    }

    const command =
      params.steerMode === "tmux_keys"
        ? [
            "/bin/sh",
            "-c",
            // `--` stops tmux reading a message beginning with a dash as its
            // own options; Enter is sent separately as the submit.
            `tmux send-keys -t ${RUNNER_TMUX_SESSION} -l -- ${shellQuote(message)} && tmux send-keys -t ${RUNNER_TMUX_SESSION} Enter`,
          ]
        : [
            "/bin/sh",
            "-c",
            `printf '%s\\n' ${shellQuote(message)} > "$ARCHESTRA_AGENT_BACKGROUND_EXECUTION_STEER_FIFO"`,
          ];

    await this.execInPod({ session: params.session, podName, command });
    reportRunnerSteer(params.steerMode);
  }

  /**
   * Attach a caller's streams to the live tmux session.
   *
   * `tmux attach` rather than a fresh shell: the point is to land in the pane
   * the agent is already working in. Detaching leaves it running, so closing a
   * browser tab never ends a session mid-task.
   */
  async attach(params: {
    session: AgentRun;
    stdin: Readable;
    stdout: Writable;
    stderr: Writable;
    onStatus?: (status: k8s.V1Status) => void;
  }): Promise<{ podName: string; command: string; socket: WebSocket }> {
    const clients = this.requireClients();
    // A2A marks the durable task working before Kubernetes necessarily has a
    // Running pod. Chat can therefore open the terminal during image pull or
    // scheduling; wait for that normal transition instead of turning it into
    // a sticky attach error that requires the user to reload.
    const podName = await this.waitForRunningPod({
      session: params.session,
      timeoutMessage:
        "Timed out waiting for the Agent pod to accept a terminal",
    });
    if (!podName) {
      throw new Error("This session has no running pod to attach to");
    }
    await this.waitForTmuxSession({ session: params.session, podName });
    // Live pods created before an upgrade do not have the stable helper yet.
    // Installing it here keeps the displayed command truthful for them too.
    await this.execInPod({
      session: params.session,
      podName,
      command: ["/bin/sh", "-c", buildRunnerTerminalIntegrationScript()],
    });
    const namespace = params.session.runtimeScope;
    const socket = await clients.exec.exec(
      namespace,
      podName,
      RUNNER_CONTAINER_NAME,
      runnerTerminalAttachCommand(),
      params.stdout,
      params.stderr,
      params.stdin,
      true,
      params.onStatus,
    );
    return {
      podName,
      command: [
        "kubectl",
        "exec",
        "-it",
        "-n",
        namespace,
        podName,
        "-c",
        RUNNER_CONTAINER_NAME,
        "--",
        ...runnerTerminalAttachCommand(),
      ]
        .map(shellDisplayArgument)
        .join(" "),
      socket,
    };
  }

  /** Follow the session's stdout, which is what the agent loop prints. */
  async streamLogs(params: {
    session: AgentRun;
    destination: Writable;
    lines: number;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const clients = this.requireClients();
    const pod = await this.findPodPhase(params.session);
    if (!pod) {
      throw new Error("This session has no pod to read logs from");
    }
    const request = await clients.log.log(
      params.session.runtimeScope,
      pod.name,
      RUNNER_CONTAINER_NAME,
      params.destination,
      {
        follow: true,
        tailLines: params.lines,
        pretty: false,
        timestamps: false,
      },
    );
    params.abortSignal?.addEventListener(
      "abort",
      () => {
        request.abort();
      },
      { once: true },
    );
  }

  /** Pod carrying a session, or null when nothing is scheduled. */
  async findPodName(session: AgentRun): Promise<string | null> {
    const clients = this.requireClients();
    const pods = await clients.coreApi.listNamespacedPod({
      namespace: session.runtimeScope,
      labelSelector: runnerPodSelector(session.taskId),
    });
    const running = pods.items.find(
      (pod) => pod.status?.phase === "Running" && pod.metadata?.name,
    );
    return running?.metadata?.name ?? null;
  }

  /**
   * The pod carrying a session, in any phase — including one that has already
   * terminated. `findPodName` deliberately only returns a Running pod (attach
   * and steer need a live one); waiting for an outcome needs to see the
   * Succeeded and Failed phases too, and a pod that finished before the first
   * poll would otherwise look like a pod that never scheduled.
   */
  async findPodPhase(
    session: AgentRun,
  ): Promise<{ name: string; phase: string } | null> {
    const clients = this.requireClients();
    const pods = await clients.coreApi.listNamespacedPod({
      namespace: session.runtimeScope,
      labelSelector: runnerPodSelector(session.taskId),
    });
    const pod = pods.items.find((candidate) => candidate.metadata?.name);
    if (!pod?.metadata?.name) return null;
    return { name: pod.metadata.name, phase: pod.status?.phase ?? "Unknown" };
  }

  /**
   * Wait for a session's Job to reach a terminal state.
   *
   * The Job, not the pod, is the authority: a pod that dies with a retryable
   * exit code is replaced under a Job that is still running, and treating that
   * first pod's death as the outcome would end the task early.
   *
   * Resolves `{ outcome: "aborted" }` rather than throwing when the caller's
   * signal fires, so cancellation and failure stay distinguishable to the
   * lifecycle above.
   */
  async waitForCompletion(params: {
    session: AgentRun;
    abortSignal?: AbortSignal;
    pollIntervalMs?: number;
  }): Promise<{
    outcome: "succeeded" | "failed" | "aborted";
    reason?: string;
  }> {
    const clients = this.requireClients();
    const { job: jobName } = runnerNames(params.session.deploymentName);
    const interval = params.pollIntervalMs ?? RUNNER_COMPLETION_POLL_MS;

    while (!params.abortSignal?.aborted) {
      const job = await clients.batchApi
        .readNamespacedJobStatus({
          name: jobName,
          namespace: params.session.runtimeScope,
        })
        .catch(() => null);

      if (!job) {
        // The Job is gone: either torn down under us, or it never landed.
        // Either way there is no outcome left to wait for.
        return {
          outcome: "failed",
          reason: "The background job no longer exists",
        };
      }
      if ((job.status?.succeeded ?? 0) > 0) {
        return { outcome: "succeeded" };
      }
      if ((job.status?.failed ?? 0) > 0) {
        const condition = job.status?.conditions?.find(
          (entry) => entry.type === "Failed" && entry.status === "True",
        );
        return {
          outcome: "failed",
          reason:
            condition?.message ??
            condition?.reason ??
            "The background run exited without completing",
        };
      }

      await delay(interval, params.abortSignal);
    }

    return { outcome: "aborted" };
  }

  /**
   * Remove every Kubernetes object belonging to a session and revoke its key.
   * Safe to retry, including after a partial failure — an object already gone
   * is a success, and everything else is retried like the create path.
   */
  async teardown(session: AgentRun): Promise<void> {
    // The key outlives the pod otherwise: a finished session's API key would
    // keep working, still charging the person it acted as.
    await this.revokeVirtualKey(session);
    if (!this.isEnabled) return;

    const clients = this.requireClients();
    const names = runnerNames(session.deploymentName);
    const namespace = session.runtimeScope;

    const deletions: Array<[string, () => Promise<unknown>]> = [
      [
        "job",
        () =>
          clients.batchApi.deleteNamespacedJob({
            name: names.job,
            namespace,
            // Without Foreground the Job's pod outlives the Job object.
            propagationPolicy: "Foreground",
          }),
      ],
      [
        "secret",
        () =>
          clients.coreApi.deleteNamespacedSecret({
            name: names.secret,
            namespace,
          }),
      ],
      [
        "networkPolicy",
        () =>
          clients.networkingApi.deleteNamespacedNetworkPolicy({
            name: names.networkPolicy,
            namespace,
          }),
      ],
      [
        "environmentNetworkPolicy",
        () =>
          clients.networkingApi.deleteNamespacedNetworkPolicy({
            name: names.environmentNetworkPolicy,
            namespace,
          }),
      ],
      ...(Object.entries(RUNNER_EGRESS_POLICY_CRDS).map(
        ([kind, coordinates]) => [
          `environment${kind}`,
          () =>
            clients.customObjectsApi.deleteNamespacedCustomObject({
              ...coordinates,
              name: names.environmentNetworkPolicy,
              namespace,
            }),
        ],
      ) as Array<[string, () => Promise<unknown>]>),
    ];

    for (const [kind, remove] of deletions) {
      try {
        await withK8sApiRetry(remove, { label: `delete runner ${kind}` });
      } catch (error) {
        if (isK8sNotFoundError(error)) continue;
        logger.warn(
          { error, sessionId: session.id, kind },
          "Failed to delete a runner object during teardown",
        );
      }
    }
  }

  /**
   * Serialize a session's cluster mutations across replicas. A lease held
   * elsewhere means another replica is doing this work, so we skip rather than
   * duplicate it — the caller learns nothing ran.
   */
  async withSessionLease(
    session: AgentRun,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await McpDeploymentLeaseModel.withLease(
        { scope: RUNNER_LEASE_SCOPE, key: session.id },
        async (lease) => {
          await operation();
          await lease.assertOwned();
        },
      );
      return true;
    } catch (error) {
      if (error instanceof ClusterLeaseHeldError) return false;
      throw error;
    }
  }

  // ===================== internals =====================

  private async applyNetworkPolicy(body: k8s.V1NetworkPolicy): Promise<void> {
    const clients = this.requireClients();
    const namespace = body.metadata?.namespace;
    const name = body.metadata?.name;
    if (!namespace || !name) {
      throw new Error("Runner NetworkPolicy requires a name and namespace");
    }
    try {
      await clients.networkingApi.createNamespacedNetworkPolicy({
        namespace,
        body,
      });
    } catch (error) {
      if (!isK8sConflictError(error)) throw error;
      await clients.networkingApi.replaceNamespacedNetworkPolicy({
        name,
        namespace,
        body,
      });
    }
  }

  private async applyEgressPolicies(
    policies: RunnerEgressPolicyObject[],
  ): Promise<void> {
    for (const policy of policies) {
      if (policy.kind === "NetworkPolicy") {
        await this.applyNetworkPolicy(policy.object);
        continue;
      }
      await this.applyCustomEgressPolicy(policy);
    }
  }

  private async applyCustomEgressPolicy(
    policy: Exclude<RunnerEgressPolicyObject, { kind: "NetworkPolicy" }>,
  ): Promise<void> {
    const clients = this.requireClients();
    const metadata = policy.object.metadata as
      | { name?: string; namespace?: string }
      | undefined;
    if (!metadata?.name || !metadata.namespace) {
      throw new Error(`Runner ${policy.kind} requires a name and namespace`);
    }
    const coordinates = RUNNER_EGRESS_POLICY_CRDS[policy.kind];
    try {
      await clients.customObjectsApi.createNamespacedCustomObject({
        ...coordinates,
        namespace: metadata.namespace,
        body: policy.object,
      });
    } catch (error) {
      if (!isK8sConflictError(error)) throw error;
      await clients.customObjectsApi.patchNamespacedCustomObject(
        {
          ...coordinates,
          namespace: metadata.namespace,
          name: metadata.name,
          body: policy.object,
        },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      );
    }
  }

  private async revokeVirtualKey(session: AgentRun): Promise<void> {
    if (!session.virtualApiKeyId) return;
    try {
      await VirtualApiKeyModel.delete(session.virtualApiKeyId);
    } catch (error) {
      logger.warn(
        { error, sessionId: session.id },
        "Failed to revoke a runner session's virtual key",
      );
      return;
    }
    await AgentRunModel.clearVirtualApiKey(session.id);
  }

  private async execInPod(params: {
    session: AgentRun;
    podName: string;
    command: string[];
    stdin?: Readable;
  }): Promise<void> {
    const clients = this.requireClients();
    const { PassThrough } = await import("node:stream");
    const stderr = new PassThrough();
    const stderrChunks: Buffer[] = [];
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    await new Promise<void>((resolve, reject) => {
      clients.exec
        .exec(
          params.session.runtimeScope,
          params.podName,
          RUNNER_CONTAINER_NAME,
          params.command,
          null,
          stderr,
          params.stdin ?? null,
          false,
          (status) => {
            if (status.status === "Success") {
              resolve();
              return;
            }
            reject(
              new Error(
                `Command in runner pod failed: ${
                  Buffer.concat(stderrChunks).toString("utf8").trim() ||
                  status.message ||
                  "unknown error"
                }`,
              ),
            );
          },
        )
        .catch(reject);
    });
  }

  private async waitForRunningPod(params: {
    session: AgentRun;
    timeoutMessage: string;
  }): Promise<string | null> {
    const deadline = Date.now() + RUNNER_INPUT_STAGING_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pod = await this.findPodPhase(params.session);
      if (pod?.phase === "Running") return pod.name;
      if (pod && (pod.phase === "Succeeded" || pod.phase === "Failed")) {
        return null;
      }
      await delay(RUNNER_INPUT_STAGING_POLL_MS);
    }
    throw new Error(params.timeoutMessage);
  }

  /**
   * Pod Running only means the container process was accepted by Kubernetes;
   * its bootstrap may still be creating tmux. Wait for the actual attachable
   * session so the first browser connection is as reliable as a refresh.
   */
  private async waitForTmuxSession(params: {
    session: AgentRun;
    podName: string;
  }): Promise<void> {
    const deadline = Date.now() + RUNNER_ATTACH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const ready = await this.execInPod({
        session: params.session,
        podName: params.podName,
        command: [
          "/bin/sh",
          "-c",
          `tmux has-session -t ${RUNNER_TMUX_SESSION} 2>/dev/null`,
        ],
      })
        .then(() => true)
        .catch(() => false);
      if (ready) return;

      const pod = await this.findPodPhase(params.session);
      if (!pod || pod.phase === "Succeeded" || pod.phase === "Failed") {
        throw new Error("This execution ended before its terminal was ready");
      }
      await delay(RUNNER_INPUT_STAGING_POLL_MS);
    }
    throw new Error("Timed out waiting for the Agent terminal");
  }

  /**
   * Whether a Kubernetes client can be built at all.
   *
   * Deliberately not `isK8sConfigured()`, which only reports whether the two
   * orchestrator environment variables are set: the loader also falls back to
   * the ambient `~/.kube/config`, which is how a developer machine runs MCP
   * server pods. Gating on the env vars alone made Runners invisible on every
   * setup where the rest of the Kubernetes runtime works.
   */
  private canReachCluster(): boolean {
    if (this.clusterReachable === null) {
      try {
        loadKubeConfig();
        this.clusterReachable = true;
      } catch {
        this.clusterReachable = false;
      }
    }
    return this.clusterReachable;
  }

  private requireClients(): K8sClients {
    if (!this.isEnabled) {
      throw new Error("Agent Background execution is not enabled");
    }
    if (!this.clients) {
      this.clients = createK8sClients(
        loadKubeConfig().kubeConfig,
        getK8sNamespace(),
      );
    }
    return this.clients;
  }
}

export default new RunnerRuntimeManager();

// ===================== helpers =====================

/**
 * How often a waiting run re-reads its Job. Long enough that a task running
 * for hours is not a steady stream of API calls, short enough that a finished
 * task does not sit idle before the lifecycle settles it.
 */
const RUNNER_COMPLETION_POLL_MS = 5_000;
const RUNNER_INPUT_STAGING_POLL_MS = 500;
const RUNNER_INPUT_STAGING_TIMEOUT_MS = 5 * 60_000;
const RUNNER_ATTACH_TIMEOUT_MS = 60_000;

function runnerTerminalAttachCommand(): string[] {
  return [RUNNER_ATTACH_SCRIPT];
}

/** Sleep that wakes early on abort, so cancellation is not delayed a full poll. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellDisplayArgument(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : shellQuote(value);
}
