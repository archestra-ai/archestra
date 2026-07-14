// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { KbExternalUserGroupModel, KbMemberOverrideModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("KbExternalUserGroupModel", () => {
  test("upsertMany normalizes emails and findGroupTokensForUser resolves namespaced tokens", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });

    await KbExternalUserGroupModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "eng",
        externalAccountId: "Alice@Example.com",
        memberEmail: "Alice@Example.com",
      },
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "ops",
        externalAccountId: "bob@example.com",
        memberEmail: "bob@example.com",
      },
    ]);

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: " alice@example.com ",
      connectorIds: [connector.id],
    });

    expect(tokens.sort()).toEqual(["group:github_eng"]);
  });

  test("snapshot diff: deleteByKeys removes revoked memberships only", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });

    const seed = (groupId: string) => ({
      organizationId: org.id,
      connectorId: connector.id,
      connectorType: "github" as const,
      groupId,
      externalAccountId: "user@example.com",
      memberEmail: "user@example.com",
    });

    await KbExternalUserGroupModel.upsertMany([seed("eng"), seed("ops")]);

    // A fresh sync run re-observed only "eng": the stored snapshot diff names
    // ("ops", user) as revoked.
    const snapshot =
      await KbExternalUserGroupModel.findMembershipSnapshotByConnector(
        connector.id,
      );
    expect(snapshot.map((row) => row.groupId).sort()).toEqual(["eng", "ops"]);
    await KbExternalUserGroupModel.deleteByKeys({
      connectorId: connector.id,
      keys: [{ groupId: "ops", externalAccountId: "user@example.com" }],
    });

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: "user@example.com",
      connectorIds: [connector.id],
    });

    expect(tokens).toEqual(["group:github_eng"]);
  });

  test("findGroupTokensForUser unions the automatically matched groups with the override-granted ones", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });
    const alice = await makeUser({ email: "alice@example.com" });
    await makeMember(alice.id, org.id);

    await KbExternalUserGroupModel.upsertMany([
      // Automatically matched: the upstream account carries Alice's email.
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "eng",
        externalAccountId: "alice@example.com",
        memberEmail: "alice@example.com",
      },
      // A second upstream account whose email is hidden — Alice reaches this
      // group only through an admin's override.
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "ops",
        externalAccountId: "acc-hidden",
        memberEmail: null,
      },
    ]);
    await KbMemberOverrideModel.upsert({
      organizationId: org.id,
      connectorId: connector.id,
      externalAccountId: "acc-hidden",
      userId: alice.id,
    });

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: "alice@example.com",
      userId: alice.id,
      connectorIds: [connector.id],
    });

    // Both grant paths, not whichever one is queried first.
    expect(tokens.sort()).toEqual(["group:github_eng", "group:github_ops"]);
  });

  test("findGroupTokensForUser scopes to the given connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connectorA = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });
    const connectorB = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "jira",
      visibility: "auto-sync-permissions",
    });

    await KbExternalUserGroupModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connectorA.id,
        connectorType: "github",
        groupId: "eng",
        externalAccountId: "user@example.com",
        memberEmail: "user@example.com",
      },
      {
        organizationId: org.id,
        connectorId: connectorB.id,
        connectorType: "jira",
        groupId: "dev",
        externalAccountId: "user@example.com",
        memberEmail: "user@example.com",
      },
    ]);

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: "user@example.com",
      connectorIds: [connectorA.id],
    });

    expect(tokens).toEqual(["group:github_eng"]);
  });
});
