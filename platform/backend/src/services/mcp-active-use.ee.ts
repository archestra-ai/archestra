// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import { McpServerModel, OrganizationModel } from "@/models";
import {
  MCP_DEMAND_HEARTBEAT_INTERVAL_MS,
  MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
} from "@/models/mcp-server";
import { trackBackgroundWork } from "@/utils/background-work";

type DemandTrackingMode = "off" | "required";

/**
 * Demand tracking for MCP servers, consulted by the idle-hibernation sweeper.
 *
 * Two signals, deliberately independent. `mcp_server.last_used_at` is the
 * CROSS-PROCESS one: throttled to one write per server per interval, refreshed
 * by a heartbeat for as long as a call is in flight, and awaited once on the
 * way into a call so a sweeper on another replica cannot act on a stale read.
 * The in-memory watermark and active counter are the LOCAL one — a sweeper in
 * THIS process consults the later of the two and refuses on either, whatever
 * the row says.
 *
 * A dropped write is where the two signals part ways. The local sweeper is
 * safe regardless, but every OTHER replica reads only the row, so the entry
 * stamp — the one that promises them the server is in use — fails CLOSED:
 * the operation is refused rather than run unprotected. Every other stamp is
 * best-effort (it closes an operation, grants idle credit, or refreshes an
 * in-flight call, and none of those may fail retroactively); what keeps a
 * best-effort failure from going quiet is that the throttle clock advances
 * only when a write commits, so the very next stamp retries instead of
 * waiting out an interval that never persisted anything.
 */
class McpActiveUseTracker {
  private activeUseCounts = new Map<string, number>();
  private lastUsedWatermarks = new Map<string, number>();
  /**
   * When this process last PERSISTED each server's timestamp, which is a
   * different clock from {@link lastUsedWatermarks} and the only correct one to
   * throttle against — see {@link stamp}.
   */
  private lastPersistedAt = new Map<string, number>();
  /**
   * The persistence write currently in flight per server. Concurrent stamps
   * join it instead of racing a second one — for an awaited entry stamp,
   * joining is load-bearing: the throttle only skips once a write has
   * COMMITTED, so "in flight" means "await that same commit", never "assume
   * it will land".
   */
  private inflightPersists = new Map<string, Promise<void>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /**
   * Wrap a demand-path operation against an MCP server: stamps last-used at
   * start and completion, and keeps the server counted as active for the
   * duration.
   */
  async trackActiveUse<T>(
    mcpServerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Count every call, even while hibernation is disabled. If a feature gate
    // turns on mid-call, the heartbeat can then publish that already-active
    // demand before a later sweep treats the server as idle.
    this.activeUseCounts.set(
      mcpServerId,
      (this.activeUseCounts.get(mcpServerId) ?? 0) + 1,
    );
    let trackingMode: DemandTrackingMode = "off";
    try {
      const resolvedMode = this.trackingMode();
      if (typeof resolvedMode === "string") {
        trackingMode = resolvedMode;
      } else {
        try {
          trackingMode = await resolvedMode;
        } catch (error) {
          // Unknown shared state is unsafe: another replica may already be
          // sweeping. Fall through to the required entry stamp, which either
          // proves demand durably or refuses dispatch.
          trackingMode = "required";
          logger.warn(
            { error, mcpServerId },
            "Could not resolve MCP idle-hibernation demand tracking; requiring persistence",
          );
        }
      }

      // Awaited, unlike every other stamp. The counter above is process-local,
      // so it is the persisted timestamp that tells OTHER replicas this server
      // is in use — and it has to be committed before the caller goes on to
      // wake and dispatch, or a sweeper elsewhere can read the old value and
      // scale the deployment away underneath this very call. When the write
      // cannot commit, this throws and the operation never starts: the caller
      // gets a retryable failure now instead of a pod deleted under a call in
      // flight later. The throttle bounds the cost to one write per server per
      // interval per process, so in practice only the first call to an idle
      // server pays it, and that call is about to do a wake and a full
      // transport setup anyway.
      if (trackingMode === "required") await this.stampAwaited(mcpServerId);
      return await fn();
    } finally {
      const remaining = (this.activeUseCounts.get(mcpServerId) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeUseCounts.delete(mcpServerId);
      } else {
        this.activeUseCounts.set(mcpServerId, remaining);
      }
      if (trackingMode !== "off") this.stamp(mcpServerId);
    }
  }

