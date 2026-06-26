// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { enterpriseTier } from "./enterprise-tier";

const setEnvFlag = (value: boolean) => {
  Object.defineProperty(config.enterpriseFeatures, "core", {
    value,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
    value,
    writable: true,
    configurable: true,
  });
};

describe("enterpriseTier", () => {
  const originalCore = config.enterpriseFeatures.core;
  const originalKnowledgeBase = config.enterpriseFeatures.knowledgeBase;

  beforeEach(() => {
    setEnvFlag(false);
    enterpriseTier.setUserCountForTesting(0);
  });

  afterEach(() => {
    Object.defineProperty(config.enterpriseFeatures, "core", {
      value: originalCore,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
      value: originalKnowledgeBase,
      writable: true,
      configurable: true,
    });
    enterpriseTier.setUserCountForTesting(0);
  });

  test("small team (under threshold, no env flag) gets enterprise + banner", () => {
    enterpriseTier.setUserCountForTesting(29);

    expect(enterpriseTier.isCoreActive()).toBe(true);
    expect(enterpriseTier.isKnowledgeBaseActive()).toBe(true);

    const state = enterpriseTier.getState();
    expect(state.smallTeam).toBe(true);
    expect(state.envFlag).toBe(false);
    expect(state.coreActive).toBe(true);
    expect(state.knowledgeBaseActive).toBe(true);
    expect(state.communicate).toBe(true);
    expect(state.userCount).toBe(29);
    expect(state.threshold).toBe(30);
  });

  test("at threshold without env flag flips enterprise off and shows banner", () => {
    enterpriseTier.setUserCountForTesting(30);

    expect(enterpriseTier.isCoreActive()).toBe(false);
    expect(enterpriseTier.isKnowledgeBaseActive()).toBe(false);

    const state = enterpriseTier.getState();
    expect(state.smallTeam).toBe(false);
    expect(state.envFlag).toBe(false);
    expect(state.coreActive).toBe(false);
    expect(state.knowledgeBaseActive).toBe(false);
    expect(state.communicate).toBe(true);
  });

  test("above threshold with env flag enables enterprise silently", () => {
    setEnvFlag(true);
    enterpriseTier.setUserCountForTesting(100);

    expect(enterpriseTier.isCoreActive()).toBe(true);
    expect(enterpriseTier.isKnowledgeBaseActive()).toBe(true);

    const state = enterpriseTier.getState();
    expect(state.smallTeam).toBe(false);
    expect(state.envFlag).toBe(true);
    expect(state.coreActive).toBe(true);
    expect(state.knowledgeBaseActive).toBe(true);
    expect(state.communicate).toBe(false);
  });

  test("small team with env flag still communicates the tier", () => {
    setEnvFlag(true);
    enterpriseTier.setUserCountForTesting(5);

    const state = enterpriseTier.getState();
    expect(state.communicate).toBe(true);
    expect(state.coreActive).toBe(true);
  });

  test("refresh() reads the user count from the database", async ({
    makeUser,
  }) => {
    enterpriseTier.setUserCountForTesting(-1);

    await makeUser();
    await makeUser();
    await enterpriseTier.refresh();

    expect(enterpriseTier.getState().userCount).toBeGreaterThanOrEqual(2);
  });
});
