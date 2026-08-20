// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { describe, expect, test } from "@/test";
import ConnectorRunModel from "./connector-run";
import KbContainerAclModel from "./kb-container-acl";
import KbExternalUserGroupModel from "./kb-external-user-group";

/**
 * The container audience is what decides which principals a document's
 * `container:` token expands for, so a write here grants and revokes real
 * access. These pin that a pass which no longer owns its run cannot make one.
 */
describe("KbContainerAclModel.upsertMany run fence", () => {
  test("writes while the run is still owned", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeConnectorRun,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const run = await makeConnectorRun(connector.id, {
      runType: "permission",
      status: "running",
    });

    const written = await KbContainerAclModel.upsertMany(
      [
        {
          organizationId: org.id,
          connectorId: connector.id,
          containerKey: "//depot/docs",
          acl: ["user_email:analyst@example.com"],
          fingerprint: "v1",
        },
      ],
      { runId: run.id, epoch: run.leaseEpoch },
    );

    expect(written).toBe(true);
    const stored = await KbContainerAclModel.findAudienceStateByKeys({
      connectorId: connector.id,
      containerKeys: ["//depot/docs"],
    });
    expect(stored.get("//depot/docs")?.acl).toEqual([
      "user_email:analyst@example.com",
    ]);
  });

  test("refuses a write from a run whose lease was reclaimed", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeConnectorRun,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const run = await makeConnectorRun(connector.id, {
      runType: "permission",
      status: "running",
    });
    const staleEpoch = run.leaseEpoch;

    // A correct, current pass records that the analyst lost access.
    await KbContainerAclModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connector.id,
        containerKey: "//depot/docs",
        acl: [],
        fingerprint: "v2",
      },
    ]);

    // The reaper declares the frozen worker dead, bumping the epoch.
    await ConnectorRunModel.reapExpiredRuns("permission");
    await ConnectorRunModel.supersedeRunningForConnector({
      connectorId: connector.id,
      runType: "permission",
      reason: "test",
    });

    // The frozen worker thaws and writes the audience it computed before the
    // revocation. Left unfenced this restores the analyst's read access to
    // every document holding this container's token.
    const written = await KbContainerAclModel.upsertMany(
      [
        {
          organizationId: org.id,
          connectorId: connector.id,
          containerKey: "//depot/docs",
          acl: ["user_email:analyst@example.com"],
          fingerprint: "v1",
        },
      ],
      { runId: run.id, epoch: staleEpoch },
    );

    expect(written).toBe(false);
    const stored = await KbContainerAclModel.findAudienceStateByKeys({
      connectorId: connector.id,
      containerKeys: ["//depot/docs"],
    });
    expect(stored.get("//depot/docs")?.acl).toEqual([]);
  });

  test("refuses a write for a run that is no longer running", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeConnectorRun,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const run = await makeConnectorRun(connector.id, {
      runType: "permission",
      status: "success",
    });

    const written = await KbContainerAclModel.upsertMany(
      [
        {
          organizationId: org.id,
          connectorId: connector.id,
          containerKey: "//depot/docs",
          acl: ["org:*"],
          fingerprint: "v1",
        },
      ],
      { runId: run.id, epoch: run.leaseEpoch },
    );

    expect(written).toBe(false);
  });

  test("writes unfenced when no run owns the call", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const written = await KbContainerAclModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connector.id,
        containerKey: "//depot/docs",
        acl: ["org:*"],
        fingerprint: "v1",
      },
    ]);

    expect(written).toBe(true);
  });
});

/**
 * Group membership is the second route into a document: a `group:` token here
 * is matched against a container's audience, so restoring a removed member
 * restores their read access without any ACL row being touched.
 */
describe("KbExternalUserGroupModel.upsertMany run fence", () => {
  const membership = (org: string, connectorId: string, email: string) => ({
    organizationId: org,
    connectorId,
    connectorType: "perforce" as const,
    groupId: "engineers",
    externalAccountId: email,
    displayName: email,
    memberEmail: email,
    accountType: "user" as const,
  });

  test("writes while the run is still owned", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeConnectorRun,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const run = await makeConnectorRun(connector.id, {
      runType: "permission",
      status: "running",
    });

    const written = await KbExternalUserGroupModel.upsertMany(
      [membership(org.id, connector.id, "alice@example.com")],
      { runId: run.id, epoch: run.leaseEpoch },
    );

    expect(written).toBe(true);
    const rows =
      await KbExternalUserGroupModel.findMembershipSnapshotByConnector(
        connector.id,
      );
    expect(rows.length).toBe(1);
  });

  test("refuses a membership write from a reclaimed run", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeConnectorRun,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const run = await makeConnectorRun(connector.id, {
      runType: "permission",
      status: "running",
    });
    const staleEpoch = run.leaseEpoch;

    await ConnectorRunModel.supersedeRunningForConnector({
      connectorId: connector.id,
      runType: "permission",
      reason: "test",
    });

    // The thawed worker puts a member back into a group they were removed from.
    const written = await KbExternalUserGroupModel.upsertMany(
      [membership(org.id, connector.id, "alice@example.com")],
      { runId: run.id, epoch: staleEpoch },
    );

    expect(written).toBe(false);
    const rows =
      await KbExternalUserGroupModel.findMembershipSnapshotByConnector(
        connector.id,
      );
    expect(rows.length).toBe(0);
  });
});
