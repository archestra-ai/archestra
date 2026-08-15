// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import * as k8s from "@kubernetes/client-node";
import config from "@/config";
import { getMcpImagePullPolicy } from "@/k8s/mcp-server-runtime/image-pull-policy";
import {
  createK8sClients,
  getK8sNamespace,
  isK8sConfigured,
  isK8sConflictError,
  isK8sNotFoundError,
  loadKubeConfig,
} from "@/k8s/shared";
import logger from "@/logging";
import {
  buildP4ShimDeployment,
  buildP4ShimIngressRule,
  buildP4ShimNetworkPolicy,
  buildP4ShimService,
  buildP4ShimTokenSecret,
  P4_SHIM_CONFIG_ANNOTATION,
  P4_SHIM_PORT,
  P4_SHIM_RETIRED_ANNOTATIONS,
  P4_SHIM_SCOPE_LABEL,
  type P4ShimEgressTarget,
  p4ShimNames,
  p4ShimSelector,
} from "./manifests";

/** Where and how to reach a ready, provisioned shim. */
export interface P4ShimTarget {
  baseUrl: string;
  authToken: string;
}

/** One Perforce server the shim must be able to reach. */
interface P4ShimServerTarget {
  host: string;
  port: number;
}

/** Everything one connector's shim is reconciled from. */
interface P4ShimSpec {
  /** The connector id — this shim serves exactly one connector. */
  connectorId: string;
  organizationId: string;
  /** The single Perforce server this connector's shim may reach. */
  server: P4ShimServerTarget;
  /**
   * Digest of the connector's identity-affecting settings. A change rolls the
   * pod and rotates its token, so nothing from the previous configuration
   * survives.
   */
  configFingerprint: string;
  /**
   * Re-read the connector's settings and report whether `configFingerprint` is
   * still what they digest to. Consulted immediately before the reconcile
   * writes, because the caller's fingerprint may be minutes old (see
   * {@link P4ShimRuntimeManager.ensure}).
   */
  configIsCurrent: () => Promise<boolean>;
  /**
   * Whether the caller still holds the run that authorises this reconcile.
   *
   * The fingerprint fence catches a caller holding RETIRED settings; this
   * catches one holding current settings it is simply no longer entitled to
   * act on — a worker thawing after its lease was reclaimed, which would
   * otherwise unpark a shim, re-provision it, and drive commands against the
   * customer's Perforce server on behalf of a run that ended long ago.
   *
   * Omitted by callers that legitimately hold no run, such as Test Connection.
   */
  callerOwnsRun?: () => Promise<boolean>;
}

/**
 * Lifecycle manager for the p4 shims — the per-tenant auxiliary Deployments
 * that execute allowlisted Perforce commands for knowledge-base permission
 * sync (see `manifests.ts` for the tenancy and isolation model,
 * `p4_shim_docker_image/` for the pod contract).
 *
 * **A shim exists exactly while its connector wants one.** There is no idle
 * state, no parking and no scaling: the Deployment is either absent or running
 * at one replica. `apply(spec)` brings the objects into being (and rolls them
 * onto new settings); `teardown(scope)` removes them. Both are idempotent and
 * fast enough for a connector write surface to await inside the request that
 * changed the connector, which is what makes the pod's lifetime a property of
 * the connector row rather than of when a pass last happened to run.
 *
 * `ensure(spec)` is what a *caller of the shim* uses: it applies the same
 * objects, then waits for the rollout, provisions the `p4` binary if the pod
 * hasn't got one (fresh pod or restart — /work is an emptyDir), completes the
 * egress half of the isolation policy, and returns the reachable target. It
 * re-applies rather than assuming, so a shim deleted out of band heals on the
 * next pass instead of failing until someone edits the connector.
 *
 * The proprietary `p4` binary never ships in an Archestra image: the backend
 * downloads it here (pinned URL + sha256 from config, overridable for
 * air-gapped installs) and pushes it over the in-cluster channel, keeping the
 * shim's egress pinned to the Perforce server alone.
 */
class P4ShimRuntimeManager {
  private ensureInFlight = new Map<string, Promise<P4ShimTarget>>();

  isEnabled(): boolean {
    return isK8sConfigured();
  }

