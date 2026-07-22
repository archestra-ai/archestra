import { vi } from "vitest";

vi.mock("@/logging");

import { count } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import { AuditLogModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { handleAuditLogCleanup } from "./audit-log-cleanup-handler";

async function seedAuditLog(organizationId: string, createdAt: Date) {
  await db.insert(schema.auditLogsTable).values({
    organizationId,
    occurredAt: createdAt,
    createdAt,
    actorType: "user",
    action: "agent.created",
    outcome: "success",
  });
}

async function countAuditLogs(): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(schema.auditLogsTable);
  return Number(total);
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("handleAuditLogCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.auditLog.retentionDays = 180;
  });

  test("logs and returns early when retentionDays is 0", async ({
    makeOrganization,
  }) => {
    config.auditLog.retentionDays = 0;
    const org = await makeOrganization();
    await seedAuditLog(org.id, new Date(Date.now() - 365 * DAY_MS));

    await handleAuditLogCleanup();

    // Nothing is deleted when retention is disabled.
    expect(await countAuditLogs()).toBe(1);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 0 }),
      expect.stringContaining("disabled"),
    );
  });

  test("deletes rows older than the cutoff across all orgs, keeps newer ones", async ({
    makeOrganization,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();

    // Older than the 180-day window → should be deleted (both orgs).
    await seedAuditLog(orgA.id, new Date(Date.now() - 181 * DAY_MS));
    await seedAuditLog(orgB.id, new Date(Date.now() - 200 * DAY_MS));
    // Newer than the window → should survive.
    await seedAuditLog(orgA.id, new Date(Date.now() - 179 * DAY_MS));
    await seedAuditLog(orgB.id, new Date(Date.now() - 10 * DAY_MS));

    await handleAuditLogCleanup();

    expect(await countAuditLogs()).toBe(2);
  });

  test("logs the deleted count and retention window on completion", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await seedAuditLog(org.id, new Date(Date.now() - 200 * DAY_MS));
    await seedAuditLog(org.id, new Date(Date.now() - 190 * DAY_MS));
    await seedAuditLog(org.id, new Date(Date.now() - 185 * DAY_MS));

    await handleAuditLogCleanup();

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 3, retentionDays: 180 }),
      "audit-log retention sweep: complete",
    );
  });

  test("logs an error when the DELETE fails and does not throw", async () => {
    vi.spyOn(AuditLogModel, "deleteAllOlderThan").mockRejectedValueOnce(
      new Error("DB error"),
    );

    await expect(handleAuditLogCleanup()).resolves.toBeUndefined();

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ error: "DB error", retentionDays: 180 }),
      "audit-log retention sweep: failed",
    );
  });

  test("uses the configured retentionDays to compute the cutoff", async ({
    makeOrganization,
  }) => {
    config.auditLog.retentionDays = 30;
    const org = await makeOrganization();
    // Older than 30 days → deleted.
    await seedAuditLog(org.id, new Date(Date.now() - 31 * DAY_MS));
    // Newer than 30 days → kept.
    await seedAuditLog(org.id, new Date(Date.now() - 29 * DAY_MS));

    await handleAuditLogCleanup();

    expect(await countAuditLogs()).toBe(1);
  });
});
