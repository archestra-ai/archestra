// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import type { McpDeploymentState } from "@archestra/shared";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import {
  MCP_FOREIGN_REPLICA_OWNER_ANNOTATION,
  MCP_HIBERNATED_ANNOTATION,
} from "@/k8s/shared";
import logger from "@/logging";
import {
  ClusterLeaseHeldError,
  McpDeploymentLeaseModel,
  McpHttpSessionModel,
  McpServerModel,
  OrganizationModel,
} from "@/models";
import type { ClusterLeaseGuard } from "@/models/mcp-deployment-lease";
import {
  MCP_DEMAND_HEARTBEAT_INTERVAL_MS,
  MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
} from "@/models/mcp-server";
import { mcpActiveUseTracker } from "@/services/mcp-active-use.ee";
import type { McpServerHibernationMode } from "@/types";
import { mapWithConcurrency } from "@/utils/concurrency";
import { MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE } from "./deployment-transition";
import { deriveDeploymentState } from "./hibernation-state-machine.ee";
import type K8sDeployment from "./k8s-deployment";
import {
  McpServerDeploymentFailedError,
  McpServerUnschedulableError,
} from "./k8s-deployment";

/**
 * Idle hibernation (scale-to-zero) of MCP server deployments: who is allowed
 * to sleep, when, and how they come back.
 *
 * The runtime manager keeps only the seams — the sweep timer, the
 * single-flight wake map, the deployment cache — because those are ordinary
 * runtime plumbing. Everything that makes hibernation an ENTERPRISE feature
 * lives here: the licence and organization gates, the per-install overrides,
 * and the sweep/wake orchestration itself.
 */

/**
 * Thrown when a demand-path call found its MCP server hibernated for idleness
 * and the wake did not reach ready within the wait budget. The wake keeps
 * progressing in the cluster (the pod continues starting up), so the call is
 * safe to retry shortly. `detail` replaces the generic reason when the wake
 * knows more — a cluster with no free capacity, an attempt cut by its
 * deadline — while keeping the same retryable shape for callers.
 */
export class McpServerWakeError extends Error {
  constructor(
    serverName: string,
    options?: ErrorOptions & { detail?: string },
  ) {
    super(
      `MCP server ${serverName} is waking from idle hibernation but ${
        options?.detail ?? "did not become ready in time"
      }; retry shortly.`,
      options,
    );
    this.name = "McpServerWakeError";
  }
}

/**
 * How long a caller waits on a wake before being answered instead of held.
 *
 * The deployment-transition deadline bounds the *work*; this bounds the
 * *reply*, and the two are not the same number. A wake may legitimately outlive
 * the caller that triggered it — a cold pod that pulls an image and installs
 * dependencies is minutes, not seconds — and holding an MCP tool call open that
 * long means the client's own timeout fires first. The caller then gets a
 * transport error (a dropped connection, a gateway timeout) that says nothing
 * about what happened and nothing about what to do, which is exactly the failure
 * an agent cannot act on.
 *
 * `ARCHESTRA_MCP_GATEWAY_WAKE_WAIT_TIMEOUT_MS` (default 30 s) is that budget,
 * verbatim — deliberately NOT derived from the tool-call timeout, which
 * governs the dispatched call and only starts counting once the woken server
 * has accepted it. The number an operator must keep this under is their
 * CLIENTS' request timeouts, which nothing here can see.
 *
 * Answering early does not abandon the wake. It keeps running under the
 * manager's single-flight entry, so the retry this reply asks for joins the
 * attempt already in progress rather than starting a second one — and by then
 * the server is usually up.
 */
export function wakeResponseBudgetMs(): number {
  return config.mcpGateway.wakeWaitTimeoutMs;
}

/**
 * Raised when a wake is still running at {@link wakeResponseBudgetMs}. It is
 * not a failure — the wake has not failed, it simply has not finished — so it
 * is deliberately a `McpServerWakeError` subclass and stays classified
 * retryable and not-the-caller's-fault by the tool-call funnel.
 */