  /**
   * Bring one connector's shim objects to the state its settings describe:
   * token Secret, isolation policy, Deployment at one replica, Service.
   *
   * Waits for nothing — a handful of API calls — so the request that changed
   * the connector can await it without hanging on pod scheduling or an image
   * pull. Readiness, the `p4` binary and the egress half of the policy need
   * the pod itself to answer, and {@link ensure} does those on first use.
   *
   * A pod created here is fail-closed until then: its policy starts with DNS
   * egress only, so it can reach nothing, including the Perforce server.
   */
  async apply(spec: P4ShimSpec): Promise<void> {
    if (!this.isEnabled()) return;
    await this.applyObjects(spec);
  }

  /**
   * Reconcile one connector's shim to reach exactly its server and return its
   * target. Single-flighted per connector and fingerprint: concurrent passes
   * for the same settings share one reconcile, while different connectors
   * never block each other.
   *
   * Refuses a fingerprint the connector's settings no longer produce. A
   * permission pass reads those settings once and replays them for its whole
   * duration, so an edit landing mid-pass leaves the pass holding retired
   * settings — and applying them would undo the rotation the edit just caused:
   * roll the pod back, restore the retired token, and re-open egress to the
   * previous server. The connector row is the authority, so `configIsCurrent`
   * re-reads it rather than trusting anything cached in this process.
   */
  async ensure(spec: P4ShimSpec): Promise<P4ShimTarget> {
    if (!this.isEnabled()) {
      throw new Error(
        "Perforce permission sync requires the Kubernetes orchestrator to be configured",
      );
    }
    // Keyed by connector AND fingerprint: an edit mid-pass must not be handed
    // the in-flight reconcile of the configuration it replaced.
    const key = `${spec.connectorId}|${spec.configFingerprint}`;
    const inFlight = this.ensureInFlight.get(key);
    if (inFlight) return inFlight;
    const reconcile = this.reconcile(spec).finally(() => {
      this.ensureInFlight.delete(key);
    });
    this.ensureInFlight.set(key, reconcile);
    return reconcile;
  }

  /** Delete every resource of one scope's shim. 404s are success (idempotent). */
  async teardown(scope: string): Promise<void> {
    if (!this.isEnabled()) return;
    const namespace = getK8sNamespace();
    const clients = createK8sClients(loadKubeConfig().kubeConfig, namespace);
    const names = p4ShimNames(scope);
    const deletions: Array<[string, () => Promise<unknown>]> = [
      [
        "Deployment",
        () =>
          clients.appsApi.deleteNamespacedDeployment({
            name: names.deployment,
            namespace,
          }),
      ],
      [
        "Service",
        () =>
          clients.coreApi.deleteNamespacedService({
            name: names.service,
            namespace,
          }),
      ],
      [
        "Secret",
        () =>
          clients.coreApi.deleteNamespacedSecret({
            name: names.secret,
            namespace,
          }),
      ],
      [
        "NetworkPolicy",
        () =>
          clients.networkingApi.deleteNamespacedNetworkPolicy({
            name: names.networkPolicy,
            namespace,
          }),
      ],
    ];
    for (const [kind, del] of deletions) {
      try {
        await del();
      } catch (error) {
        if (!isK8sNotFoundError(error)) {
          logger.warn(
            { err: error, kind, namespace, scope },
            "[P4Shim] failed to delete shim resource on teardown",
          );
        }
      }
    }
    logger.info({ namespace, scope }, "[P4Shim] shim torn down");
  }

  /**
   * Every shim in the cluster: the connector it belongs to, and how long its
   * Deployment has existed.
   *
   * The input to the convergence sweep — comparing this against the connectors
   * that want a shim is what turns an event-driven lifecycle into one that
   * converges, so a teardown lost to a restart or a network partition is not
   * lost forever. The age is carried because the sweep's only irreversible
   * action is deletion, and the youngest shims are the ones most likely to
   * belong to a caller it does not model (see the handler).
   */
  async listShims(): Promise<Array<{ scope: string; ageMs: number }>> {
    if (!this.isEnabled()) return [];
    const namespace = getK8sNamespace();
    const clients = createK8sClients(loadKubeConfig().kubeConfig, namespace);
    const deployments = await clients.appsApi.listNamespacedDeployment({
      namespace,
      labelSelector: p4ShimSelector(),
    });
    const now = Date.now();
    const shims: Array<{ scope: string; ageMs: number }> = [];
    for (const deployment of deployments.items) {
      const scope = deployment.metadata?.labels?.[P4_SHIM_SCOPE_LABEL];
      if (!scope) continue;
      const created = deployment.metadata?.creationTimestamp;
      // An unparseable timestamp reads as ancient, never as brand new: the
      // grace it feeds is a courtesy, and a shim that cannot prove it is young
      // should not be able to outlive the sweep by failing to say so.
      const createdAt = created ? new Date(created).getTime() : Number.NaN;
      shims.push({
        scope,
        ageMs: Number.isFinite(createdAt) ? now - createdAt : Infinity,
      });
    }
    return shims;
  }