  /**
   * Grant idle credit without an active operation — used when a deployment is
   * woken or (re)created, so it gets a full idle window before the sweeper
   * reconsiders it.
   */
  stamp(mcpServerId: string): void {
    if (!this.recordDemand(mcpServerId)) return;
    trackBackgroundWork(
      this.persistLastUsed(mcpServerId).catch((error) => {
        // Best-effort by contract: this stamp closes an operation or grants
        // idle credit, and neither may fail on a dropped write. The throttle
        // clock did not advance, so the next stamp retries immediately.
        logger.warn(
          { error, mcpServerId },
          "Failed to persist MCP server last-used timestamp",
        );
      }),
    );
  }

  /** Grant idle credit only while idle hibernation is fully enabled. */
  async stampIfEnabled(mcpServerId: string): Promise<void> {
    const trackingEnabled = this.trackingEnabled();
    if (trackingEnabled === false) return;
    if (trackingEnabled !== true) {
      try {
        if (!(await trackingEnabled)) return;
      } catch (error) {
        logger.warn(
          { error, mcpServerId },
          "Could not resolve MCP idle-hibernation demand tracking; skipping idle credit",
        );
        return;
      }
    }
    this.stamp(mcpServerId);
  }

  /**
   * {@link stamp}, but the caller waits for the write to commit — and a write
   * that cannot commit REFUSES the operation instead of letting it run.
   *
   * For the one case where fire-and-forget is not enough: a demand path that is
   * about to wake and dispatch needs OTHER replicas to be able to see this
   * server in use before it goes on, and an unawaited write gives no such
   * guarantee. Neither does a swallowed failure: proceeding on one would leave
   * every other replica's sweeper free to hibernate the deployment under the
   * very call this stamp exists to protect, so the failure propagates and the
   * caller's operation fails retryably before dispatch. Costs nothing when the
   * throttle skips, which is the common case — a skip means a write COMMITTED
   * within the interval, so the guarantee already stands.
   */
  async stampAwaited(mcpServerId: string): Promise<void> {
    if (!this.recordDemand(mcpServerId)) return;
    try {
      await this.persistLastUsed(mcpServerId);
    } catch (error) {
      throw new Error(
        "Could not record this MCP server as in use before dispatch; refusing to run while other replicas may see it as idle. Retry the call.",
        { cause: error },
      );
    }
  }