export class McpServerWakePendingError extends McpServerWakeError {
  constructor(serverName: string, waitedMs: number) {
    super(serverName, {
      detail:
        `it is still starting up and did not become ready within ${Math.round(waitedMs / 1000)}s. ` +
        "It is still starting in the background: retry this same tool call with the same arguments " +
        "in about 30 seconds and it should run normally. Nothing needs to be fixed or changed",
    });
    this.name = "McpServerWakePendingError";
  }
}

/**
 * Hard ceiling on one hibernation sweep. A sweep that hangs would otherwise
 * hold the in-flight guard and silently stop hibernation platform-wide until
 * a restart; releasing the guard lets the next tick try again.
 */
export const SWEEP_DEADLINE_MS = 300_000;

/**
 * Settle no later than `ms`, rejecting with `makeError()`. The underlying work
 * is not cancelled — everything it might still do is guarded by the cluster's
 * resourceVersion compare-and-swap or is an idempotent no-op — but callers and
 * the in-flight bookkeeping that gates retries are released, so one hung call
 * can never wedge a deployment or the sweeper until the next restart.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  makeError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * What the sweep and the wake need from the runtime manager. Passing it in
 * (rather than importing the manager) keeps this module free of the runtime's
 * K8s client wiring, and keeps the dependency pointing one way.
 */
export interface HibernationRuntimeHost {
  /** Every deployment this process has loaded, keyed by mcp_server id. */
  readonly loadedDeployments: ReadonlyMap<string, K8sDeployment>;
  /** `namespace/name` — multitenant siblings share one physical deployment. */
  physicalDeploymentKey(deployment: K8sDeployment): string;
  /** All non-deleted installs sharing this server's physical deployment. */
  resolveSiblingServerIds(mcpServerId: string): Promise<string[]>;
  /** {@link resolveSiblingServerIds}, degrading to the caller's own id. */
  resolveSiblingServerIdsSafe(mcpServerId: string): Promise<string[]>;
  /** Mirror a confirmed transition onto every loaded sibling alias. */
  setCachedStateForSiblings(
    siblingIds: string[],
    state: McpDeploymentState,
  ): void;
  /** Wake the deployment backing this server (single-flighted by the host). */
  ensureAwake(mcpServerId: string): Promise<void>;
  /** Fire the registered post-hibernate listeners for a sibling group. */
  notifyHibernated(mcpServerIds: string[]): Promise<void>;
  /**
   * Record that we just put this physical deployment to sleep, so a later
   * sweep can tell "it came back because we woke it" from "it came back
   * because something else owns its replica count".
   */
  noteHibernatedByUs(deployment: K8sDeployment): void;
  /**
   * Whether this deployment's replicas are being written by another
   * controller, counting this observation if it is one. True means: leave it
   * alone — see {@link FOREIGN_RESUME_LIMIT}.
   */
  isReplicaCountOwnedElsewhere(
    deployment: K8sDeployment,
    latestUsageAt: Date,
    runFencedMutation: ClusterLeaseGuard["runFencedMutation"],
  ): Promise<boolean>;
}

/**
 * How many times a deployment may come back on its own before the sweeper
 * stops trying to hibernate it.
 *
 * An ArgoCD or Flux self-heal, an HPA or KEDA `minReplicas >= 1`, or an
 * operator who scales by hand all write `spec.replicas` back after we scale it
 * to zero. Nothing about that looks like an error: our marker survives, the
 * next refresh sees replicas and availability and finishes a "wake" nobody
 * asked for, and the deployment reads running again — so the next tick
 * hibernates it, and the pod is torn down once per tick, forever.
 *
 * One resume is not proof (a wake on another replica looks the same from
 * here). Two is: stop, and say so once.
 */
export const FOREIGN_RESUME_LIMIT = 2;

/**
 * Caps the cooldown's doubling at 2^5 = 32 sweeps. Long enough that a
 * deployment another controller genuinely owns costs one hibernate an hour
 * rather than one a tick; short enough that the runtime keeps re-checking
 * instead of writing it off forever.
 */