  // ===== Private methods =====

  private async reconcile(spec: P4ShimSpec): Promise<P4ShimTarget> {
    const scope = spec.connectorId;
    const servers = [spec.server];
    const applied = await this.applyObjects(spec);
    const { clients, namespace, inCluster, authToken, generation } = applied;
    let { clientAddresses } = applied;

    const baseUrl = await this.resolveBaseUrl(
      clients.coreApi,
      namespace,
      scope,
      inCluster,
    );
    // Before any request to the Service: until the controller has acted on the
    // write above, the only pod behind it is the one that write retires.
    await this.waitForRollout(clients.appsApi, namespace, scope, generation);
    let peer: string | null;
    try {
      peer = await this.waitReadyAndProvision(baseUrl, authToken);
    } catch (error) {
      if (!(error instanceof StaleShimTokenError)) throw error;
      // Recover rather than fail: the pod is unusable and will stay unusable
      // for its whole life, so replacing it is the only way through. Deleting
      // the pod (not the Deployment) has the ReplicaSet build a fresh one,
      // which mounts the Secret as it stands now.
      logger.warn(
        { connectorId: scope },
        "[P4Shim] pod holds a retired token; replacing it",
      );
      await this.deletePods(clients.coreApi, namespace, scope);
      await this.waitForRollout(clients.appsApi, namespace, scope, generation);
      peer = await this.waitReadyAndProvision(baseUrl, authToken);
    }
    // Re-checked after the wait, which can take a minute or more: the egress
    // rule below is the reach this shim is granted, and writing the previous
    // settings' server here would be the one stale write that outlives the
    // pass. A reconcile for the new fingerprint follows and rewrites the rest.
    await this.assertConfigIsCurrent(spec);
    // Only now can the policy be finished, because only the running pod can
    // say which addresses it will actually dial (see resolveEgressTargets) and
    // which address the platform's own traffic arrives from.
    if (peer && !clientAddresses.includes(peer)) {
      clientAddresses = [...clientAddresses, peer];
    }
    await this.applyNetworkPolicy(clients.networkingApi, namespace, {
      scope,
      egressTargets: await this.resolveEgressTargets({
        baseUrl,
        authToken,
        servers,
      }),
      inCluster,
      clientAddresses,
    });
    return { baseUrl, authToken };
  }

  /**
   * The write half of a reconcile: everything that can be applied without the
   * pod's cooperation. Shared by {@link apply} — which stops here — and
   * {@link reconcile}, which goes on to wait for the pod and finish the parts
   * only it can answer.
   */
  private async applyObjects(spec: P4ShimSpec): Promise<{
    clients: ReturnType<typeof createK8sClients>;
    namespace: string;
    inCluster: boolean;
    authToken: string;
    generation: number;
    clientAddresses: string[];
  }> {
    const scope = spec.connectorId;
    const namespace = getK8sNamespace();
    const { kubeConfig } = loadKubeConfig();
    const clients = createK8sClients(kubeConfig, namespace);
    const inCluster =
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster;

    // Before the first write. Everything below rotates state the connector's
    // current settings own — the token, the pod template, the egress rule.
    await this.assertConfigIsCurrent(spec);

    const authToken = await this.ensureTokenSecret(
      clients.coreApi,
      namespace,
      spec,
    );
    // The NetworkPolicy precedes the Deployment so a fresh pod is never
    // schedulable without its isolation already in force. A policy left by an
    // earlier reconcile is kept as-is: it already carries that reconcile's
    // resolved egress, so a running pod keeps its Perforce access while this
    // pass re-resolves. A brand-new policy starts with DNS egress only, and —
    // out of cluster — with no ingress at all until the node addresses resolve.
    const clientAddresses = inCluster
      ? []
      : await this.resolveClientAddresses(clients.coreApi, kubeConfig);
    await this.ensureNetworkPolicy(clients.networkingApi, namespace, {
      scope,
      inCluster,
      clientAddresses,
    });
    const generation = await this.applyDeployment(
      clients.appsApi,
      namespace,
      spec,
      authToken,
    );
    await this.applyService(clients.coreApi, namespace, scope, inCluster);
    return {
      clients,
      namespace,
      inCluster,
      authToken,
      generation,
      clientAddresses,
    };
  }

