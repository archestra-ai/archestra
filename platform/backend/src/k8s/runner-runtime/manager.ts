import type * as k8s from "@kubernetes/client-node";
import config from "@/config";
import { resolveRuntimeOwnerReferences } from "@/k8s/mcp-server-runtime/runtime-owner";
import {
  createK8sClients,
  getK8sNamespace,
  isK8sConfigured,
  isK8sConflictError,
  isK8sNotFoundError,
  loadKubeConfig,
  withK8sApiRetry,
} from "@/k8s/shared";
import logger from "@/logging";
import { RunnerEventModel, RunnerModel } from "@/models";
import McpDeploymentLeaseModel, {
  ClusterLeaseHeldError,
} from "@/models/mcp-deployment-lease";
import {
  reportRunnerProvisioned,
  reportRunnerStarted,
  reportRunnerStates,
  reportRunnerSteer,
  reportRunnerTerminated,
} from "@/observability/metrics/runner";
import type { Runner } from "@/types";
import {
  buildRunnerJob,
  buildRunnerPlatformEgressPolicy,
  buildRunnerSecret,
  type RunnerLaunchSpec,
} from "./manifests";
import {
  RUNNER_LEASE_SCOPE,
  RUNNER_MANAGED_SELECTOR,
  runnerNames,
  runnerPodSelector,
} from "./naming";

/**
 * Owns the Kubernetes side of a Runner's life: create the workload, observe
 * whether it is up, deliver steer messages into the live session, and tear
 * everything down.
 *
 * The database row is authoritative. This manager never invents state — it
 * reconciles the cluster towards the rows and reports what it observed, so a
 * pod deleted behind our back surfaces as a failed runner rather than a
 * runner that appears to still be running.
 */
/** `K8sClients` is internal to the shared module, so it is derived here. */
type K8sClients = ReturnType<typeof createK8sClients>;

class RunnerRuntimeManager {
  private clients: K8sClients | null = null;

  get isEnabled(): boolean {
    return config.runners.enabled && isK8sConfigured();
  }

  /**
   * Start the reconcile loop. Safe to call when the feature is off, in which
   * case it does nothing — callers should not have to branch.
   */
  start(): void {
    if (!this.isEnabled) {
      logger.info(
        "Runner runtime is disabled (feature flag off or no Kubernetes configuration)",
      );
      return;
    }
    const sweep = () => {
      this.reconcileAll().catch((error) => {
        logger.warn({ error }, "Runner reconcile sweep failed");
      });
    };
    sweep();
    const timer = setInterval(
      sweep,
      config.runners.reconcileIntervalSeconds * 1000,
    );
    // A sweeper must never be the reason the process stays alive.
    timer.unref?.();
  }

  /**
   * Create the Kubernetes objects for one runner and mark it provisioning.
   * The Secret is written before the Job so the pod cannot start against a
   * half-populated environment.
   */
  async launch(params: {
    runner: Runner;
    spec: RunnerLaunchSpec;
  }): Promise<void> {
    const clients = this.requireClients();
    const { runner } = params;
    // Owner references make runtime-created objects disappear with the release
    // rather than outliving it as orphans.
    const spec: RunnerLaunchSpec = {
      ...params.spec,
      ownerReferences:
        params.spec.ownerReferences ??
        (await resolveRuntimeOwnerReferences(
          clients.rbacApi,
          params.spec.namespace,
        ).catch((error) => {
          logger.warn(
            { error },
            "Could not resolve runtime owner references for a runner",
          );
          return undefined;
        })),
    };
    const names = runnerNames(spec.frozenName);

    await RunnerModel.update(runner.id, runner.organizationId, {
      state: "provisioning",
      deploymentName: spec.frozenName,
      namespace: spec.namespace,
      secretName: names.secret,
    });

    await withK8sApiRetry(
      () =>
        clients.coreApi.createNamespacedSecret({
          namespace: spec.namespace,
          body: buildRunnerSecret(spec),
        }),
      { label: "create runner secret" },
    ).catch(async (error) => {
      if (!isK8sConflictError(error)) throw error;
      await clients.coreApi.replaceNamespacedSecret({
        name: names.secret,
        namespace: spec.namespace,
        body: buildRunnerSecret(spec),
      });
    });

    // Egress to the platform's API, as a policy selecting only this runner's
    // pods. Kubernetes unions the egress rules of every policy selecting a
    // pod, so this composes with whatever the runner's environment already
    // applies instead of widening anything for other workloads.
    await this.applyPlatformEgressPolicy(spec);

    await withK8sApiRetry(
      () =>
        clients.batchApi.createNamespacedJob({
          namespace: spec.namespace,
          body: buildRunnerJob(spec),
        }),
      { label: "create runner job" },
    ).catch((error) => {
      // A Job with this frozen name already exists: the previous launch got
      // further than we recorded. Adopt it rather than failing the runner.
      if (!isK8sConflictError(error)) throw error;
      logger.info(
        { runnerId: runner.id, job: names.job },
        "Adopting an existing runner job with the same frozen name",
      );
    });

    reportRunnerStarted();
    await RunnerEventModel.append({
      runnerId: runner.id,
      kind: "system",
      message: `Provisioning ${spec.image}`,
    });
  }

