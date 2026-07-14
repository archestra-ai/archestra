// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { and, count, eq, sql } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { enqueuePermissionSyncAfterContentSync } from "@/knowledge-base";
import { TaskModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";

async function permissionSyncTaskCount(connectorId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.tasksTable)
    .where(
      and(
        eq(schema.tasksTable.taskType, "permission_sync"),
        sql`${schema.tasksTable.payload}->>'connectorId' = ${connectorId}`,
      ),
    );
  return row?.value ?? 0;
}

describe("enqueuePermissionSyncAfterContentSync (documents-sync trigger)", () => {
  beforeEach(() => {
    config.kb.autoSyncPermissionsEnabled = true;
  });

  test("no-ops when the auto-sync permissions beta flag is off", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    config.kb.autoSyncPermissionsEnabled = false;
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });

    await enqueuePermissionSyncAfterContentSync({
      connector,
      documentsIngested: 3,
    });

    expect(await permissionSyncTaskCount(connector.id)).toBe(0);
  });

  test("enqueues a permission_sync when an auto-sync connector ingested >=1 doc", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });

    await enqueuePermissionSyncAfterContentSync({
      connector,
      documentsIngested: 3,
    });

    expect(
      await TaskModel.hasPendingOrProcessing("permission_sync", connector.id),
    ).toBe(true);
  });

  test("de-duplicates when a permission_sync is already pending for the connector", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });

    await enqueuePermissionSyncAfterContentSync({
      connector,
      documentsIngested: 1,
    });
    await enqueuePermissionSyncAfterContentSync({
      connector,
      documentsIngested: 5,
    });

    // One pass fully reconciles all pending new docs, so the second call is a
    // no-op — never a second queued task.
    expect(await permissionSyncTaskCount(connector.id)).toBe(1);
  });

  test("enqueues after an ingest-free sync too — a pass may still have stranded docs to adopt", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });

    await enqueuePermissionSyncAfterContentSync({
      connector,
      documentsIngested: 0,
    });

    expect(await permissionSyncTaskCount(connector.id)).toBe(1);
  });

  test("does not enqueue for a non-auto-sync connector", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "org-wide",
      connectorType: "github",
    });

    await enqueuePermissionSyncAfterContentSync({
      connector,
      documentsIngested: 4,
    });

    expect(await permissionSyncTaskCount(connector.id)).toBe(0);
  });
});
