// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { type APIRequestContext, expect } from "@playwright/test";
import type { TestFixtures } from "./api-fixtures";

const fastProfile = process.env.E2E_HIBERNATION_TIMING_PROFILE === "ci-fast";

export const hibernationTiming = fastProfile
  ? {
      idleWindowMs: 8_000,
      lastUsedRefreshIntervalMs: 1_000,
      demandHeartbeatIntervalMs: 500,
      sweepIntervalMs: 4_000,
      quietPeriodMs: 2_000,
      earlyAwakeCheckMs: 4_000,
      hibernationDeadlineMs: 16_000,
      clusterPollIntervals: [250, 500, 1_000],
    }
  : {
      idleWindowMs: 120_000,
      lastUsedRefreshIntervalMs: 30_000,
      demandHeartbeatIntervalMs: 15_000,
      sweepIntervalMs: 60_000,
      quietPeriodMs: 35_000,
      earlyAwakeCheckMs: 60_000,
      hibernationDeadlineMs: 240_000,
      clusterPollIntervals: [1_000, 2_000, 5_000],
    };

export const earliestLegalHibernationMs =
  hibernationTiming.idleWindowMs +
  hibernationTiming.lastUsedRefreshIntervalMs +
  hibernationTiming.demandHeartbeatIntervalMs;

export async function assertHibernationTimingProfile(params: {
  request: APIRequestContext;
  makeApiRequest: TestFixtures["makeApiRequest"];
}): Promise<void> {
  const response = await params.makeApiRequest({
    request: params.request,
    method: "get",
    urlSuffix: "/test",
    ignoreStatusCheck: true,
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).mcpIdleHibernation).toEqual({
    windowSeconds: hibernationTiming.idleWindowMs / 1000,
    lastUsedRefreshIntervalMs: hibernationTiming.lastUsedRefreshIntervalMs,
    demandHeartbeatIntervalMs: hibernationTiming.demandHeartbeatIntervalMs,
    sweepIntervalMs: hibernationTiming.sweepIntervalMs,
  });
}