  /**
   * Keep every server with a call in flight looking busy to other replicas.
   *
   * `trackActiveUse` stamps at the start and at the end and nothing in between,
   * so a call that runs longer than the idle window leaves its server's
   * persisted timestamp ageing past the cutoff while the call is still running.
   * The in-process counter covers that here, but it is invisible to every other
   * replica — their sweepers read only the row, decide the server is idle, and
   * scale the deployment away mid-call. MCP Tasks make that ordinary rather
   * than exotic: a task may run for half an hour against an idle window whose
   * floor is two minutes.
   *
   * Ticks re-stamp; the throttle collapses them, so N concurrent calls against
   * one server still cost one write per interval.
   */
  start(): void {
    this.stop();
    this.heartbeatTimer = setInterval(() => {
      trackBackgroundWork(this.heartbeat());
    }, MCP_DEMAND_HEARTBEAT_INTERVAL_MS);
    // Never hold the process open for bookkeeping.
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  getActiveUseCount(mcpServerId: string): number {
    return this.activeUseCounts.get(mcpServerId) ?? 0;
  }

  /** Latest in-memory demand timestamp across the given servers, or null. */
  getInMemoryLastUsedAt(mcpServerIds: string[]): Date | null {
    let latest: number | null = null;
    for (const id of mcpServerIds) {
      const at = this.lastUsedWatermarks.get(id);
      if (at !== undefined && (latest === null || at > latest)) {
        latest = at;
      }
    }
    return latest === null ? null : new Date(latest);
  }

  /** Drop tracking state for an uninstalled server. */
  remove(mcpServerId: string): void {
    this.activeUseCounts.delete(mcpServerId);
    this.lastUsedWatermarks.delete(mcpServerId);
    this.lastPersistedAt.delete(mcpServerId);
  }

  /**
   * Demand tracking is part of idle hibernation, not a baseline MCP-call
   * dependency. Keep ordinary calls free of its writes and fail-closed behavior
   * unless every feature gate currently permits a sweep.
   */
  private trackingEnabled(): boolean | Promise<boolean> {
    return (
      this.trackingEnabledSync() ??
      OrganizationModel.getMcpIdleHibernationEnabled()
    );
  }

  /**
   * Once the shared organization toggle is on, every replica must publish
   * demand before dispatch even if its local rollout gates are still off:
   * another replica may already be sweeping. Local beta/license/config state
   * cannot weaken the cluster-wide organization contract.
   */
  private trackingMode(): DemandTrackingMode | Promise<DemandTrackingMode> {
    const organizationEnabled =
      OrganizationModel.getMcpIdleHibernationEnabledSync();
    return organizationEnabled === undefined
      ? OrganizationModel.getMcpIdleHibernationEnabled().then((enabled) =>
          this.trackingModeForOrganization(enabled),
        )
      : this.trackingModeForOrganization(organizationEnabled);
  }

  private trackingModeForOrganization(
    organizationEnabled: boolean,
  ): DemandTrackingMode {
    return organizationEnabled ? "required" : "off";
  }

  private trackingEnabledSync(): boolean | undefined {
    if (
      !config.orchestrator.mcpIdleHibernation.betaEnabled ||
      config.orchestrator.mcpIdleHibernation.hardDisabled ||
      !enterpriseTier.isCoreActive()
    ) {
      return false;
    }

    return OrganizationModel.getMcpIdleHibernationEnabledSync();
  }

  /**
   * Record demand in memory and answer whether a write to the row is due.
   */
  private recordDemand(mcpServerId: string): boolean {
    const now = Date.now();
    this.lastUsedWatermarks.set(mcpServerId, now);

    // updateLastUsed refuses to rewrite a row touched within the refresh
    // interval, so a second query inside that window can only ever no-op.
    // Skipping it here means one round trip per server per interval instead
    // of two per call (trackActiveUse stamps at both start and completion).
    //
    // Throttle against the last COMMITTED persist, never against the last
    // stamp or attempt. Against the last stamp the window slides forward with
    // the traffic itself: a server called more often than the interval never
    // sees a gap wide enough to persist, so its row froze at the first call
    // and stayed there. Every OTHER replica reads that frozen timestamp, and
    // once it aged past the idle window their sweepers hibernated a server
    // that had never stopped working. Against the last ATTEMPT, a failed
    // write buys itself a whole quiet interval: the row stays stale and every
    // stamp inside the window is skipped as if the write had landed — which
    // is why the clock is advanced by {@link persistLastUsed} on commit, not
    // here.
    const persistedAt = this.lastPersistedAt.get(mcpServerId);
    return !(
      persistedAt !== undefined &&
      now - persistedAt < MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS
    );
  }

  /**
   * The one write path to the row. Failures propagate — {@link stamp} logs
   * them, {@link stampAwaited} refuses its operation on them — and only a
   * commit advances the throttle clock, so a failure is retried by the very
   * next stamp instead of hiding behind the interval.
   */
  private persistLastUsed(mcpServerId: string): Promise<void> {
    const inflight = this.inflightPersists.get(mcpServerId);
    if (inflight) return inflight;

    const write = McpServerModel.updateLastUsed(mcpServerId)
      .then(() => {
        this.lastPersistedAt.set(mcpServerId, Date.now());
      })
      .finally(() => {
        this.inflightPersists.delete(mcpServerId);
      });
    this.inflightPersists.set(mcpServerId, write);
    return write;
  }

  private async heartbeat(): Promise<void> {
    let organizationEnabled = true;
    try {
      // Refresh shared state instead of trusting a process-local false cached
      // before another replica enabled hibernation.
      organizationEnabled =
        await OrganizationModel.getMcpIdleHibernationEnabled();
    } catch (error) {
      logger.warn(
        { error },
        "Could not resolve MCP idle-hibernation demand tracking heartbeat; persisting conservatively",
      );
    }
    if (!organizationEnabled) return;

    for (const [mcpServerId, count] of this.activeUseCounts) {
      if (count <= 0) continue;
      if (!this.recordDemand(mcpServerId)) continue;
      try {
        await this.persistLastUsed(mcpServerId);
      } catch (error) {
        // One bad id must not kill the timer for every other server.
        logger.warn(
          { error, mcpServerId },
          "Failed to heartbeat an in-flight MCP server's last-used timestamp",
        );
      }
    }
  }
}

export const mcpActiveUseTracker = new McpActiveUseTracker();