  /**
   * Deliver a message into the live session.
   *
   * `pipe` writes to the FIFO the Archestra runner-agent reads, so the message
   * lands at a turn boundary and can never interleave with a tool call in
   * flight. `tmux_keys` types into the session, which is the only option for a
   * bring-your-own CLI that owns its own input loop.
   */
  async steer(params: { runner: Runner; message: string }): Promise<void> {
    const { runner, message } = params;
    const podName = await this.findPodName(runner);
    if (!podName) {
      throw new Error(`Runner ${runner.id} has no running pod to steer`);
    }
    const command =
      runner.steerMode === "tmux_keys"
        ? [
            "/bin/sh",
            "-c",
            // -l sends the text literally; Enter is a separate keystroke so a
            // message containing newlines cannot submit half of itself.
            `tmux send-keys -t agent -l ${shellQuote(message)} && tmux send-keys -t agent Enter`,
          ]
        : [
            "/bin/sh",
            "-c",
            `printf '%s\\n' ${shellQuote(message)} > "$ARCHESTRA_RUNNER_STEER_FIFO"`,
          ];

    await this.execInPod({ runner, podName, command });
    reportRunnerSteer(runner.steerMode);
    await RunnerModel.touchActivity(runner.id);
  }

  /** Pod name backing a runner, or null when nothing is scheduled. */
  async findPodName(runner: Runner): Promise<string | null> {
    const clients = this.requireClients();
    const namespace = runner.namespace ?? getK8sNamespace();
    const pods = await clients.coreApi.listNamespacedPod({
      namespace,
      labelSelector: runnerPodSelector(runner.id),
    });
    const running = pods.items.find(
      (pod) => pod.status?.phase === "Running" && pod.metadata?.name,
    );
    return running?.metadata?.name ?? null;
  }

  /**
   * Remove every Kubernetes object belonging to a runner. Never throws for an
   * object that is already gone: teardown has to be safe to retry, including
   * after a partial failure.
   */
  async teardown(runner: Runner): Promise<void> {
    if (!this.isEnabled || !runner.deploymentName) {
      return;
    }
    const clients = this.requireClients();
    const namespace = runner.namespace ?? getK8sNamespace();
    const names = runnerNames(runner.deploymentName);

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
    ];