  /**
   * Refuse to reconcile settings the connector no longer has. Thrown rather
   * than returned: the caller is a permission pass whose every remaining step
   * would run against the same retired settings, so failing it is the correct
   * outcome — the update that retired them queues a replacement pass.
   */
  private async assertConfigIsCurrent(spec: P4ShimSpec): Promise<void> {
    if (spec.callerOwnsRun && !(await spec.callerOwnsRun())) {
      logger.info(
        { connectorId: spec.connectorId },
        "[P4Shim] refused a reconcile for a run that is no longer owned",
      );
      throw new Error(
        "This permission sync no longer owns its run; a newer pass owns the connector.",
      );
    }
    if (await spec.configIsCurrent()) return;
    logger.info(
      { connectorId: spec.connectorId },
      "[P4Shim] refused a reconcile for settings the connector no longer has",
    );
    throw new Error(
      "The Perforce connector's settings changed while this permission sync was running; a fresh pass will run against the new settings.",
    );
  }

  private async ensureTokenSecret(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    spec: P4ShimSpec,
  ): Promise<string> {
    const name = p4ShimNames(spec.connectorId).secret;
    try {
      const existing = await coreApi.readNamespacedSecret({ name, namespace });
      const stored = existing.data?.token;
      // A token minted for the previous configuration is retired with it: the
      // pod rolls on a fingerprint change anyway, so its access token should
      // not be the one thing that carries across.
      const mintedFor =
        existing.metadata?.annotations?.[P4_SHIM_CONFIG_ANNOTATION];
      if (stored && mintedFor === spec.configFingerprint) {
        return Buffer.from(stored, "base64").toString("utf8");
      }
      if (stored) {
        const rotated = randomBytes(32).toString("hex");
        const body = buildP4ShimTokenSecret({
          scope: spec.connectorId,
          token: rotated,
          configFingerprint: spec.configFingerprint,
        });
        // Carry the version this decision was made on, so two replicas
        // rotating for the same new fingerprint cannot both mint: the loser
        // gets a 409 and adopts the winner's token, rather than replacing a
        // token a pod may already be holding. The same rule the create path
        // below follows.
        body.metadata = {
          ...body.metadata,
          resourceVersion: existing.metadata?.resourceVersion,
        };
        try {
          await coreApi.replaceNamespacedSecret({ name, namespace, body });
        } catch (error) {
          if (!isK8sConflictError(error)) throw error;
          const winner = await coreApi.readNamespacedSecret({
            name,
            namespace,
          });
          const winning = winner.data?.token;
          if (!winning) {
            throw new Error("p4 shim token secret exists but is empty");
          }
          logger.info(
            { connectorId: spec.connectorId },
            "[P4Shim] another replica rotated this shim's token first; adopting it",
          );
          return Buffer.from(winning, "base64").toString("utf8");
        }
        logger.info(
          { connectorId: spec.connectorId },
          "[P4Shim] connector settings changed — rotated the shim token",
        );
        return rotated;
      }
    } catch (error) {
      if (!isK8sNotFoundError(error)) throw error;
    }
    const token = randomBytes(32).toString("hex");
    try {
      await coreApi.createNamespacedSecret({
        namespace,
        body: buildP4ShimTokenSecret({
          scope: spec.connectorId,
          token,
          configFingerprint: spec.configFingerprint,
        }),
      });
    } catch (error) {
      if (!isK8sConflictError(error)) throw error;
      // Lost a create race — the winner's token is the real one.
      const winner = await coreApi.readNamespacedSecret({ name, namespace });
      const stored = winner.data?.token;
      if (!stored) throw new Error("p4 shim token secret exists but is empty");
      return Buffer.from(stored, "base64").toString("utf8");
    }
    return token;
  }