export const FOREIGN_RESUME_COOLDOWN_MAX_EXPONENT = 5;

/**
 * Whether this deployment offers idle hibernation at all: the feature's beta
 * flag is on and the operator has not hard-disabled it. Everything below this
 * gate — licence, organization toggle, per-server mode — only matters when
 * the deployment offers the feature in the first place.
 */
export function isIdleHibernationOffered(): boolean {
  return (
    config.orchestrator.mcpIdleHibernation.betaEnabled &&
    !config.orchestrator.mcpIdleHibernation.hardDisabled
  );
}

/** How long a server must sit unused before the sweep considers it idle. */
export function idleHibernationWindowSeconds(): number {
  return config.orchestrator.mcpIdleHibernation.windowSeconds;
}

/**
 * Whether a sibling group — the installs sharing one physical deployment —
 * may be put to sleep.
 *
 * The organization toggle is the MASTER switch: with it off nothing sleeps,
 * whatever the individual installs say. A per-install mode can only ever
 * restrict further, which is why "enabled" resolves identically to "inherit"
 * today. It exists so an install can pin its intent explicitly (and stay
 * pinned if the org-level default ever changes), never as a way to opt into
 * hibernation an administrator has turned off.
 *
 * A single "disabled" sibling vetoes the whole group: they share one pod, so
 * there is no way to keep one install awake without keeping all of them awake.
 *
 * @public — the resolution truth table, enumerated exhaustively by its tests
 */
export function isGroupHibernationAllowed(params: {
  organizationEnabled: boolean;
  modes: McpServerHibernationMode[];
}): boolean {
  if (!params.organizationEnabled) return false;
  return !params.modes.includes("disabled");
}

/**
 * One sweep: hibernate every loaded deployment whose whole sibling group has
 * been idle past the window (+ persistence grace). Deployments the sweeper
 * must never touch are excluded by the cached-state filter alone: waking
 * deployments (annotation + replicas ≥ 1) refresh to "waking",
 * externally-scaled-to-0 ones to "pending", hibernated ones to "hibernated" —
 * only cached-"running" deployments are candidates.
 */
export async function sweepIdleDeployments(
  host: HibernationRuntimeHost,
): Promise<void> {
  // Checked per tick, not per process: an administrator turning the toggle
  // off must stop the next sweep, not the next restart.
  const organizationEnabled = await isIdleHibernationEnabled();
  if (!organizationEnabled) return;
  const windowSeconds = idleHibernationWindowSeconds();

  // Dedupe alias objects: every multitenant sibling holds its OWN
  // K8sDeployment for the same physical Deployment — evaluate (and patch)
  // each physical deployment at most once per sweep.
  const candidatesByPhysicalKey = new Map<
    string,
    { mcpServerId: string; deployment: K8sDeployment }
  >();
  for (const [mcpServerId, deployment] of host.loadedDeployments) {
    const key = host.physicalDeploymentKey(deployment);
    const chosen = candidatesByPhysicalKey.get(key);
    // Aliases of one physical deployment can disagree: only the alias a
    // lifecycle call ran on refreshes first, so map order could hand the
    // sweep a stale "not_created" alias and veto a group that is plainly
    // running. Prefer an alias reading "running" — the only state the sweep
    // acts on — and fall back to the first one otherwise.
    if (chosen?.deployment.statusSummary.state === "running") continue;
    if (!chosen || deployment.statusSummary.state === "running") {
      candidatesByPhysicalKey.set(key, { mcpServerId, deployment });
    }
  }

  await mapWithConcurrency(
    Array.from(candidatesByPhysicalKey.values()),
    K8S_API_FANOUT_CONCURRENCY,
    async ({ mcpServerId, deployment }) => {
      try {
        await hibernateIfIdle({
          host,
          mcpServerId,
          deployment,
          windowSeconds,
          organizationEnabled,
        });
      } catch (err) {
        // Never hibernate on doubt: any error skips this deployment until
        // the next sweep.
        logger.warn(
          { err, mcpServerId },
          "Skipping MCP idle-hibernation candidate after an error",
        );
      }
    },
  );
}

