import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFindAllIds = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockDeleteOlderThan = vi.hoisted(() => vi.fn().mockResolvedValue(0));

vi.mock("@/models", () => ({
  OrganizationModel: { findAllIds: mockFindAllIds },
  AuditLogModel: { deleteOlderThan: mockDeleteOlderThan },
}));

const mockConfig = vi.hoisted(() => ({
  auditLog: { retentionDays: 180 },
}));
vi.mock("@/config", () => ({ default: mockConfig }));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@/logging", () => ({ default: mockLogger }));

import { handleAuditLogCleanup } from "./audit-log-cleanup-handler";

describe("handleAuditLogCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.auditLog.retentionDays = 180;
  });

  test("logs and returns early when retentionDays is 0", async () => {
    mockConfig.auditLog.retentionDays = 0;

    await handleAuditLogCleanup();

    expect(mockFindAllIds).not.toHaveBeenCalled();
    expect(mockDeleteOlderThan).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 0 }),
      expect.stringContaining("disabled"),
    );
  });

  test("does nothing when there are no organizations", async () => {
    mockFindAllIds.mockResolvedValue([]);

    await handleAuditLogCleanup();

    expect(mockDeleteOlderThan).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ orgs: 0, deleted: 0, retentionDays: 180 }),
      expect.any(String),
    );
  });

  test("calls deleteOlderThan for each organization with the correct cutoff date", async () => {
    mockFindAllIds.mockResolvedValue(["org-1", "org-2"]);
    mockDeleteOlderThan.mockResolvedValue(3);

    const before = Date.now();
    await handleAuditLogCleanup();
    const after = Date.now();

    expect(mockDeleteOlderThan).toHaveBeenCalledTimes(2);

    const call1 = mockDeleteOlderThan.mock.calls[0][0];
    expect(call1.organizationId).toBe("org-1");
    const cutoff1 = call1.before.getTime();
    const expectedMin = before - 180 * 24 * 60 * 60 * 1000;
    const expectedMax = after - 180 * 24 * 60 * 60 * 1000;
    expect(cutoff1).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff1).toBeLessThanOrEqual(expectedMax);

    expect(mockDeleteOlderThan.mock.calls[1][0].organizationId).toBe("org-2");
  });

  test("sums deleted counts across organizations and logs a summary", async () => {
    mockFindAllIds.mockResolvedValue(["org-1", "org-2", "org-3"]);
    mockDeleteOlderThan
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(0);

    await handleAuditLogCleanup();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ orgs: 3, deleted: 15, retentionDays: 180 }),
      expect.any(String),
    );
  });

  test("logs error for a failing org but continues processing remaining orgs", async () => {
    mockFindAllIds.mockResolvedValue(["org-bad", "org-good"]);
    mockDeleteOlderThan
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce(7);

    await handleAuditLogCleanup();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-bad" }),
      expect.any(String),
    );
    expect(mockDeleteOlderThan).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ orgs: 2, deleted: 7 }),
      expect.any(String),
    );
  });

  test("uses the configured retentionDays to compute the cutoff", async () => {
    mockConfig.auditLog.retentionDays = 30;
    mockFindAllIds.mockResolvedValue(["org-1"]);
    mockDeleteOlderThan.mockResolvedValue(2);

    const before = Date.now();
    await handleAuditLogCleanup();
    const after = Date.now();

    const cutoff = mockDeleteOlderThan.mock.calls[0][0].before.getTime();
    const expectedMin = before - 30 * 24 * 60 * 60 * 1000;
    const expectedMax = after - 30 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff).toBeLessThanOrEqual(expectedMax);
  });
});
