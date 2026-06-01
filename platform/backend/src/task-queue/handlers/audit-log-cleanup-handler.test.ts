import { beforeEach, describe, expect, test, vi } from "vitest";

const mockDeleteAllOlderThan = vi.hoisted(() => vi.fn().mockResolvedValue(0));

vi.mock("@/models", () => ({
  AuditLogModel: { deleteAllOlderThan: mockDeleteAllOlderThan },
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

    expect(mockDeleteAllOlderThan).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 0 }),
      expect.stringContaining("disabled"),
    );
  });

  test("runs a single DELETE across all orgs with the correct cutoff date", async () => {
    mockDeleteAllOlderThan.mockResolvedValue(15);

    const before = Date.now();
    await handleAuditLogCleanup();
    const after = Date.now();

    expect(mockDeleteAllOlderThan).toHaveBeenCalledTimes(1);

    const cutoff = (mockDeleteAllOlderThan.mock.calls[0][0] as Date).getTime();
    const expectedMin = before - 180 * 24 * 60 * 60 * 1000;
    const expectedMax = after - 180 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff).toBeLessThanOrEqual(expectedMax);
  });

  test("logs the deleted count and retention window on completion", async () => {
    mockDeleteAllOlderThan.mockResolvedValue(42);

    await handleAuditLogCleanup();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 42, retentionDays: 180 }),
      "audit-log retention sweep: complete",
    );
  });

  test("logs an error when the DELETE fails and does not throw", async () => {
    mockDeleteAllOlderThan.mockRejectedValueOnce(new Error("DB error"));

    await expect(handleAuditLogCleanup()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: "DB error", retentionDays: 180 }),
      "audit-log retention sweep: failed",
    );
  });

  test("uses the configured retentionDays to compute the cutoff", async () => {
    mockConfig.auditLog.retentionDays = 30;
    mockDeleteAllOlderThan.mockResolvedValue(2);

    const before = Date.now();
    await handleAuditLogCleanup();
    const after = Date.now();

    const cutoff = (mockDeleteAllOlderThan.mock.calls[0][0] as Date).getTime();
    const expectedMin = before - 30 * 24 * 60 * 60 * 1000;
    const expectedMax = after - 30 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff).toBeLessThanOrEqual(expectedMax);
  });
});
