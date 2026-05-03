import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFindAllOrganizations = vi.hoisted(() => vi.fn());
const mockFindLimitsNeedingCleanup = vi.hoisted(() => vi.fn());
const mockResetLimitUsage = vi.hoisted(() => vi.fn());

vi.mock("@/models", () => ({
  OrganizationModel: { findAll: mockFindAllOrganizations },
  LimitModel: {
    findLimitsNeedingCleanup: mockFindLimitsNeedingCleanup,
    resetLimitUsage: mockResetLimitUsage,
  },
}));

vi.mock("@/logging", () => ({
  default: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

import { handleCleanupDueLimits } from "./cleanup-due-limits-handler";

describe("handleCleanupDueLimits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAllOrganizations.mockResolvedValue([]);
    mockFindLimitsNeedingCleanup.mockResolvedValue([]);
    mockResetLimitUsage.mockResolvedValue(undefined);
  });

  test("resets due limits for each organization", async () => {
    mockFindAllOrganizations.mockResolvedValue([
      { id: "org-1", limitCleanupInterval: "1h" },
    ]);
    mockFindLimitsNeedingCleanup.mockResolvedValue([
      { id: "limit-1" },
      { id: "limit-2" },
    ]);

    await handleCleanupDueLimits();

    expect(mockFindLimitsNeedingCleanup).toHaveBeenCalledWith(
      "org-1",
      expect.any(Date),
    );
    expect(mockResetLimitUsage).toHaveBeenCalledWith("limit-1");
    expect(mockResetLimitUsage).toHaveBeenCalledWith("limit-2");
  });

  test("skips unsupported cleanup intervals", async () => {
    mockFindAllOrganizations.mockResolvedValue([
      { id: "org-1", limitCleanupInterval: "invalid" },
    ]);

    await handleCleanupDueLimits();

    expect(mockFindLimitsNeedingCleanup).not.toHaveBeenCalled();
    expect(mockResetLimitUsage).not.toHaveBeenCalled();
  });
});