/**
 * Perform the actual wake for the manager's `ensureAwake` (single-flighted
 * per physical deployment by the caller).
 *
 * Deliberately NOT gated on {@link isIdleHibernationEnabled}: a deployment
 * that is already asleep must always be wakeable on demand, even seconds
 * after an administrator turned the feature off or pinned this install to
 * "disabled". A mode only prevents FUTURE sleep.
 */
export async function wakeDeployment(params: {
  host: HibernationRuntimeHost;
  mcpServerId: string;
  deployment: K8sDeployment;
  lease?: ClusterLeaseGuard;
}): Promise<void> {
  const { host, mcpServerId, deployment, lease } = params;
  const lifecycleOptions = {
    throwOnError: true,
    ...(lease ? { runFencedMutation: lease.runFencedMutation } : {}),
  };
  // Cluster truth before acting: the cached "hibernated" can be stale (an
  // externally-completed wake reads "running"; a previous failed wake left
  // annotation + replicas ≥ 1, which reads "waking").
  await deployment.refreshState(lifecycleOptions);
  lease?.throwIfLost();
  let state = deployment.statusSummary.state;

  if (state === "not_created") {
    // Cache-cold fallback when refresh could not classify the deployment.
    // Classify from a direct read: our
    // annotation at 0 replicas is a hibernated deployment to wake; at ≥ 1
    // replicas a half-woken one to resume; no annotation (or no
    // deployment) is not a hibernation scenario at all.
    const liveDeployment = await deployment.readLiveDeployment();
    lease?.throwIfLost();
    if (
      !liveDeployment ||
      liveDeployment.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION] !==
        "true"
    ) {
      return;
    }
    state =
      (liveDeployment.spec?.replicas ?? 0) === 0 ? "hibernated" : "waking";
    // Record what the cluster just told us before acting on it, so the
    // lifecycle call below is a legal move out of a confirmed state rather
    // than an action out of the cache-cold "not_created".
    deployment.syncStateFromSibling(state);
  }

  if (state === "hibernated") {
    await deployment.beginWake(lifecycleOptions);
    lease?.throwIfLost();
  } else if (state === "waking") {
    // Resume a half-woken deployment: a previous wake scaled it up (the
    // annotation is still present) but the ready-wait failed. Skip
    // beginWake and go straight back to waiting.
  } else if (state === "failed") {
    // The refresh above just read this from the cluster: the deployment cannot
    // serve, and no amount of waiting changes that (a bad image, a crash on
    // boot). Returning here would report success and send the caller's tool
    // call at a pod that never answers — it would come back as a transport
    // timeout naming nothing anyone can act on. Raise the deployment's own
    // reason instead, which is the same terminal error a wake raises when it
    // watches the failure happen, so both routes reach the caller as one
    // message. An operator fixing the image lets the ordinary refresh find the
    // pod available and finish the wake.
    const summary = deployment.statusSummary;
    throw new McpServerDeploymentFailedError(
      `Deployment ${summary.deploymentName} failed: ${
        summary.error ?? "the deployment is not serving any replicas"
      }`,
    );
  } else {
    // "running": woke behind our back — nothing to do.
    return;
  }

  // Resolved once, reused by every state mirror below.
  const siblingIds = await host.resolveSiblingServerIdsSafe(mcpServerId);
  lease?.throwIfLost();
  // A lifecycle method only transitions the object it was called on; mirror
  // "waking" onto every loaded sibling alias so none of them advertises a
  // stale "hibernated" for the seconds the scale-up takes.
  host.setCachedStateForSiblings(siblingIds, "waking");

  try {
    await deployment.waitForDeploymentReady(
      WAKE_READY_MAX_ATTEMPTS,
      WAKE_READY_POLL_INTERVAL_MS,
      // A full cluster is not a broken deployment: ride out Unschedulable
      // within the budget instead of failing fast like a first install does.
      { waitOutUnschedulablePods: true },
    );
  } catch (error) {
    lease?.throwIfLost();
    // The pod is verifiably broken (bad image, crash on boot), not merely
    // slow. Telling the caller to "retry shortly" would loop forever on an
    // error only an operator can clear, so surface the real failure and let
    // the deployment keep its own "failed" state.
    if (error instanceof McpServerDeploymentFailedError) {
      host.setCachedStateForSiblings(siblingIds, "failed");
      logger.warn(
        { err: error, mcpServerId },
        "MCP server wake aborted: the deployment failed to start",
      );
      throw error;
    }
    // Deliberately leave the hibernation annotation in place: refreshState
    // reports annotation + replicas ≥ 1 as "waking", and the sweeper only
    // considers cached-"running" deployments, so a half-woken deployment
    // can never be re-hibernated. Cache "hibernated" so the next
    // ensureAwake re-enters the slow path (the fast path trusts every
    // other cached state) and resumes the wait above.
    host.setCachedStateForSiblings(siblingIds, "hibernated");
    if (error instanceof McpServerUnschedulableError) {
      // Capacity, not defect: same resume semantics as a plain timeout, but
      // the caller and the log carry the scheduler's own reason so a
      // mass-wake into a full cluster is diagnosable at a glance.
      logger.warn(
        { err: error, mcpServerId },
        "MCP server wake is waiting on cluster capacity",
      );
      throw new McpServerWakeError(deployment.statusSummary.serverName, {
        cause: error,
        detail: `the cluster has no free capacity to schedule its pod (${error.schedulerMessage}). The pod stays queued and starts when capacity frees`,
      });
    }
    logger.warn(
      { err: error, mcpServerId },
      "MCP server wake did not reach ready within the wait budget",
    );
    throw new McpServerWakeError(deployment.statusSummary.serverName, {
      cause: error,
    });
  }

  lease?.throwIfLost();
  const finalState = await deployment.completeWake(lifecycleOptions);
  lease?.throwIfLost();
  if (finalState !== "running") {
    // completeWake lost its finish-wake CAS and converged on cluster truth
    // that is NOT a serving deployment — an operator re-zeroed the
    // still-annotated object between readiness and the annotation drop, or
    // the object is gone. Mirroring "running" here would bury that
    // observation and dispatch the caller's tool call at a Service with
    // nothing behind it. Mirror the observed state and fail the wake in its
    // retryable shape: the next call re-decides from the cluster.
    host.setCachedStateForSiblings(siblingIds, finalState);
    logger.warn(
      { mcpServerId, finalState },
      "MCP server wake was superseded before its annotations were dropped",
    );
    throw new McpServerWakeError(deployment.statusSummary.serverName, {
      detail: `its wake was superseded by a concurrent transition (the deployment is now ${finalState})`,
    });
  }
  host.setCachedStateForSiblings(siblingIds, "running");
  // A woken deployment gets a full idle window: its persisted last_used_at
  // is by definition older than the idle cutoff (that's why it slept), so
  // without a fresh stamp the next sweep would re-hibernate it seconds
  // after the wake. One stamp covers the group — every idle check takes the
  // MAXIMUM last-used across siblings, so raising one raises the group.
  await mcpActiveUseTracker.stampIfEnabled(mcpServerId);
}

