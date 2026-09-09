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
import {
  AgentModel,
  AgentRunModel,
  OrganizationModel,
  VirtualApiKeyModel,
} from "@/models";
import McpDeploymentLeaseModel, {
  ClusterLeaseHeldError,
} from "@/models/mcp-deployment-lease";
import { reportAgentRuntimeSteer } from "@/observability/metrics/agent-runtime";
import type { AgentRunLaunchSpec } from "@/services/agent-runtime/backends";
import {
  AGENT_RUNTIME_ATTACH_SCRIPT,
  AGENT_RUNTIME_ATTACHMENTS_DIR,
  AGENT_RUNTIME_ATTACHMENTS_MANIFEST,
  AGENT_RUNTIME_INPUTS_READY_FILE,
} from "@/services/agent-runtime/runtime-contract";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import type {
  AgentRunInput,
  AgentRunRecord,
  AgentRuntimeSteerMode,
} from "@/types";
import { ApiError } from "@/types";
import {
  type AgentWorkspaceFileRequest,
  AgentWorkspaceFileRequestSchema,
  AgentWorkspaceFileResultSchema,
} from "@/types/agent-workspace-file";
import { execAgentRuntimeCommand } from "./exec";
import {
  AGENT_RUNTIME_CONTAINER_NAME,
  AGENT_RUNTIME_TMUX_SESSION,
  AGENT_SANDBOX_API,
  type AgentSandbox,
  buildAgentRuntimePlatformEgressPolicy,
  buildAgentRuntimeSandbox,
  buildAgentRuntimeSecret,
  buildAgentRuntimeTerminalIntegrationScript,
  buildAgentRuntimeTurnScript,
  type KubernetesAgentRunLaunchSpec,
} from "./manifests";
import {
  AGENT_RUNTIME_LEASE_SCOPE,
  AGENT_RUNTIME_TASK_LABEL,
  AGENT_RUNTIME_WORKSPACE_LABEL,
  agentRuntimeNames,
} from "./naming";
import {
  AGENT_RUNTIME_EGRESS_POLICY_CRDS,
  type AgentRuntimeEgressPolicyObject,
  buildAgentRuntimeEnvironmentEgressPolicies,
} from "./network-policy";
import {
  type AgentRuntimeStartupProgress,
  type AgentRuntimeStartupProgressReporter,
  attachingProgress,
  describeAgentRuntimeStartupProgress,
  isSameAgentRuntimeStartupProgress,
} from "./startup-phase";
import { withTranscriptRecoveryPod } from "./transcript-recovery";

/** `K8sClients` is internal to the shared module, so it is derived here. */
type K8sClients = ReturnType<typeof createK8sClients>;

/**
 * The Kubernetes side of an Agent Runtime run session: create the pod carrying a task,
 * deliver steer messages into it, attach to it, and tear it down.
 *
 * Deliberately holds no lifecycle state. Whether the work is going well is the
 * A2A task's business — this manager only answers for the pod, so the two can
 * never disagree about what is happening.
 */
class AgentRuntimeManager {
  private clients: K8sClients | null = null;
  /** Cached: loading a kubeconfig touches the filesystem. */
  private clusterReachable: boolean | null = null;

  get isEnabled(): boolean {
    return config.agentRuntime.enabled && this.canReachCluster();
  }