    for (const [kind, remove] of deletions) {
      try {
        await remove();
      } catch (error) {
        if (isK8sNotFoundError(error)) continue;
        logger.warn(
          { error, runnerId: runner.id, kind },
          "Failed to delete a runner object during teardown",
        );
      }
    }
  }

  /**
   * One reconcile pass: sync observed state for live runners and stop the ones
   * whose TTL or idle timeout has elapsed.
   */
  async reconcileAll(): Promise<void> {
    if (!this.isEnabled) return;

    const live = await RunnerModel.listLive();
    // Report every non-terminal state each pass, including the ones now at
    // zero, so a state that empties clears instead of holding its last sample.
    const counts: Record<string, number> = {
      pending: 0,
      provisioning: 0,
      running: 0,
      stopping: 0,
    };
    for (const runner of live) {
      counts[runner.state] = (counts[runner.state] ?? 0) + 1;
    }
    reportRunnerStates(counts);

    for (const runner of live) {
      await this.reconcileOne(runner).catch((error) => {
        logger.warn(
          { error, runnerId: runner.id },
          "Failed to reconcile a runner",
        );
      });
    }

    for (const runner of await RunnerModel.listExpired(new Date())) {
      const expiry = describeExpiry(runner);
      await this.stop(runner, expiry.reason, expiry.outcome).catch((error) => {
        logger.warn(
          { error, runnerId: runner.id },
          "Failed to stop an expired runner",
        );
      });
    }
  }

  /**
   * Stop a runner and record why. The transition is claimed first, so two
   * replicas reconciling at once cannot both tear the same session down.
   */
  async stop(
    runner: Runner,
    reason: string,
    outcome:
      | "stopped_by_user"
      | "expired_ttl"
      | "expired_idle" = "stopped_by_user",
  ): Promise<void> {
    const claimed = await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "stopping",
      from: ["pending", "provisioning", "running"],
      statusReason: reason,
    });
    if (!claimed) return;

    await this.withRunnerLease(runner, async () => {
      await this.teardown(runner);
    });

    await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "stopped",
      statusReason: reason,
    });
    reportRunnerTerminated(outcome);
    await RunnerEventModel.append({
      runnerId: runner.id,
      kind: "state_changed",
      message: reason,
      payload: { state: "stopped" },
    });
  }

  // ===================== internals =====================

  private async applyPlatformEgressPolicy(
    spec: RunnerLaunchSpec,
  ): Promise<void> {
    const clients = this.requireClients();
    const body = buildRunnerPlatformEgressPolicy({
      spec,
      platformNamespace: process.env.POD_NAMESPACE || getK8sNamespace(),
      platformPodLabels: config.runners.platformPodSelector,
      platformPorts: [config.api.port],
    });
    try {
      await clients.networkingApi.createNamespacedNetworkPolicy({
        namespace: spec.namespace,
        body,
      });
    } catch (error) {
      if (!isK8sConflictError(error)) throw error;
      await clients.networkingApi.replaceNamespacedNetworkPolicy({
        name: body.metadata?.name ?? "",
        namespace: spec.namespace,
        body,
      });
    }
  }

  /**
   * Bring one runner's recorded state in line with what the cluster shows.
   * Only observations move state here — a runner is never marked running
   * because we hoped it would be.
   */
  private async reconcileOne(runner: Runner): Promise<void> {
    if (!runner.deploymentName) return;
    const clients = this.requireClients();
    const namespace = runner.namespace ?? getK8sNamespace();
    const names = runnerNames(runner.deploymentName);

    let job: k8s.V1Job;
    try {
      job = await clients.batchApi.readNamespacedJob({
        name: names.job,
        namespace,
      });
    } catch (error) {
      if (!isK8sNotFoundError(error)) throw error;
      // The workload is gone but the row still expects it. Say so plainly
      // instead of leaving a runner that looks alive forever.
      await this.markFailed(
        runner,
        "The runner's workload is no longer present",
      );
      return;
    }

    if ((job.status?.succeeded ?? 0) > 0) {
      await this.finish(runner, "The agent session finished");
      return;
    }
    if ((job.status?.failed ?? 0) > 0) {
      await this.markFailed(runner, describeJobFailure(job));
      return;
    }
    if ((job.status?.active ?? 0) > 0 && runner.state !== "running") {
      const podName = await this.findPodName(runner);
      if (!podName) return;
      const started = await RunnerModel.transition({
        id: runner.id,
        organizationId: runner.organizationId,
        to: "running",
        from: ["pending", "provisioning"],
      });
      if (started) {
        reportRunnerProvisioned(
          (Date.now() - runner.createdAt.getTime()) / 1000,
        );
        await RunnerEventModel.append({
          runnerId: runner.id,
          kind: "state_changed",
          message: "Session is running",
          payload: { state: "running", pod: podName },
        });
      }
    }
  }

  private async finish(runner: Runner, reason: string): Promise<void> {
    const claimed = await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "stopping",
      from: ["pending", "provisioning", "running"],
      statusReason: reason,
    });
    if (!claimed) return;
    await this.teardown(runner);
    await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "stopped",
      statusReason: reason,
    });
    reportRunnerTerminated("completed");
    await RunnerEventModel.append({
      runnerId: runner.id,
      kind: "state_changed",
      message: reason,
      payload: { state: "stopped" },
    });
  }

  private async markFailed(runner: Runner, reason: string): Promise<void> {
    const claimed = await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "failed",
      from: ["pending", "provisioning", "running", "stopping"],
      statusReason: reason,
    });
    if (!claimed) return;
    await this.teardown(runner);
    reportRunnerTerminated("failed");
    await RunnerEventModel.append({
      runnerId: runner.id,
      kind: "state_changed",
      message: reason,
      payload: { state: "failed" },
    });
  }

  /**
   * Serialize a runner's cluster mutations across replicas. A lease already
   * held elsewhere means another replica is doing this work, so we skip rather
   * than duplicate it.
   */
  private async withRunnerLease(
    runner: Runner,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await McpDeploymentLeaseModel.withLease(
        { scope: RUNNER_LEASE_SCOPE, key: runner.id },
        async (lease) => {
          await operation();
          await lease.assertOwned();
        },
      );
    } catch (error) {
      if (error instanceof ClusterLeaseHeldError) return;
      throw error;
    }
  }

  private async execInPod(params: {
    runner: Runner;
    podName: string;
    command: string[];
  }): Promise<void> {
    const clients = this.requireClients();
    const namespace = params.runner.namespace ?? getK8sNamespace();
    const { PassThrough } = await import("node:stream");
    const stderr = new PassThrough();
    const stderrChunks: Buffer[] = [];
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    await new Promise<void>((resolve, reject) => {
      clients.exec
        .exec(
          namespace,
          params.podName,
          "runner",
          params.command,
          null,
          stderr,
          null,
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

  private requireClients(): K8sClients {
    if (!this.isEnabled) {
      throw new Error("Runner runtime is not enabled");
    }
    if (!this.clients) {
      const namespace = getK8sNamespace();
      this.clients = createK8sClients(loadKubeConfig().kubeConfig, namespace);
    }
    return this.clients;
  }
}

export default new RunnerRuntimeManager();

/** @public — used by the convergence sweep and by tests. */
export { RUNNER_MANAGED_SELECTOR };

// ===================== helpers =====================

/**
 * Which clock fired. Both can be configured, so the idle one is only reported
 * when it has actually elapsed — otherwise a runner with both set would always
 * be described as idle, even when it simply ran out of lifetime.
 */
function describeExpiry(runner: Runner): {
  reason: string;
  outcome: "expired_ttl" | "expired_idle";
} {
  const idleElapsed =
    runner.idleTimeoutMinutes &&
    runner.lastActivityAt &&
    Date.now() - runner.lastActivityAt.getTime() >=
      runner.idleTimeoutMinutes * 60 * 1000;
  if (idleElapsed) {
    return {
      reason: `Stopped after ${runner.idleTimeoutMinutes} minutes without activity`,
      outcome: "expired_idle",
    };
  }
  return {
    reason: `Stopped after reaching its ${runner.ttlHours}-hour lifetime`,
    outcome: "expired_ttl",
  };
}

function describeJobFailure(job: k8s.V1Job): string {
  const condition = job.status?.conditions?.find(
    (entry) => entry.type === "Failed" && entry.status === "True",
  );
  return condition?.message ?? "The agent session failed";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