// === Internal ===

/**
 * Whether idle hibernation may run at all, right now. Three independent
 * gates, all of which can change while the process is up:
 *
 *   1. the operator's kill switch (`…MCP_IDLE_HIBERNATION_SECONDS=0`),
 *   2. an active enterprise licence,
 *   3. the organization's own toggle.
 *
 * Re-evaluated on every sweep tick rather than latched at startup, so turning
 * the feature on or off takes effect without a restart.
 */
async function isIdleHibernationEnabled(): Promise<boolean> {
  if (!isIdleHibernationOffered()) return false;
  if (!enterpriseTier.isCoreActive()) return false;
  return OrganizationModel.getMcpIdleHibernationEnabled();
}

async function hibernateIfIdle(params: {
  host: HibernationRuntimeHost;
  mcpServerId: string;
  deployment: K8sDeployment;
  windowSeconds: number;
  organizationEnabled: boolean;
}): Promise<void> {
  const { host, mcpServerId, deployment, windowSeconds, organizationEnabled } =
    params;
  if (cachedState(deployment) !== "running") return;

  // The persisted stamp is throttled: updateLastUsed rewrites last_used_at
  // at most every MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS, so usage on
  // ANOTHER replica can be up to that much fresher than the DB shows.
  // Extend the idle window by the worst case staleness of the signal we are
  // about to read, so a server being used on another replica right now cannot
  // look idle here. A live call's row is refreshed by the demand heartbeat, so
  // it lags by at most one persistence interval plus one heartbeat tick; the
  // grace is exactly that sum rather than a round number that happens to work.
  const idleCutoff =
    Date.now() -
    (windowSeconds * 1000 +
      MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS +
      MCP_DEMAND_HEARTBEAT_INTERVAL_MS);

  // Cheap in-memory pre-filter, before any query. This server alone being
  // busy or recently used already proves the whole sibling group isn't idle
  // (the checks below take the group MAXIMUM), so an actively-used
  // deployment costs the sweep nothing per tick.
  const ownLastUsedAt = mcpActiveUseTracker.getInMemoryLastUsedAt([
    mcpServerId,
  ]);
  if (
    mcpActiveUseTracker.getActiveUseCount(mcpServerId) > 0 ||
    (ownLastUsedAt && ownLastUsedAt.getTime() >= idleCutoff)
  ) {
    return;
  }

  // The map only ever holds local deployments, but hibernation scales
  // workloads — verify rather than assume.
  const catalogItem = await deployment.getCatalogItem();
  if (catalogItem?.serverType !== "local") return;

  const siblingIds = await host.resolveSiblingServerIds(mcpServerId);

  // An in-flight call on ANY sibling keeps the shared pod awake.
  if (siblingIds.some((id) => mcpActiveUseTracker.getActiveUseCount(id) > 0))
    return;

  // Per-install overrides, resolved across the whole group: one install
  // pinned awake keeps the shared pod up for all of them.
  const modes = await McpServerModel.getHibernationModes(siblingIds);
  if (!isGroupHibernationAllowed({ organizationEnabled, modes })) {
    logger.debug(
      { mcpServerId },
      "Skipping MCP idle-hibernation: an install in this group has hibernation disabled",
    );
    return;
  }

  // Guarded FRESH usage read — on any error, skip this cycle (never
  // hibernate on doubt).
  let dbLastUsedAt: Date | null;
  try {
    dbLastUsedAt = await McpServerModel.getLatestUsageAt(siblingIds);
  } catch (error) {
    logger.warn(
      { err: error, mcpServerId },
      "Skipping MCP idle-hibernation candidate: usage lookup failed",
    );
    return;
  }
  const inMemoryLastUsedAt =
    mcpActiveUseTracker.getInMemoryLastUsedAt(siblingIds);
  const effectiveLastUsedAt = laterOf(dbLastUsedAt, inMemoryLastUsedAt);
  // No usage signal at all (rows vanished mid-sweep) — don't guess.
  if (!effectiveLastUsedAt) return;
  if (effectiveLastUsedAt.getTime() >= idleCutoff) return;

  // Seizure guard: the cached "running" can be up to RUNNING_MISS_THRESHOLD
  // refreshes stale (the debounce), so an operator's external scale-to-0 —
  // or another replica's fresh hibernate — could still read "running" here.
  // Re-check the cache after the awaits above and require the LIVE
  // deployment to be an awake, unannotated one before we claim it.
  if (cachedState(deployment) !== "running") {
    logger.debug(
      { mcpServerId },
      "Skipping MCP idle-hibernation: cached state changed during the idle evaluation",
    );
    return;
  }
  const liveDeployment = await deployment.readLiveDeployment();
  if (
    !liveDeployment ||
    (liveDeployment.spec?.replicas ?? 0) < 1 ||
    liveDeployment.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION] ===
      "true" ||
    liveDeployment.metadata?.annotations?.[
      MCP_FOREIGN_REPLICA_OWNER_ANNOTATION
    ] === "true"
  ) {
    // That read is cluster truth, and discarding it is how a replica ends up
    // caching "running" for a deployment it has just seen asleep — usually one
    // another replica hibernated. ensureAwake's fast path trusts that cache, so
    // the next tool call this replica routes takes the fast path, skips the
    // wake, and dispatches at a pod that is not there. Converge the whole
    // sibling group on what we just observed instead, exactly as wakeDeployment
    // does with its own cache-cold read.
    const observed = liveDeployment
      ? deriveDeploymentState(
          {
            exists: true,
            hasHibernationAnnotation:
              liveDeployment.metadata?.annotations?.[
                MCP_HIBERNATED_ANNOTATION
              ] === "true",
            replicas: liveDeployment.spec?.replicas ?? 0,
            availableReplicas: liveDeployment.status?.availableReplicas ?? 0,
            // Not read on this path. A null failure can only make the
            // derivation say "waking" where a fetch might have said "failed",
            // and the ordinary refresh corrects that on its next pass.
            podFailure: null,
          },
          cachedState(deployment),
        )
      : ({ kind: "state", state: "not_created" } as const);
    if (observed.kind === "state") {
      host.setCachedStateForSiblings(siblingIds, observed.state);
    }
    logger.debug(
      {
        mcpServerId,
        observedState: observed.kind === "state" && observed.state,
      },
      "Skipping MCP idle-hibernation: live deployment is missing, already scaled to 0, or already annotated",
    );
    return;
  }

  if (
    !(await hibernateUnderTransitionLease({
      host,
      mcpServerId,
      deployment,
      idleCutoff,
      organizationEnabled,
    }))
  ) {
    return;
  }

  // Re-check the wake's dependency cache now that the server sleeps: kubelet
  // image GC can evict an unused image, and a pull policy of Always makes the
  // wake contact the registry even with a cached copy — either way a registry
  // outage would then block the wake. Pure observability, so it runs AFTER
  // every teardown step that hibernation's correctness depends on, and its
  // own failure is contained rather than costing the caller its cleanup.
  try {
    const imageCache = await deployment.assessWakeImageCache();
    if (imageCache) {
      if (imageCache.pullPolicy === "Always") {
        logger.warn(
          { mcpServerId, ...imageCache },
          "MCP server hibernated with an always-pull image; waking will need the container registry",
        );
      } else {
        logger.debug(
          { mcpServerId, ...imageCache },
          "MCP server hibernated with a cache-first image; waking needs no registry",
        );
      }
    }
  } catch (error) {
    logger.debug(
      { err: error, mcpServerId },
      "Could not assess the wake image cache after hibernating",
    );
  }
}