  /**
   * Create the Kubernetes objects for one session. The Secret is written
   * before the Job so the pod cannot start against a half-populated
   * environment, and the network policy before both so a pod is never
   * schedulable without its egress isolation in force.
   */
  async launch(spec: AgentRunLaunchSpec): Promise<void> {
    const clients = this.requireClients();
    const names = agentRuntimeNames(spec.frozenName);
    const { runtimeScope, ...runtimeSpec } = spec;
    const withOwner: KubernetesAgentRunLaunchSpec = {
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

    const existingSandbox = await clients.customObjectsApi
      .getNamespacedCustomObject({
        ...AGENT_SANDBOX_API,
        name: names.sandbox,
        namespace: withOwner.namespace,
      })
      .catch((error) => {
        if (isK8sNotFoundError(error)) return null;
        throw error;
      });
    if (existingSandbox) {
      logger.info(
        { taskId: withOwner.taskId, sandbox: names.sandbox },
        "Adopting an existing Agent Sandbox with the same frozen name",
      );
      return;
    }

    await withK8sApiRetry(
      () =>
        clients.coreApi.createNamespacedSecret({
          namespace: withOwner.namespace,
          body: buildAgentRuntimeSecret(withOwner),
        }),
      { label: "create Agent Runtime secret" },
    );

    const capabilities = (await getK8sCapabilities()).networkPolicy;
    const clusterDnsIps = await clusterDnsResolver.getClusterDnsIps(
      clients.coreApi,
    );
    await this.applyEgressPolicies(
      buildAgentRuntimeEnvironmentEgressPolicies({
        spec: withOwner,
        capabilities,
        clusterDnsIps,
      }),
    );
    await this.applyNetworkPolicy(
      buildAgentRuntimePlatformEgressPolicy({
        spec: withOwner,
        platformNamespace: process.env.POD_NAMESPACE || getK8sNamespace(),
        platformPodLabels: config.agentRuntime.platformPodSelector,
        platformPorts: [config.api.port],
      }),
    );

    await withK8sApiRetry(
      () =>
        clients.customObjectsApi.createNamespacedCustomObject({
          ...AGENT_SANDBOX_API,
          namespace: withOwner.namespace,
          body: buildAgentRuntimeSandbox(withOwner),
        }),
      { label: "create Agent Sandbox" },
    ).catch((error) => {
      if (!isK8sConflictError(error)) throw error;
      logger.info(
        { taskId: withOwner.taskId, sandbox: names.sandbox },
        "Adopting an existing Agent Sandbox with the same frozen name",
      );
    });
  }

  /** Read or atomically replace a bounded file in the owning workspace. */
  async accessWorkspaceFile(params: {
    session: AgentRunRecord;
    request: AgentWorkspaceFileRequest;
  }) {
    const request = AgentWorkspaceFileRequestSchema.parse(params.request);
    const pod = await this.findPod(params.session);
    if (pod?.status?.phase !== "Running" || !pod.metadata?.name) {
      throw new ApiError(
        409,
        "Resume this workspace before accessing its files",
      );
    }
    const result = await this.execInPod({
      session: params.session,
      podName: pod.metadata.name,
      command: ["python3", "/usr/local/bin/archestra-workspace-files"],
      stdin: NodeReadable.from([JSON.stringify(request)]),
    });
    const response = JSON.parse(result);
    if (response.ok !== true)
      throw new ApiError(
        400,
        response.error || "Workspace file operation failed",
      );
    return AgentWorkspaceFileResultSchema.parse(response);
  }

  /**
   * Copy durable inputs into the shared runtime volume, then atomically release
   * the bootstrap. The ready marker makes retries and reconciler adoption
   * idempotent: a control-plane restart cannot launch the Agent against a
   * half-written file set.
   */
  async stageInputs(params: {
    session: AgentRunRecord;
    inputs: AgentRunInput[];
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
      command: ["/bin/sh", "-c", `test -f ${AGENT_RUNTIME_INPUTS_READY_FILE}`],
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
          AGENT_RUNTIME_ATTACHMENTS_DIR,
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
        AGENT_RUNTIME_ATTACHMENTS_MANIFEST,
        AGENT_RUNTIME_INPUTS_READY_FILE,
      ],
      stdin: NodeReadable.from([manifest]),
    });
  }

  async continueRun(params: {
    session: AgentRunRecord;
    spec: AgentRunLaunchSpec;
  }): Promise<void> {
    const clients = this.requireClients();
    const sandbox = (await clients.customObjectsApi.getNamespacedCustomObject({
      ...AGENT_SANDBOX_API,
      namespace: params.session.runtimeScope,
      name: params.session.workloadName,
    })) as AgentSandbox;
    const container = sandbox.spec.podTemplate.spec?.containers.find(
      (entry) => entry.name === AGENT_RUNTIME_CONTAINER_NAME,
    );
    if (
      container?.image !== params.spec.image ||
      Boolean(container.securityContext?.privileged) !== params.spec.privileged
    ) {
      throw new Error(
        "The Agent image or privilege configuration changed; start a new workspace instead",
      );
    }
    await this.refreshWorkspaceEgress({ sandbox, spec: params.spec });
    // Keep the pending handoff outside this process before waiting for compute.
    // It contains credentials, so use a Secret, not annotations or task logs.
    const initialSecretName = agentRuntimeNames(
      params.session.workloadName,
    ).secret;
    const initialSecret = container.envFrom?.some(
      ({ secretRef }) => secretRef?.name === initialSecretName,
    )
      ? await clients.coreApi.readNamespacedSecret({
          namespace: params.session.runtimeScope,
          name: initialSecretName,
        })
      : null;
    const inheritedVariableNames = [
      ...(container.env ?? []).map(({ name }) => name),
      ...Object.keys(initialSecret?.data ?? {}),
    ];
    await clients.coreApi
      .createNamespacedSecret({
        namespace: params.session.runtimeScope,
        body: {
          metadata: {
            name: pendingTurnSecretName(params.session),
            labels: {
              [AGENT_RUNTIME_WORKSPACE_LABEL]: params.session.workloadName,
            },
            ownerReferences: sandbox.metadata.uid
              ? [
                  {
                    apiVersion: sandbox.apiVersion,
                    kind: sandbox.kind,
                    name: params.session.workloadName,
                    uid: sandbox.metadata.uid,
                  },
                ]
              : undefined,
          },
          type: "Opaque",
          stringData: {
            request: buildAgentRuntimeTurnScript(
              params.spec,
              inheritedVariableNames,
            ),
          },
        },
      })
      .catch((error) => {
        if (!isK8sConflictError(error)) throw error;
      });
    await this.recoverRun(params.session);
  }

  async recoverRun(session: AgentRunRecord): Promise<void> {
    const clients = this.requireClients();
    const pending = await clients.coreApi
      .readNamespacedSecret({
        namespace: session.runtimeScope,
        name: pendingTurnSecretName(session),
      })
      .catch((error) => {
        if (isK8sNotFoundError(error)) return null;
        throw error;
      });
    const sandbox = (await clients.customObjectsApi.getNamespacedCustomObject({
      ...AGENT_SANDBOX_API,
      namespace: session.runtimeScope,
      name: session.workloadName,
    })) as AgentSandbox;
    if (
      sandbox.spec.shutdownTime &&
      Date.parse(sandbox.spec.shutdownTime) <= Date.now()
    ) {
      throw new ApiError(409, "The workspace retention deadline has passed");
    }
    if (
      pending &&
      pending.metadata?.labels?.[AGENT_RUNTIME_WORKSPACE_LABEL] !==
        session.workloadName
    ) {
      throw new ApiError(
        409,
        "The saved continuation belongs to a different workspace",
      );
    }
    // The initial turn is already part of the Sandbox's bootstrap contract.
    if (
      !pending &&
      sandbox.metadata.labels?.[AGENT_RUNTIME_TASK_LABEL] === session.taskId
    )
      return;
    await clients.customObjectsApi.patchNamespacedCustomObject(
      {
        ...AGENT_SANDBOX_API,
        namespace: session.runtimeScope,
        name: session.workloadName,
        body: { spec: { operatingMode: "Running" } },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
    const podName = await this.waitForRunningPod({
      session,
      timeoutMessage: "The workspace could not be resumed",
    });
    if (!podName) throw new Error("The workspace is not running");
    const script = pending?.data?.request;
    if (!script) {
      const published = await this.execInPod({
        session,
        podName,
        command: [
          "/bin/sh",
          "-c",
          'base="/var/run/archestra/turns/$1"; if [ -f "$base.request" ] || [ -f "$base.started" ] || [ -f "$base.exit" ]; then printf present; fi',
          "check-turn",
          session.taskId,
        ],
      });
      if (published !== "present")
        throw new ApiError(
          502,
          "The run was interrupted before its command was saved. Continue in the retained workspace to retry.",
        );
      return;
    }
    await this.execInPod({
      session,
      podName,
      command: [
        "/bin/sh",
        "-c",
        [
          "set -eu; umask 077",
          'request="/var/run/archestra/turns/$1.request"',
          'if [ -f "$request" ] || [ -f "/var/run/archestra/turns/$1.started" ] || [ -f "/var/run/archestra/turns/$1.exit" ]; then exit 0; fi',
          'cat > "$request.tmp"',
          'mv "$request.tmp" "$request"',
        ].join("\n"),
        "enqueue-turn",
        session.taskId,
      ],
      stdin: NodeReadable.from([Buffer.from(script, "base64")]),
    });
  }

  async releaseRun(session: AgentRunRecord): Promise<void> {
    await this.revokeVirtualKey(session);
    await this.requireClients()
      .coreApi.deleteNamespacedSecret({
        namespace: session.runtimeScope,
        name: pendingTurnSecretName(session),
      })
      .catch((error) => {
        if (!isK8sNotFoundError(error)) throw error;
      });
  }

  async stopRun(session: AgentRunRecord): Promise<void> {
    await this.revokeVirtualKey(session);
    const pod = await this.findPod(session);
    if (pod?.status?.phase !== "Running" || !pod.metadata?.name) {
      await this.suspendWorkspace(session);
      return;
    }
    await this.execInPod({
      session,
      podName: pod.metadata.name,
      command: [
        "/bin/sh",
        "-c",
        [
          'set -eu; base="/var/run/archestra/turns/$1"',
          '[ ! -f "$base.exit" ] || exit 0',
          'touch "$base.cancel"',
          'if [ ! -f "$base.request" ] && [ ! -f "$base.started" ]; then printf "130\\n" > "$base.exit.tmp"; mv "$base.exit.tmp" "$base.exit"; fi',
          'attempt=0; while [ ! -f "$base.exit" ]; do attempt=$((attempt + 1)); [ "$attempt" -lt 15 ] || exit 1; sleep 1; done',
        ].join("\n"),
        "stop-turn",
        session.taskId,
      ],
    });
  }

  async suspendWorkspace(
    session: Pick<AgentRunRecord, "id" | "runtimeScope" | "workloadName">,
  ): Promise<void> {
    await this.requireClients().customObjectsApi.patchNamespacedCustomObject(
      {
        ...AGENT_SANDBOX_API,
        namespace: session.runtimeScope,
        name: session.workloadName,
        body: { spec: { operatingMode: "Suspended" } },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  }

  getWorkspaceConnection(
    session: Pick<AgentRunRecord, "workloadName" | "runtimeScope">,
  ) {
    return {
      hostname: `${session.workloadName}.${session.runtimeScope}`,
      shellCommand: [
        "kubectl",
        "exec",
        "-it",
        "-n",
        session.runtimeScope,
        session.workloadName,
        "-c",
        AGENT_RUNTIME_CONTAINER_NAME,
        "--",
        "env",
        "ARCHESTRA_AGENT_RUNTIME_AUTO_ATTACH=0",
        "/bin/sh",
      ]
        .map(shellDisplayArgument)
        .join(" "),
    };
  }

  async resumeWorkspace(session: AgentRunRecord): Promise<void> {
    const clients = this.requireClients();
    const sandbox = (await clients.customObjectsApi.getNamespacedCustomObject({
      ...AGENT_SANDBOX_API,
      namespace: session.runtimeScope,
      name: session.workloadName,
    })) as AgentSandbox;
    if (
      sandbox.spec.shutdownTime &&
      Date.parse(sandbox.spec.shutdownTime) <= Date.now()
    ) {
      throw new ApiError(409, "The workspace retention deadline has passed");
    }
    const agent = await AgentModel.findById(session.agentId);
    if (!agent || agent.organizationId !== session.organizationId) {
      throw new ApiError(404, "Workspace Agent not found");
    }
    const organization = await OrganizationModel.getById(
      session.organizationId,
    );
    const effectiveNetworkPolicy = await resolveEffectiveNetworkPolicy({
      organizationId: session.organizationId,
      environmentId: agent.environmentId,
      defaultNetworkPolicy: organization?.defaultNetworkPolicy,
    });
    await this.refreshWorkspaceEgress({
      sandbox,
      spec: {
        taskId: session.taskId,
        agentRuntimeId: session.agentId,
        frozenName: session.workloadName,
        runtimeScope: session.runtimeScope,
        effectiveNetworkPolicy,
      },
    });
    await clients.customObjectsApi.patchNamespacedCustomObject(
      {
        ...AGENT_SANDBOX_API,
        namespace: session.runtimeScope,
        name: session.workloadName,
        body: { spec: { operatingMode: "Running" } },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
    if (
      !(await this.waitForRunningPod({
        session,
        timeoutMessage: "The workspace could not be resumed",
      }))
    ) {
      throw new ApiError(409, "The workspace could not be resumed");
    }
  }

  /**
   * Deliver a message into a live session.
   *
   * `pipe` writes to the FIFO the runtime-agent reads, so the message lands at a
   * turn boundary and can never interleave with a tool call in flight.
   * `tmux_keys` types into the session, the only option for a CLI that owns its
   * own input loop.
   */
  async steer(params: {
    session: AgentRunRecord;
    steerMode: AgentRuntimeSteerMode;
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
            `tmux send-keys -t ${AGENT_RUNTIME_TMUX_SESSION} -l -- ${shellQuote(message)} && tmux send-keys -t ${AGENT_RUNTIME_TMUX_SESSION} Enter`,
          ]
        : [
            "/bin/sh",
            "-c",
            `printf '%s\\n' ${shellQuote(message)} > "$ARCHESTRA_AGENT_RUNTIME_STEER_FIFO"`,
          ];

    await this.execInPod({ session: params.session, podName, command });
    reportAgentRuntimeSteer(params.steerMode);
  }

  /**
   * Attach a caller's streams to the live tmux session.
   *
   * `tmux attach` rather than a fresh shell: the point is to land in the pane
   * the agent is already working in. Detaching leaves it running, so closing a
   * browser tab never ends a session mid-task.
   */
  async attach(params: {
    session: AgentRunRecord;
    stdin: Readable;
    stdout: Writable;
    stderr: Writable;
    onStatus?: (status: k8s.V1Status) => void;
    /** Called as the attach moves through its waits; see `startup-phase`. */
    onProgress?: AgentRuntimeStartupProgressReporter;
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
      onProgress: params.onProgress,
    });
    if (!podName) {
      throw new Error("This session has no running pod to attach to");
    }
    await this.waitForTmuxSession({
      session: params.session,
      podName,
      onProgress: params.onProgress,
    });
    params.onProgress?.({ ...attachingProgress(), resourceName: podName });
    // Live pods created before an upgrade do not have the stable helper yet.
    // Installing it here keeps the displayed command truthful for them too.
    await this.execInPod({
      session: params.session,
      podName,
      command: ["/bin/sh", "-c", buildAgentRuntimeTerminalIntegrationScript()],
    });
    const namespace = params.session.runtimeScope;
    const socket = await clients.exec.exec(
      namespace,
      podName,
      AGENT_RUNTIME_CONTAINER_NAME,
      agentRuntimeTerminalAttachCommand(),
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
        AGENT_RUNTIME_CONTAINER_NAME,
        "--",
        ...agentRuntimeTerminalAttachCommand(),
      ]
        .map(shellDisplayArgument)
        .join(" "),
      socket,
    };
  }

  /** Follow this turn's output, not earlier turns in the same Pod. */
  async streamLogs(params: {
    session: AgentRunRecord;
    destination: Writable;
    lines: number;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    await this.readTurnOutput({ ...params, follow: true });
  }

  /**
   * Recover the turn's full output from its PVC, independently of container log
   * rotation and Pod replacement, before committing the transcript to storage.
   */
  async snapshotLogs(params: {
    session: AgentRunRecord;
    destination: Writable;
    lines: number;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    await this.readTurnOutput({ ...params, follow: false });
  }

  /** Pod carrying a session, or null when nothing is scheduled. */
  async findPodName(session: AgentRunRecord): Promise<string | null> {
    const clients = this.requireClients();
    const pods = await clients.coreApi.listNamespacedPod({
      namespace: session.runtimeScope,
      labelSelector: `${AGENT_RUNTIME_WORKSPACE_LABEL}=${session.workloadName}`,
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
    session: AgentRunRecord,
  ): Promise<{ name: string; phase: string } | null> {
    const pod = await this.findPod(session);
    if (!pod?.metadata?.name) return null;
    return { name: pod.metadata.name, phase: pod.status?.phase ?? "Unknown" };
  }

  /** Point-in-time startup state used to seed a newly loaded run page. */
  async getStartupProgress(
    session: Pick<AgentRunRecord, "taskId" | "runtimeScope" | "workloadName">,
  ): Promise<AgentRuntimeStartupProgress & { resourceName: string | null }> {
    const pod = await this.findPod(session);
    return {
      ...describeAgentRuntimeStartupProgress(pod),
      resourceName: pod?.metadata?.name ?? null,
    };
  }

  /**
   * The whole pod object behind `findPodPhase`.
   *
   * A phase alone cannot say *why* a pod is Pending, and that reason — no node
   * has room, the image will not pull — is the only thing worth telling
   * someone watching a run start.
   */
  async findPod(
    session: Pick<AgentRunRecord, "taskId" | "runtimeScope" | "workloadName">,
  ): Promise<k8s.V1Pod | null> {
    const clients = this.requireClients();
    const pods = await clients.coreApi.listNamespacedPod({
      namespace: session.runtimeScope,
      labelSelector: `${AGENT_RUNTIME_WORKSPACE_LABEL}=${session.workloadName}`,
    });
    return pods.items.find((candidate) => candidate.metadata?.name) ?? null;
  }

  /**
   * Wait for the supervisor's durable turn result, not workspace termination.
   * Sandbox failure/expiry is a failure when no turn result was published.
   *
   * Resolves `{ outcome: "aborted" }` rather than throwing when the caller's
   * signal fires, so cancellation and failure stay distinguishable to the
   * lifecycle above.
   */
  async waitForCompletion(params: {
    session: AgentRunRecord;
    abortSignal?: AbortSignal;
    pollIntervalMs?: number;
  }): Promise<{
    outcome: "succeeded" | "failed" | "aborted";
    reason?: string;
  }> {
    const clients = this.requireClients();
    const { sandbox: sandboxName } = agentRuntimeNames(
      params.session.workloadName,
    );
    const interval = params.pollIntervalMs ?? AGENT_RUNTIME_COMPLETION_POLL_MS;

    while (!params.abortSignal?.aborted) {
      const sandbox = await clients.customObjectsApi
        .getNamespacedCustomObjectStatus({
          ...AGENT_SANDBOX_API,
          name: sandboxName,
          namespace: params.session.runtimeScope,
        })
        .then((value) => value as AgentSandbox)
        .catch((error) => {
          if (isK8sNotFoundError(error)) return null;
          throw error;
        });

      if (!sandbox) {
        // The workspace is gone: either torn down under us, or it never landed.
        // Either way there is no outcome left to wait for.
        return {
          outcome: "failed",
          reason: "The Agent Sandbox no longer exists",
        };
      }
      const pod = await this.findPod(params.session);
      if (pod?.status?.phase === "Running" && pod.metadata?.name) {
        const result = await this.execInPod({
          session: params.session,
          podName: pod.metadata.name,
          command: [
            "/bin/sh",
            "-c",
            'file="/var/run/archestra/turns/$1.exit"; if [ -f "$file" ]; then cat "$file"; fi',
            "read-turn-result",
            params.session.taskId,
          ],
        });
        if (result.trim()) {
          return result.trim() === "0"
            ? { outcome: "succeeded" }
            : {
                outcome: "failed",
                reason: `The Agent Runtime turn exited with status ${result.trim()}`,
              };
        }
      }
      const finished = sandbox.status?.conditions?.find(
        (entry) => entry.type === "Finished" && entry.status === "True",
      );
      const expired = sandbox.status?.conditions?.find(
        (entry) => entry.reason === "SandboxExpired",
      );
      if (finished || expired) {
        const condition = finished ?? expired;
        return {
          outcome: "failed",
          reason:
            condition?.message ??
            condition?.reason ??
            "The Agent Runtime run exited without completing",
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
  async teardown(session: AgentRunRecord): Promise<void> {
    // The key outlives the pod otherwise: a finished session's API key would
    // keep working, still charging the person it acted as.
    await this.revokeVirtualKey(session);
    await this.deleteWorkspace(session);
  }

  async deleteWorkspace(
    session: Pick<AgentRunRecord, "id" | "runtimeScope" | "workloadName">,
  ): Promise<void> {
    if (!this.isEnabled) return;

    const clients = this.requireClients();
    const names = agentRuntimeNames(session.workloadName);
    const namespace = session.runtimeScope;

    const deletions: Array<[string, () => Promise<unknown>]> = [
      [
        "sandbox",
        () =>
          clients.customObjectsApi.deleteNamespacedCustomObject({
            ...AGENT_SANDBOX_API,
            name: names.sandbox,
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
      ...(Object.entries(AGENT_RUNTIME_EGRESS_POLICY_CRDS).map(
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

    const errors: unknown[] = [];
    for (const [kind, remove] of deletions) {
      try {
        await withK8sApiRetry(remove, {
          label: `delete Agent Runtime ${kind}`,
        });
      } catch (error) {
        if (isK8sNotFoundError(error)) continue;
        errors.push(error);
        logger.warn(
          { error, sessionId: session.id, kind },
          "Failed to delete an Agent Runtime run object during teardown",
        );
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Workspace cleanup did not complete");
  }

  /**
   * Serialize a session's cluster mutations across replicas. A lease held
   * elsewhere means another replica is doing this work, so we skip rather than
   * duplicate it — the caller learns nothing ran.
   */
  async withSessionLease(
    session: AgentRunRecord,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await McpDeploymentLeaseModel.withLease(
        { scope: AGENT_RUNTIME_LEASE_SCOPE, key: session.id },
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

  private async refreshWorkspaceEgress(params: {
    sandbox: AgentSandbox;
    spec: Pick<
      AgentRunLaunchSpec,
      | "taskId"
      | "agentRuntimeId"
      | "frozenName"
      | "runtimeScope"
      | "effectiveNetworkPolicy"
    >;
  }): Promise<void> {
    const clients = this.requireClients();
    // The retained Pod keeps its original selector even though this turn has
    // a new task ID. Policies must continue selecting that Pod after a wake-up.
    const taskId =
      params.sandbox.spec.podTemplate.metadata?.labels?.[
        AGENT_RUNTIME_TASK_LABEL
      ];
    if (!taskId)
      throw new Error("Workspace is missing its network policy selector");
    const spec = {
      ...params.spec,
      taskId,
      frozenName: params.sandbox.metadata.name ?? params.spec.frozenName,
      namespace: params.spec.runtimeScope,
      ownerReferences: params.sandbox.metadata.ownerReferences,
    };
    const policies = buildAgentRuntimeEnvironmentEgressPolicies({
      spec,
      capabilities: (await getK8sCapabilities()).networkPolicy,
      clusterDnsIps: await clusterDnsResolver.getClusterDnsIps(clients.coreApi),
    });
    await this.applyEgressPolicies(policies);
    await this.applyNetworkPolicy(
      buildAgentRuntimePlatformEgressPolicy({
        spec,
        platformNamespace: process.env.POD_NAMESPACE || getK8sNamespace(),
        platformPodLabels: config.agentRuntime.platformPodSelector,
        platformPorts: [config.api.port],
      }),
    );
    // Policies are additive. Leaving an old allow policy of a different kind
    // would defeat a tightened Environment policy. Finish pruning before the
    // continuation request is published or a suspended Pod is woken.
    const name = agentRuntimeNames(spec.frozenName).environmentNetworkPolicy;
    const desiredKinds = new Set(policies.map(({ kind }) => kind));
    const removals: Array<
      [AgentRuntimeEgressPolicyObject["kind"], () => Promise<unknown>]
    > = [
      [
        "NetworkPolicy",
        () =>
          clients.networkingApi.deleteNamespacedNetworkPolicy({
            name,
            namespace: spec.namespace,
          }),
      ],
      ...Object.entries(AGENT_RUNTIME_EGRESS_POLICY_CRDS).map(
        ([kind, coordinates]) =>
          [
            kind as AgentRuntimeEgressPolicyObject["kind"],
            () =>
              clients.customObjectsApi.deleteNamespacedCustomObject({
                ...coordinates,
                name,
                namespace: spec.namespace,
              }),
          ] as [AgentRuntimeEgressPolicyObject["kind"], () => Promise<unknown>],
      ),
    ];
    for (const [kind, remove] of removals) {
      if (desiredKinds.has(kind)) continue;
      try {
        await remove();
      } catch (error) {
        if (!isK8sNotFoundError(error)) throw error;
      }
    }
  }

  private async applyNetworkPolicy(body: k8s.V1NetworkPolicy): Promise<void> {
    const clients = this.requireClients();
    const namespace = body.metadata?.namespace;
    const name = body.metadata?.name;
    if (!namespace || !name) {
      throw new Error(
        "AgentRuntime NetworkPolicy requires a name and namespace",
      );
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
    policies: AgentRuntimeEgressPolicyObject[],
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
    policy: Exclude<AgentRuntimeEgressPolicyObject, { kind: "NetworkPolicy" }>,
  ): Promise<void> {
    const clients = this.requireClients();
    const metadata = policy.object.metadata as
      | { name?: string; namespace?: string }
      | undefined;
    if (!metadata?.name || !metadata.namespace) {
      throw new Error(
        `AgentRuntime ${policy.kind} requires a name and namespace`,
      );
    }
    const coordinates = AGENT_RUNTIME_EGRESS_POLICY_CRDS[policy.kind];
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
          body: [{ op: "replace", path: "/spec", value: policy.object.spec }],
        },
        setHeaderOptions("Content-Type", PatchStrategy.JsonPatch),
      );
    }
  }

  private async revokeVirtualKey(session: AgentRunRecord): Promise<void> {
    if (!session.virtualApiKeyId) return;
    try {
      await VirtualApiKeyModel.delete(session.virtualApiKeyId);
    } catch (error) {
      logger.warn(
        { error, sessionId: session.id },
        "Failed to revoke an Agent Runtime run session's virtual key",
      );
      return;
    }
    await AgentRunModel.clearVirtualApiKey(session.id);
  }

  private async readTurnOutput(params: {
    session: AgentRunRecord;
    destination: Writable;
    follow: boolean;
    abortSignal?: AbortSignal;
    podName?: string;
  }): Promise<void> {
    if (params.abortSignal?.aborted) {
      params.destination.end();
      if (!params.follow)
        throw new Error("Agent Runtime transcript snapshot aborted");
      return;
    }
    if (!/^[a-zA-Z0-9-]+$/.test(params.session.taskId))
      throw new Error("Invalid Agent Runtime turn identifier");
    const pod = params.podName
      ? { name: params.podName, phase: "Running" }
      : await this.findPodPhase(params.session);
    if (!pod || pod.phase !== "Running") {
      if (params.follow)
        throw new Error("This session has no running pod to read output from");
      return withTranscriptRecoveryPod({
        clients: this.requireClients(),
        session: params.session,
        abortSignal: params.abortSignal,
        read: (podName) => this.readTurnOutput({ ...params, podName }),
      });
    }
    const path = `/var/run/archestra/turns/${params.session.taskId}`;
    // Read fixed byte ranges so growing output cannot duplicate bytes between
    // polls. The exit marker ends the remote process even after a disconnect.
    const script = params.follow
      ? `offset=0; while :; do
done_turn=0; [ ! -f '${path}.exit' ] || done_turn=1
if [ -f '${path}.log' ]; then
size=$(wc -c < '${path}.log'); count=$((size - offset))
if [ "$count" -gt 0 ]; then tail -c +$((offset + 1)) '${path}.log' | head -c "$count"; offset=$size; fi
fi
[ "$done_turn" = 0 ] || break
sleep 1
done`
      : `cat '${path}.log'`;
    const clients = this.requireClients();
    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket | undefined;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        params.abortSignal?.removeEventListener("abort", abort);
        params.destination.removeListener("error", finish);
        socket?.close();
        params.destination.end();
        if (error) reject(error);
        else resolve();
      };
      const timer = params.follow
        ? undefined
        : setTimeout(
            () =>
              finish(new Error("Agent Runtime transcript snapshot timed out")),
            30_000,
          );
      const abort = () =>
        finish(
          params.follow
            ? undefined
            : new Error("Agent Runtime transcript snapshot aborted"),
        );
      params.abortSignal?.addEventListener("abort", abort, { once: true });
      params.destination.on("error", finish);
      clients.exec
        .exec(
          params.session.runtimeScope,
          pod.name,
          AGENT_RUNTIME_CONTAINER_NAME,
          ["/bin/sh", "-c", script],
          params.destination,
          null,
          null,
          false,
          (status) =>
            finish(
              status.status === "Success"
                ? undefined
                : new Error("Could not read turn output"),
            ),
        )
        .then((connected) => {
          socket = connected;
          if (settled || params.abortSignal?.aborted) {
            connected.close();
            finish();
            return;
          }
          connected.on("error", finish);
          connected.on("close", () =>
            finish(
              new Error(
                "Agent Runtime transcript disconnected before completion",
              ),
            ),
          );
        })
        .catch(finish);
    });
  }

  private async execInPod(params: {
    session: AgentRunRecord;
    podName: string;
    command: string[];
    stdin?: Readable;
  }): Promise<string> {
    return execAgentRuntimeCommand({
      exec: this.requireClients().exec,
      namespace: params.session.runtimeScope,
      podName: params.podName,
      container: AGENT_RUNTIME_CONTAINER_NAME,
      command: params.command,
      stdin: params.stdin,
    });
  }

  private async waitForRunningPod(params: {
    session: AgentRunRecord;
    timeoutMessage: string;
    onProgress?: AgentRuntimeStartupProgressReporter;
  }): Promise<string | null> {
    const deadline = Date.now() + AGENT_RUNTIME_INPUT_STAGING_TIMEOUT_MS;
    let lastProgress: AgentRuntimeStartupProgress | null = null;
    while (Date.now() < deadline) {
      const pod = await this.findPod(params.session);
      const phase = pod?.status?.phase;
      if (phase === "Running" && pod?.metadata?.name) return pod.metadata.name;
      if (phase === "Succeeded" || phase === "Failed") return null;

      if (params.onProgress) {
        const progress = describeAgentRuntimeStartupProgress(pod);
        if (!isSameAgentRuntimeStartupProgress(lastProgress, progress)) {
          lastProgress = progress;
          params.onProgress({
            ...progress,
            resourceName: pod?.metadata?.name ?? null,
          });
        }
      }
      await delay(AGENT_RUNTIME_INPUT_STAGING_POLL_MS);
    }
    throw new Error(params.timeoutMessage);
  }

  /**
   * Pod Running only means the container process was accepted by Kubernetes;
   * its bootstrap may still be creating tmux. Wait for the actual attachable
   * session so the first browser connection is as reliable as a refresh.
   */
  private async waitForTmuxSession(params: {
    session: AgentRunRecord;
    podName: string;
    onProgress?: AgentRuntimeStartupProgressReporter;
  }): Promise<void> {
    const deadline = Date.now() + AGENT_RUNTIME_ATTACH_TIMEOUT_MS;
    params.onProgress?.({
      phase: "starting",
      message: "Waiting for the agent session",
      detail: null,
      resourceName: params.podName,
    });
    while (Date.now() < deadline) {
      const ready = await this.execInPod({
        session: params.session,
        podName: params.podName,
        command: [
          "/bin/sh",
          "-c",
          `tmux has-session -t ${AGENT_RUNTIME_TMUX_SESSION} 2>/dev/null`,
        ],
      })
        .then(() => true)
        .catch(() => false);
      if (ready) return;

      const pod = await this.findPodPhase(params.session);
      if (!pod || pod.phase === "Succeeded" || pod.phase === "Failed") {
        throw new Error("This run ended before its terminal was ready");
      }
      await delay(AGENT_RUNTIME_INPUT_STAGING_POLL_MS);
    }
    throw new Error("Timed out waiting for the Agent terminal");
  }

  /**
   * Whether a Kubernetes client can be built at all.
   *
   * Deliberately not `isK8sConfigured()`, which only reports whether the two
   * orchestrator environment variables are set: the loader also falls back to
   * the ambient `~/.kube/config`, which is how a developer machine runs MCP
   * server pods. Gating on the env vars alone made AgentRuntimes invisible on every
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
      throw new Error("Agent Runtime is not enabled");
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

export default new AgentRuntimeManager();

// ===================== helpers =====================

function pendingTurnSecretName(
  session: Pick<AgentRunRecord, "taskId">,
): string {
  return `agent-turn-${session.taskId}`;
}

/**
 * How often a waiting run re-reads its Job. Long enough that a task running
 * for hours is not a steady stream of API calls, short enough that a finished
 * task does not sit idle before the lifecycle settles it.
 */
const AGENT_RUNTIME_COMPLETION_POLL_MS = 5_000;
const AGENT_RUNTIME_INPUT_STAGING_POLL_MS = 500;
const AGENT_RUNTIME_INPUT_STAGING_TIMEOUT_MS = 5 * 60_000;
const AGENT_RUNTIME_ATTACH_TIMEOUT_MS = 60_000;

function agentRuntimeTerminalAttachCommand(): string[] {
  return [AGENT_RUNTIME_ATTACH_SCRIPT];
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