  /** Create the Deployment, or roll the existing one onto this spec. */
  private async applyDeployment(
    appsApi: k8s.AppsV1Api,
    namespace: string,
    spec: P4ShimSpec,
    authToken: string,
  ): Promise<number> {
    const body = buildP4ShimDeployment({
      scope: spec.connectorId,
      organizationId: spec.organizationId,
      image: config.kb.perforceShim.image,
      imagePullPolicy:
        getMcpImagePullPolicy(config.kb.perforceShim.image) ?? "IfNotPresent",
      authToken,
      configFingerprint: spec.configFingerprint,
    });
    try {
      const created = await appsApi.createNamespacedDeployment({
        namespace,
        body,
      });
      return created.metadata?.generation ?? 0;
    } catch (error) {
      if (!isK8sConflictError(error)) throw error;
      // Rolls image/spec changes forward and — when the connector's settings
      // or its token changed — replaces the pod template annotations, which is
      // what makes Kubernetes discard the old pod and its /work contents
      // rather than reuse them.
      const patched = await appsApi.patchNamespacedDeployment(
        {
          name: p4ShimNames(spec.connectorId).deployment,
          namespace,
          body: {
            metadata: {
              ...body.metadata,
              // The nulls delete keys an older build wrote; see the constant.
              // Cast because the generated model types annotations as
              // string-valued, which a merge patch deliberately is not.
              annotations: {
                ...P4_SHIM_RETIRED_ANNOTATIONS,
                ...(body.metadata?.annotations ?? {}),
              } as Record<string, string>,
            },
            spec: body.spec,
          },
        },
        k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
      );
      // The generation this write produced. Everything after it must wait for
      // the controller to have acted on THIS spec, or it would be talking to
      // the pod this write is retiring.
      return patched.metadata?.generation ?? 0;
    }
  }

  /**
   * Block until the Deployment's controller has acted on `generation` and the
   * pods it reports Ready are the ones that generation describes.
   *
   * Without this the very next statement probes a Service whose only endpoint
   * is still the pod being replaced: it answers `/healthz`, reports itself
   * provisioned, and holds the token that was just retired — so the reconcile
   * skips the binary push and the first real command fails against a pod that
   * no longer exists. `observedGeneration` is the controller's acknowledgement;
   * `updatedReplicas` is how many pods match the new template.
   */
  private async waitForRollout(
    appsApi: k8s.AppsV1Api,
    namespace: string,
    scope: string,
    generation: number,
  ): Promise<void> {
    const name = p4ShimNames(scope).deployment;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = "";
    while (Date.now() < deadline) {
      const current = await appsApi.readNamespacedDeployment({
        name,
        namespace,
      });
      const status = current.status ?? {};
      const desired = current.spec?.replicas ?? 0;
      last = `observed=${status.observedGeneration ?? 0}/${generation} updated=${status.updatedReplicas ?? 0} ready=${status.readyReplicas ?? 0} desired=${desired}`;
      if (
        (status.observedGeneration ?? 0) >= generation &&
        (status.updatedReplicas ?? 0) === desired &&
        (status.readyReplicas ?? 0) === desired &&
        (status.replicas ?? 0) === desired
      ) {
        return;
      }
      await sleep(1_000);
    }
    throw new Error(
      `p4 shim rollout did not complete within ${READY_TIMEOUT_MS / 1000}s (${last})`,
    );
  }

  private async applyService(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    scope: string,
    inCluster: boolean,
  ): Promise<void> {
    try {
      await coreApi.createNamespacedService({
        namespace,
        body: buildP4ShimService({ scope, inCluster }),
      });
    } catch (error) {
      if (!isK8sConflictError(error)) throw error;
    }
  }

  /**
   * Put the isolation policy in force before the pod can be scheduled, with an
   * authoritative ingress rule.
   *
   * Ingress is rewritten on every reconcile because it is computed without
   * contacting the pod, and because a stale rule is self-sealing: the platform
   * cannot reach the shim, so it never finishes the reconcile that would have
   * corrected the rule. Egress is deliberately left as it stands — the merge
   * patch touches `spec.ingress` alone — so a running pod keeps its Perforce
   * access until the pod-side resolution at the end of this reconcile can
   * rewrite it.
   */
  private async ensureNetworkPolicy(
    networkingApi: k8s.NetworkingV1Api,
    namespace: string,
    params: {
      scope: string;
      inCluster: boolean;
      clientAddresses: string[];
    },
  ): Promise<void> {
    const ingress = buildP4ShimIngressRule({
      restrictIngressToClientPods: params.inCluster,
      clientAddresses: params.clientAddresses,
    });
    try {
      await networkingApi.createNamespacedNetworkPolicy({
        namespace,
        body: buildP4ShimNetworkPolicy({
          scope: params.scope,
          egressTargets: [],
          restrictIngressToClientPods: params.inCluster,
          clientAddresses: params.clientAddresses,
        }),
      });
    } catch (error) {
      if (!isK8sConflictError(error)) throw error;
      await networkingApi.patchNamespacedNetworkPolicy(
        {
          name: p4ShimNames(params.scope).networkPolicy,
          namespace,
          body: { spec: { ingress: ingress ? [ingress] : [] } },
        },
        k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
      );
    }
  }

