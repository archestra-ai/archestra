import { vi } from "vitest";

vi.mock("@/logging");

import config from "@/config";
import logger from "@/logging";
import { beforeEach, describe, expect, test } from "@/test";
// biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
import { assertRetentionConfigLicensed } from "./license-gate.ee";

describe("assertRetentionConfigLicensed", () => {
  const originalCore = config.enterpriseFeatures.core;

  beforeEach(() => {
    vi.clearAllMocks();
    config.retention.llmLogsDays = 0;
    config.retention.mcpLogsDays = 0;
    config.retention.chatConversationsDays = 0;
    config.auditLog.retentionDays = 0;
    config.enterpriseFeatures.core = originalCore;
  });

  test("no-op when no retention window is configured, licensed or not", () => {
    config.enterpriseFeatures.core = false;
    expect(() => assertRetentionConfigLicensed()).not.toThrow();
  });

  test("throws when a window is configured without an enterprise license", () => {
    config.enterpriseFeatures.core = false;
    config.retention.mcpLogsDays = 30;
    expect(() => assertRetentionConfigLicensed()).toThrow(
      /requires an enterprise license/,
    );
  });

  test("throws when audit-log retention is configured without a license", () => {
    config.enterpriseFeatures.core = false;
    config.auditLog.retentionDays = 90;
    expect(() => assertRetentionConfigLicensed()).toThrow(
      /requires an enterprise license/,
    );
  });

  test("passes when configured with a license", () => {
    config.enterpriseFeatures.core = true;
    config.retention.llmLogsDays = 90;
    expect(() => assertRetentionConfigLicensed()).not.toThrow();
  });

  test("warns when the interaction window can under-count monthly cost limits", () => {
    config.enterpriseFeatures.core = true;
    config.retention.llmLogsDays = 30;
    assertRetentionConfigLicensed();
    expect(logger.warn).toHaveBeenCalledWith(
      { llmLogsDays: 30 },
      expect.stringContaining("cost-limit"),
    );
  });

  test("does not warn for windows of 32 days or more", () => {
    config.enterpriseFeatures.core = true;
    config.retention.llmLogsDays = 32;
    assertRetentionConfigLicensed();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
