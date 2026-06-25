// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import config from "@/config";
import logger from "@/logging";

const SMALL_TEAM_THRESHOLD = 30;
const REFRESH_INTERVAL_MS = 60_000;

interface EnterpriseTierState {
  userCount: number;
  threshold: number;
  smallTeam: boolean;
  envFlag: boolean;
  coreActive: boolean;
  knowledgeBaseActive: boolean;
  communicate: boolean;
}

class EnterpriseTierService {
  private userCount = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  async start(): Promise<void> {
    if (this.refreshTimer) return;
    await this.refresh();
    this.initialized = true;
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        logger.warn(
          { err },
          "EnterpriseTierService: scheduled refresh failed; keeping previous count",
        );
      });
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.initialized = false;
  }

  isCoreActive(): boolean {
    return config.enterpriseFeatures.core || this.isSmallTeam();
  }

  isKnowledgeBaseActive(): boolean {
    return config.enterpriseFeatures.knowledgeBase || this.isSmallTeam();
  }

  getState(): EnterpriseTierState {
    const smallTeam = this.isSmallTeam();
    const envFlag = config.enterpriseFeatures.core;
    const coreActive = this.isCoreActive();
    const knowledgeBaseActive = this.isKnowledgeBaseActive();
    // Communicate everywhere except the silent enterprise-license case
    // (env flag set + team has crossed the small-team threshold).
    const communicate = !(envFlag && !smallTeam);
    return {
      userCount: this.userCount,
      threshold: SMALL_TEAM_THRESHOLD,
      smallTeam,
      envFlag,
      coreActive,
      knowledgeBaseActive,
      communicate,
    };
  }

  /** Force a refresh; used after user creation/deletion or in tests. */
  async refresh(): Promise<void> {
    try {
      // Deferred import avoids a module-load cycle:
      // enterprise-tier → models/user → @/auth → better-auth → enterprise-tier.
      const { default: UserModel } = await import("@/models/user");
      this.userCount = await UserModel.countAll();
    } catch (err) {
      // On first attempt before DB is reachable we err on the side of
      // small-team-active so that fresh deployments don't lose features.
      if (!this.initialized) {
        this.userCount = 0;
      }
      throw err;
    }
  }

  /** @public — test-only escape hatch to set user count without hitting the DB. */
  setUserCountForTesting(count: number): void {
    this.userCount = count;
  }

  private isSmallTeam(): boolean {
    return this.userCount < SMALL_TEAM_THRESHOLD;
  }
}

export const enterpriseTier = new EnterpriseTierService();