  private async applyNetworkPolicy(
    networkingApi: k8s.NetworkingV1Api,
    namespace: string,
    params: {
      scope: string;
      egressTargets: P4ShimEgressTarget[];
      inCluster: boolean;
      clientAddresses: string[];
    },
  ): Promise<void> {
    const body = buildP4ShimNetworkPolicy({
      scope: params.scope,
      egressTargets: params.egressTargets,
      restrictIngressToClientPods: params.inCluster,
      clientAddresses: params.clientAddresses,
    });
    const name = p4ShimNames(params.scope).networkPolicy;
    try {
      await networkingApi.replaceNamespacedNetworkPolicy({
        name,
        namespace,
        body,
      });
    } catch (error) {
      if (!isK8sNotFoundError(error)) throw error;
      await networkingApi.createNamespacedNetworkPolicy({ namespace, body });
    }
  }

  /**
   * Out-of-cluster only: the addresses the platform's traffic carries once it
   * has crossed the NodePort. NodePort traffic from outside the cluster is
   * source-NATed to the node it entered through, so the node addresses are
   * what an ingress rule must name — the backend's own address never reaches
   * the pod.
   *
   * Falls back to the configured node host when the API server will not list
   * nodes (a kubeconfig without cluster-scope read). An empty result is
   * deliberately left empty: `buildP4ShimNetworkPolicy` then admits nobody,
   * which fails the pass loudly instead of leaving the shim open to the
   * cluster.
   */
  private async resolveClientAddresses(
    coreApi: k8s.CoreV1Api,
    kubeConfig: k8s.KubeConfig,
  ): Promise<string[]> {
    const addresses = new Set<string>();
    // The authoritative answer: the address this process carries when it
    // talks to the cluster. Measured live on kindnet — the policy engine
    // matches the platform's ORIGINAL source (the host, 172.18.0.1), not the
    // node's InternalIP and not the masqueraded address the pod itself
    // reports (10.244.0.1). Only the socket knows it.
    const ownAddress = await this.resolveOwnClusterAddress(kubeConfig);
    if (ownAddress) addresses.add(ownAddress);
    try {
      const nodes = await coreApi.listNode();
      for (const node of nodes.items) {
        for (const address of node.status?.addresses ?? []) {
          if (address.type === "InternalIP" && address.address) {
            addresses.add(address.address);
          }
        }
      }
    } catch (error) {
      logger.warn(
        { err: error },
        "[P4Shim] could not list nodes for the shim ingress rule; falling back to the configured node host",
      );
    }
    const nodeHost = config.orchestrator.kubernetes.k8sNodeHost;
    if (nodeHost) {
      for (const address of await this.resolveHost(nodeHost)) {
        addresses.add(address);
      }
    }
    // Node addresses stay in the set because a CNI that source-NATs before
    // evaluating policy presents one of those instead of the platform's own.
    // Every entry is a single host address, never a range.
    if (addresses.size === 0) {
      logger.error(
        "[P4Shim] no node addresses resolved; the shim will admit no ingress until they can be determined",
      );
    }
    return [...addresses];
  }

  /**
   * The source address this process carries when it reaches the node, which is
   * what the cluster's policy engine matches an ingress rule against.
   *
   * Measured with a UDP route lookup rather than a real connection: `connect`
   * on a datagram socket only asks the kernel which route and source address
   * it would use, so it needs no listener and sends no packet — and so it
   * works before the very ingress rule it is computing exists.
   *
   * It deliberately targets the node host, not the API server: kind writes a
   * kubeconfig pointing at 127.0.0.1, and the loopback source address that
   * yields is useless in a policy (verified — it admits nothing).
   */
  private async resolveOwnClusterAddress(
    kubeConfig: k8s.KubeConfig,
  ): Promise<string | null> {
    const target =
      config.orchestrator.kubernetes.k8sNodeHost ||
      apiServerHost(kubeConfig.getCurrentCluster()?.server);
    if (!target) return null;
    const [address] = await this.resolveHost(target);
    if (!address) return null;
    return new Promise((resolve) => {
      const socket = createSocket(address.includes(":") ? "udp6" : "udp4");
      const finish = (result: string | null) => {
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        resolve(result);
      };
      socket.once("error", () => finish(null));
      try {
        socket.connect(ROUTE_LOOKUP_PORT, address, () => {
          try {
            finish(socket.address().address);
          } catch {
            finish(null);
          }
        });
      } catch {
        finish(null);
      }
    });
  }

