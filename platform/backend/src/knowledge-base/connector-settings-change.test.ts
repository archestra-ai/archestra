// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  TaskModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import type { ConnectorConfig } from "@/types";
import { supersedePermissionSyncAfterSettingsChange } from "./connector-settings-change";

const perforceConfig: ConnectorConfig = {
  type: "perforce",
  serverUrl: "https://perforce.example.com:1666",
  depotPaths: ["//depot/docs"],
  adminUsername: "p4admin",
};

async function makeAutoSyncConnector(organizationId: string) {
  return KnowledgeBaseConnectorModel.create({
    organizationId,
    name: `Perforce ${crypto.randomUUID().slice(0, 8)}`,
    connectorType: "perforce",
    config: perforceConfig,
    visibility: "auto-sync-permissions",
  });
}

async function makeRunningRun(
  connectorId: string,
  runType: "content" | "permission",
) {
  return ConnectorRunModel.create({
    connectorId,
    runType,
    status: "running",
    startedAt: new Date(),
    leaseOwner: "worker-1",
    leaseEpoch: 0,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
}

describe("supersedePermissionSyncAfterSettingsChange", () => {
  test("stops the pass computed against the settings the update replaced", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeAutoSyncConnector(org.id);
    const run = await makeRunningRun(connector.id, "permission");

    await supersedePermissionSyncAfterSettingsChange({
      connectorId: connector.id,
      visibility: "auto-sync-permissions",
      enabled: true,
    });

    const stopped = await ConnectorRunModel.findById(run.id);
    expect(stopped?.status).toBe("superseded");
    // The bumped epoch is what makes the pass's remaining writes no-op — it
    // holds the old epoch and cannot tell it has been superseded.
    expect(stopped?.leaseEpoch).toBe(1);
    expect(
      await ConnectorRunModel.renewLease({
        runId: run.id,
        owner: "worker-1",
        epoch: 0,
        leaseTtlSeconds: 60,
      }),
    ).toBe(false);
  });

  test("leaves a content sync running: a document ingest is unaffected by permission settings", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeAutoSyncConnector(org.id);
    const contentRun = await makeRunningRun(connector.id, "content");

    await supersedePermissionSyncAfterSettingsChange({
      connectorId: connector.id,
      visibility: "auto-sync-permissions",
      enabled: true,
    });

    expect((await ConnectorRunModel.findById(contentRun.id))?.status).toBe(
      "running",
    );
  });

  test("leaves other connectors' permission passes alone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const edited = await makeAutoSyncConnector(org.id);
    const other = await makeAutoSyncConnector(org.id);
    const otherRun = await makeRunningRun(other.id, "permission");

    await supersedePermissionSyncAfterSettingsChange({
      connectorId: edited.id,
      visibility: "auto-sync-permissions",
      enabled: true,
    });

    expect((await ConnectorRunModel.findById(otherRun.id))?.status).toBe(
      "running",
    );
  });

  test("queues a replacement pass, so the corpus is not left half-reconciled", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeAutoSyncConnector(org.id);

    await supersedePermissionSyncAfterSettingsChange({
      connectorId: connector.id,
      visibility: "auto-sync-permissions",
      enabled: true,
    });

    expect(
      await TaskModel.hasPendingOrProcessing("permission_sync", connector.id),
    ).toBe(true);
  });

  test("a burst of edits queues one pass, not one per edit", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeAutoSyncConnector(org.id);

    await supersedePermissionSyncAfterSettingsChange({
      connectorId: connector.id,
      visibility: "auto-sync-permissions",
      enabled: true,
    });
    await supersedePermissionSyncAfterSettingsChange({
      connectorId: connector.id,
      visibility: "auto-sync-permissions",
      enabled: true,
    });

    const queued = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "permission_sync"));
    expect(queued).toHaveLength(1);
  });

  test("a connector switched away from auto-sync is stopped, not re-queued", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeAutoSyncConnector(org.id);
    const run = await makeRunningRun(connector.id, "permission");

    await supersedePermissionSyncAfterSettingsChange({
      connectorId: connector.id,
      visibility: "org-wide",
      enabled: true,
    });

    expect((await ConnectorRunModel.findById(run.id))?.status).toBe(
      "superseded",
    );
    expect(
      await TaskModel.hasPendingOrProcessing("permission_sync", connector.id),
    ).toBe(false);
  });

  test("a connector switched off is stopped, not re-queued", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeAutoSyncConnector(org.id);
    const run = await makeRunningRun(connector.id, "permission");

    await supersedePermissionSyncAfterSettingsChange({
      connectorId: connector.id,
      visibility: "auto-sync-permissions",
      enabled: false,
    });

    // Disabling removes the connector's shim, so a replacement pass would
    // start, find no pod, and fail — for a connector nobody is waiting on.
    expect((await ConnectorRunModel.findById(run.id))?.status).toBe(
      "superseded",
    );
    expect(
      await TaskModel.hasPendingOrProcessing("permission_sync", connector.id),
    ).toBe(false);
  });
});

test("clears the stopped pass's `running` stamp off the connector", async ({
  makeOrganization,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
  makeConnectorRun,
}) => {
  const org = await makeOrganization();
  const kb = await makeKnowledgeBase(org.id);
  const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
    visibility: "auto-sync-permissions",
    enabled: true,
  });
  await makeConnectorRun(connector.id, {
    runType: "permission",
    status: "running",
  });
  await KnowledgeBaseConnectorModel.update(connector.id, {
    lastPermissionSyncStatus: "running",
  });

  await supersedePermissionSyncAfterSettingsChange({
    connectorId: connector.id,
    visibility: "auto-sync-permissions",
    enabled: true,
  });

  // The stopped pass writes nothing on its way out, and the replacement is
  // often skipped because it claims while this is still settling — so without
  // this the UI shows a run that no longer exists until the next scheduled
  // pass, half an hour later.
  const after = await KnowledgeBaseConnectorModel.findById(connector.id);
  expect(after?.lastPermissionSyncStatus).toBe("superseded");
});