async function hibernateUnderTransitionLease(params: {
  host: HibernationRuntimeHost;
  mcpServerId: string;
  deployment: K8sDeployment;
  idleCutoff: number;
  organizationEnabled: boolean;
}): Promise<boolean> {
  const { host, mcpServerId, deployment, idleCutoff, organizationEnabled } =
    params;
  const key = host.physicalDeploymentKey(deployment);

  try {
    return await McpDeploymentLeaseModel.withLease(
      { scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE, key },
      async (lease) => {
        // Everything above this gate is only a cheap candidate filter. Re-read
        // every demand input while holding the shared transition gate. Demand
        // stamps before checking this lease, so either this read sees it or
        // demand waits for cleanup and then re-reads Kubernetes before dispatch.
        const siblingIds = await host.resolveSiblingServerIds(mcpServerId);
        if (
          siblingIds.some((id) => mcpActiveUseTracker.getActiveUseCount(id) > 0)
        ) {
          return false;
        }
        const modes = await McpServerModel.getHibernationModes(siblingIds);
        if (!isGroupHibernationAllowed({ organizationEnabled, modes })) {
          return false;
        }
        const dbLastUsedAt = await McpServerModel.getLatestUsageAt(siblingIds);
        const inMemoryLastUsedAt =
          mcpActiveUseTracker.getInMemoryLastUsedAt(siblingIds);
        const effectiveLastUsedAt = laterOf(dbLastUsedAt, inMemoryLastUsedAt);
        if (
          !effectiveLastUsedAt ||
          effectiveLastUsedAt.getTime() >= idleCutoff
        ) {
          return false;
        }

        // Decide ownership only from fresh usage while holding the transition
        // lease. A wake on another replica stamps demand before scaling up; it
        // must not be mistaken for an external controller restoring replicas.
        if (
          await host.isReplicaCountOwnedElsewhere(
            deployment,
            effectiveLastUsedAt,
            lease.runFencedMutation,
          )
        ) {
          return false;
        }

        if (cachedState(deployment) !== "running") return false;
        const live = await deployment.readLiveDeployment();
        if (
          !live ||
          (live.spec?.replicas ?? 0) < 1 ||
          live.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION] === "true" ||
          live.metadata?.annotations?.[MCP_FOREIGN_REPLICA_OWNER_ANNOTATION] ===
            "true"
        ) {
          return false;
        }

        await lease.assertOwned();
        if (
          !(
            await deployment.hibernate({
              runFencedMutation: lease.runFencedMutation,
            })
          ).hibernated
        ) {
          return false;
        }
        lease.throwIfLost();
        host.noteHibernatedByUs(deployment);
        host.setCachedStateForSiblings(siblingIds, "hibernated");

        // Keep the gate until all stale session/client state is gone. A demand
        // waiter cannot create a new session that this cleanup then deletes.
        for (const siblingId of siblingIds) {
          lease.throwIfLost();
          try {
            await McpHttpSessionModel.deleteByMcpServerId(siblingId);
          } catch (error) {
            logger.warn(
              { err: error, mcpServerId: siblingId },
              "Failed to delete durable MCP HTTP sessions after hibernation",
            );
          }
        }
        await lease.assertOwned();
        await host.notifyHibernated(siblingIds);
        await lease.assertOwned();
        return true;
      },
    );
  } catch (error) {
    if (error instanceof ClusterLeaseHeldError) {
      logger.debug(
        { mcpServerId, physicalDeployment: key },
        "Skipping MCP idle-hibernation: another replica owns the transition gate",
      );
      return false;
    }
    throw error;
  }
}

/**
 * A deployment's CURRENT cached state. Read through a call rather than the
 * property path so each check sees what the deployment says now — the
 * lifecycle calls in between can (and do) move it.
 */
function cachedState(deployment: K8sDeployment): McpDeploymentState {
  return deployment.statusSummary.state;
}

/** The later of two nullable timestamps, or null when both are null. */
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Ready-wait budget when waking a hibernated deployment on the demand path:
 * 22 attempts × 2 s ≈ 44 s, chosen to fit under typical client-side call
 * timeouts (60 s) with headroom for the K8s reads themselves. A wake that
 * outlives the budget surfaces as a retryable {@link McpServerWakeError};
 * the pod keeps starting and a later call resumes the wait.
 */
const WAKE_READY_MAX_ATTEMPTS = 22;
const WAKE_READY_POLL_INTERVAL_MS = 2_000;

/**
 * Max concurrent per-server operations when fanning out over the whole
 * install base. Each operation makes several K8s API calls; unbounded fan-out
 * trips the API server's Priority & Fairness throttling (429s) on large
 * installs. Matches the runtime manager's own fan-out bound.
 */
const K8S_API_FANOUT_CONCURRENCY = 5;