  /**
   * Resolve every Perforce host to the addresses the egress policy will
   * allow, asking the SHIM POD to do the lookups.
   *
   * The pod's resolver is the authority: a NetworkPolicy can only name IP
   * addresses, and the only addresses the pod can dial are the ones its own
   * resolver returns. Resolving here in the backend — which sits in a
   * different DNS view whenever cluster DNS, search domains or split-horizon
   * zones differ — pins addresses the pod may never see, and the shim then
   * fails to reach a server it is supposed to be allowed to reach.
   *
   * A host that does not resolve yields no addresses, so the policy permits
   * nothing for it and the pass fails visibly rather than silently opening up.
   */
  private async resolveEgressTargets(params: {
    baseUrl: string;
    authToken: string;
    servers: P4ShimServerTarget[];
  }): Promise<P4ShimEgressTarget[]> {
    const hosts = [...new Set(params.servers.map((server) => server.host))];
    const resolved =
      (await this.resolveHostsInPod({ ...params, hosts })) ??
      (await this.resolveHostsLocally(hosts));
    return params.servers.map((server) => ({
      ips: resolved[server.host] ?? [],
      port: server.port,
    }));
  }

  /** Ask the pod to resolve; null when the shim cannot answer. */
  private async resolveHostsInPod(params: {
    baseUrl: string;
    authToken: string;
    hosts: string[];
  }): Promise<Record<string, string[]> | null> {
    try {
      const response = await fetch(`${params.baseUrl}/resolve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ hosts: params.hosts }),
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`shim /resolve returned ${response.status}`);
      }
      const body = (await response.json()) as {
        resolved?: Record<string, unknown>;
      };
      const resolved: Record<string, string[]> = {};
      for (const host of params.hosts) {
        const addresses = body.resolved?.[host];
        if (!Array.isArray(addresses)) return null;
        resolved[host] = addresses.filter(
          (address): address is string => typeof address === "string",
        );
      }
      return resolved;
    } catch (error) {
      logger.warn(
        { err: error },
        "[P4Shim] pod-side DNS resolution unavailable, falling back to backend DNS for the egress policy",
      );
      return null;
    }
  }

  /**
   * Fallback for a shim image that predates `/resolve`: the backend's own DNS
   * view. Correct only where backend and pod resolve alike.
   */
  private async resolveHostsLocally(
    hosts: string[],
  ): Promise<Record<string, string[]>> {
    const resolved: Record<string, string[]> = {};
    for (const host of hosts) {
      resolved[host] = await this.resolveHost(host);
    }
    return resolved;
  }

  private async resolveHost(host: string): Promise<string[]> {
    try {
      const results = await lookup(host, { all: true });
      return [...new Set(results.map((entry) => entry.address))];
    } catch (error) {
      logger.warn({ err: error, host }, "[P4Shim] could not resolve host");
      return [];
    }
  }

  private async resolveBaseUrl(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    scope: string,
    inCluster: boolean,
  ): Promise<string> {
    const name = p4ShimNames(scope).service;
    if (inCluster) {
      const clusterDomain =
        config.orchestrator.kubernetes.clusterDomain || "cluster.local";
      return `http://${name}.${namespace}.svc.${clusterDomain}:${P4_SHIM_PORT}`;
    }
    // Out-of-cluster (local dev / quickstart): the Service is a NodePort;
    // read back the assigned port.
    const service = await coreApi.readNamespacedService({ name, namespace });
    const nodePort = service.spec?.ports?.[0]?.nodePort;
    if (!nodePort) {
      throw new Error("p4 shim NodePort service has no assigned nodePort");
    }
    const host = config.orchestrator.kubernetes.k8sNodeHost || "localhost";
    return `http://${host}:${nodePort}`;
  }

  /**
   * Poll /healthz until the pod answers, then push the pinned `p4` binary if
   * the pod reports itself unprovisioned (a fresh pod or a restart — /work is
   * pod-lifetime only).
   */
  private async waitReadyAndProvision(
    baseUrl: string,
    authToken: string,
  ): Promise<string | null> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/healthz`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Not up yet.
      }
      await sleep(2_000);
    }
    if (!ready) {
      throw new Error(
        `p4 shim did not become ready at ${baseUrl} within ${READY_TIMEOUT_MS / 1000}s`,
      );
    }

    // Provisioning state is behind the token: /healthz answers the kubelet and
    // says nothing about what the pod holds.
    const statusResponse = await fetch(`${baseUrl}/status`, {
      headers: { authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!statusResponse.ok) {
      // A 401 means the pod is holding a token this reconcile did not mint —
      // it booted before the Secret was rewritten. The pod template carries a
      // digest of the current token so this should be impossible, but if it
      // ever happens the shim is wedged for as long as the pod lives — which
      // is forever, since nothing else restarts it. Reported distinctly so the
      // failure names its own remedy rather than reading as a generic outage.
      if (statusResponse.status === 401) {
        throw new StaleShimTokenError(
          "The Perforce shim pod is holding a retired access token; it will be replaced on the next pass.",
        );
      }
      throw new Error(
        `p4 shim status request failed (${statusResponse.status})`,
      );
    }
    const status = (await statusResponse.json()) as P4ShimStatus;
    const peer = normalizePeer(status.peer);
    logger.debug(
      { peer, provisioned: status.provisioned },
      "[P4Shim] shim reached",
    );
    if (status.provisioned) return peer;

    const arch = status.arch === "arm64" ? "arm64" : "x64";
    const { url, sha256 } = config.kb.perforceShim.p4Binary[arch];
    logger.info({ url, arch }, "[P4Shim] provisioning p4 binary");
    const download = await fetch(url, {
      signal: AbortSignal.timeout(P4_DOWNLOAD_TIMEOUT_MS),
    });
    if (!download.ok) {
      throw new Error(
        `p4 binary download failed (${download.status}) from ${url}`,
      );
    }
    const binary = Buffer.from(await download.arrayBuffer());
    const actualSha = createHash("sha256").update(binary).digest("hex");
    if (actualSha !== sha256) {
      throw new Error(
        `p4 binary checksum mismatch for ${url}: expected ${sha256}, got ${actualSha}`,
      );
    }
    const push = await fetch(`${baseUrl}/p4-binary`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/octet-stream",
        "x-p4-sha256": sha256,
      },
      body: binary,
      signal: AbortSignal.timeout(P4_DOWNLOAD_TIMEOUT_MS),
    });
    if (!push.ok) {
      throw new Error(`p4 shim rejected the binary push (${push.status})`);
    }
    logger.info(
      { arch, bytes: binary.length },
      "[P4Shim] p4 binary provisioned",
    );
    return peer;
  }

  /** Drop a scope's pods so the ReplicaSet rebuilds them from current state. */
  private async deletePods(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    scope: string,
  ): Promise<void> {
    try {
      await coreApi.deleteCollectionNamespacedPod({
        namespace,
        labelSelector: `${P4_SHIM_SCOPE_LABEL}=${scope}`,
      });
    } catch (error) {
      if (!isK8sNotFoundError(error)) throw error;
    }
  }
}

export const p4ShimRuntimeManager = new P4ShimRuntimeManager();

// ===== Internal helpers =====

/**
 * The pod answered, but rejected the token this reconcile holds — it booted
 * before the Secret was last written. Distinct from a generic status failure
 * because it is recoverable in exactly one way: replace the pod.
 */
class StaleShimTokenError extends Error {}

const READY_TIMEOUT_MS = 120_000;
const P4_DOWNLOAD_TIMEOUT_MS = 120_000;
const RESOLVE_TIMEOUT_MS = 30_000;

/** Discard port: a route lookup never sends to it. */
const ROUTE_LOOKUP_PORT = 9;

/** Hostname of the API server from a kubeconfig cluster URL. */
function apiServerHost(server: string | undefined): string | null {
  if (!server) return null;
  try {
    return new URL(server).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The pod reports a dual-stack socket address (`::ffff:10.244.0.1`); an
 * ipBlock CIDR needs the plain form.
 */
function normalizePeer(peer: string | undefined): string | null {
  if (!peer) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(peer);
  return mapped ? mapped[1] : peer;
}

interface P4ShimStatus {
  provisioned?: boolean;
  arch?: string;
  /** Address the request arrived from, as the pod sees it. */
  peer?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
