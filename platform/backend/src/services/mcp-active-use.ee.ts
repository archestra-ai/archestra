// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import config from "@/config";
import logger from "@/logging";
import { McpServerModel, OrganizationModel } from "@/models";
import { MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS } from "@/models/mcp-server";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * In-process demand tracking for MCP servers, consulted by the idle-hibernation
 * sweeper. Persistence (mcp_server.last_used_at) is throttled and written
 * fire-and-forget, so the sweeper must not rely on it alone: the in-memory
 * watermark survives a failed stamp, and the active counter covers calls that
 * are still running. Both are process-local; cross-process coverage is the
 * deferred distributed lease.
 */
class McpActiveUseTracker {
  private activeUseCounts = new Map<string, number>();
  private lastUsedWatermarks = new Map<string, number>();

  /**
   * Wrap a demand-path operation against an MCP server: stamps last-used at
   * start and completion, and keeps the server counted as active for the
   * duration.
   */
  async trackActiveUse<T>(
    mcpServerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.stamp(mcpServerId);
    this.activeUseCounts.set(
      mcpServerId,
      (this.activeUseCounts.get(mcpServerId) ?? 0) + 1,
    );
    try {
      return await fn();
    } finally {
      const remaining = (this.activeUseCounts.get(mcpServerId) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeUseCounts.delete(mcpServerId);
      } else {
        this.activeUseCounts.set(mcpServerId, remaining);
      }
      this.stamp(mcpServerId);
    }
  }

  /**
   * Grant idle credit without an active operation — used when a deployment is
   * woken or (re)created, so it gets a full idle window before the sweeper
   * reconsiders it.
   */
  stamp(mcpServerId: string): void {
    // Nothing reads either signal unless the sweeper runs, and the demand
    // paths that call this sit on the hot tool-call route — an installation
    // that never turns hibernation on should pay nothing for it.
    //
    // Synchronous by necessity, so this reads the process-local mirror of the
    // organization toggle and treats a cold mirror as off: a miss costs at
    // most one idle window of un-stamped demand while the mirror hydrates in
    // the background, and the sweeper itself re-checks the live cluster state
    // before it hibernates anything. The enterprise licence is deliberately
    // NOT re-checked here — the toggle can only have been turned on through a
    // licence-gated route, and recording a timestamp for a lapsed licence is
    // harmless.
    if (!isIdleHibernationPossiblyOn()) return;

    const now = Date.now();
    const previous = this.lastUsedWatermarks.get(mcpServerId);
    this.lastUsedWatermarks.set(mcpServerId, now);

    // updateLastUsed refuses to rewrite a row touched within the refresh
    // interval, so a second query inside that window can only ever no-op.
    // Skipping it here means one round trip per server per interval instead
    // of two per call (trackActiveUse stamps at both start and completion).
    if (
      previous !== undefined &&
      now - previous < MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    trackBackgroundWork(
      McpServerModel.updateLastUsed(mcpServerId).catch((error) => {
        logger.warn(
          { error, mcpServerId },
          "Failed to persist MCP server last-used timestamp",
        );
      }),
    );
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
  }
}

export const mcpActiveUseTracker = new McpActiveUseTracker();

/**
 * The cheap, synchronous half of the hibernation gate: the beta flag is on,
 * the operator has not hard-disabled the feature, AND this process already
 * knows the organization has it on. Deliberately conservative — an unknown
 * answer counts as off.
 */
function isIdleHibernationPossiblyOn(): boolean {
  if (!config.orchestrator.mcpIdleHibernation.betaEnabled) return false;
  if (config.orchestrator.mcpIdleHibernation.hardDisabled) return false;
  return OrganizationModel.getMcpIdleHibernationEnabledSync() === true;
}
