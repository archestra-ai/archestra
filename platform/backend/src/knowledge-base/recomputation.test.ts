import { describe, expect, vi } from "vitest";
import { KbDocumentModel, TeamModel } from "@/models";
import { test } from "@/test";
import {
  handleTeamOrGroupMappingChange,
  recomputeConnectorPermissions,
} from "./recomputation";

describe("recomputeConnectorPermissions", () => {
  test("skips non-auto-sync connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "org-wide",
    });

    // Create a document with rawPermissions
    const doc = await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: connector.id,
      title: "Test Doc",
      content: "content",
      contentHash: "hash-1",
      acl: ["org:*"],
      permissionSyncStatus: "synced",
      permissionSyncMetadata: {
        provider: "google-drive",
        rawPermissions: { isPublic: false, users: [], groups: [] },
      },
    });

    await recomputeConnectorPermissions(connector.id);

    // Document should remain unchanged because connector is not auto-sync
    const updatedDoc = await KbDocumentModel.findById(doc.id);
    expect(updatedDoc?.acl).toEqual(["org:*"]);
  });

  test("skips docs without permissionSyncStatus", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });

    // Create a document without permissionSyncStatus set (null-like via default)
    // The schema defaults to "synced", so we create a doc and then set it to null via raw update
    const doc = await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: connector.id,
      title: "No Sync Status Doc",
      content: "content",
      contentHash: "hash-no-status",
      acl: ["org:*"],
    });

    // Mock findAllByConnector to return the document with null permissionSyncStatus (bypassing DB constraints)
    const spy = vi
      .spyOn(KbDocumentModel, "findAllByConnector")
      .mockResolvedValue([
        {
          ...doc,
          permissionSyncStatus: null as unknown as "synced",
        },
      ]);

    await recomputeConnectorPermissions(connector.id);

    // Document should remain unchanged because permissionSyncStatus is null
    const updatedDoc = await KbDocumentModel.findById(doc.id);
    expect(updatedDoc?.acl).toEqual(["org:*"]);
    spy.mockRestore();
  });

  test("skips docs without rawPermissions in metadata", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });

    // Create a document with permissionSyncStatus but no rawPermissions in metadata
    const doc = await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: connector.id,
      title: "No Raw Permissions Doc",
      content: "content",
      contentHash: "hash-no-raw",
      acl: ["org:*"],
      permissionSyncStatus: "synced",
      permissionSyncMetadata: {
        provider: "google-drive",
        // no rawPermissions field
      },
    });

    await recomputeConnectorPermissions(connector.id);

    // Document should remain unchanged because rawPermissions is absent
    const updatedDoc = await KbDocumentModel.findById(doc.id);
    expect(updatedDoc?.acl).toEqual(["org:*"]);
  });

  test("re-materializes and updates ACL when group mappings change", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });

    const user1 = await makeUser({ email: "user1@example.com" });
    await makeMember(user1.id, org.id, { role: "member" });

    // Create a document with rawPermissions referencing an unmapped group
    const doc = await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: connector.id,
      title: "Group Doc",
      content: "content",
      contentHash: "hash-group",
      acl: [],
      permissionSyncStatus: "skipped_unresolvable",
      permissionSyncMetadata: {
        provider: "google-drive",
        rawPermissions: {
          isPublic: false,
          users: ["user1@example.com"],
          groups: ["ext-group-1"],
        },
        skippedGroups: ["ext-group-1"],
      },
    });

    // Now create the team mapping that was previously missing
    const team = await makeTeam(org.id, user1.id);
    await TeamModel.addExternalGroup(team.id, "ext-group-1");
    await makeTeamMember(team.id, user1.id);

    // Recompute should now resolve the group and update the ACL
    await recomputeConnectorPermissions(connector.id);

    const updatedDoc = await KbDocumentModel.findById(doc.id);
    expect(updatedDoc?.acl).toEqual(["user_email:user1@example.com"]);
    expect(updatedDoc?.permissionSyncStatus).toBe("synced");
    expect(
      (updatedDoc?.permissionSyncMetadata as { skippedGroups?: string[] })
        ?.skippedGroups,
    ).toEqual([]);
  });

  test("clears ACL when materialization is incomplete (fail-closed)", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });

    const user1 = await makeUser({ email: "user1@example.com" });
    await makeMember(user1.id, org.id, { role: "member" });

    // Create a document with rawPermissions that reference an unmapped group
    // Initially set with a stale ACL that should be cleared
    const doc = await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: connector.id,
      title: "Incomplete Doc",
      content: "content",
      contentHash: "hash-incomplete",
      acl: ["user_email:user1@example.com"],
      permissionSyncStatus: "synced",
      permissionSyncMetadata: {
        provider: "google-drive",
        rawPermissions: {
          isPublic: false,
          users: ["user1@example.com"],
          groups: ["unmapped-group"],
        },
      },
    });

    // No team mapping exists for "unmapped-group", so materialization is incomplete
    await recomputeConnectorPermissions(connector.id);

    const updatedDoc = await KbDocumentModel.findById(doc.id);
    // Fail-closed: ACL should be cleared (empty) when resolution is incomplete
    expect(updatedDoc?.acl).toEqual([]);
    expect(updatedDoc?.permissionSyncStatus).toBe("skipped_unresolvable");
    expect(
      (updatedDoc?.permissionSyncMetadata as { skippedGroups?: string[] })
        ?.skippedGroups,
    ).toEqual(["unmapped-group"]);
  });
});

describe("handleTeamOrGroupMappingChange", () => {
  test("processes only auto-sync connectors for the organization", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);

    const user1 = await makeUser({ email: "user1@example.com" });
    await makeMember(user1.id, org.id, { role: "member" });

    // Create an auto-sync connector with a document
    const autoSyncConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });

    const docAutoSync = await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: autoSyncConnector.id,
      title: "Auto Sync Doc",
      content: "content",
      contentHash: "hash-auto",
      acl: [],
      permissionSyncStatus: "skipped_unresolvable",
      permissionSyncMetadata: {
        provider: "google-drive",
        rawPermissions: {
          isPublic: false,
          users: ["user1@example.com"],
          groups: ["ext-group-mapping"],
        },
        skippedGroups: ["ext-group-mapping"],
      },
    });

    // Create a non-auto-sync connector with a document
    const orgConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "org-wide",
    });

    const docOrg = await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: orgConnector.id,
      title: "Org Doc",
      content: "content",
      contentHash: "hash-org",
      acl: ["org:*"],
      permissionSyncStatus: "synced",
      permissionSyncMetadata: {
        provider: "google-drive",
        rawPermissions: {
          isPublic: false,
          users: [],
          groups: ["ext-group-mapping"],
        },
      },
    });

    // Now create a team mapping
    const team = await makeTeam(org.id, user1.id);
    await TeamModel.addExternalGroup(team.id, "ext-group-mapping");
    await makeTeamMember(team.id, user1.id);

    // Trigger recomputation for the org
    await handleTeamOrGroupMappingChange(org.id);

    // Auto-sync connector's doc should be updated
    const updatedAutoSyncDoc = await KbDocumentModel.findById(docAutoSync.id);
    expect(updatedAutoSyncDoc?.acl).toEqual(["user_email:user1@example.com"]);
    expect(updatedAutoSyncDoc?.permissionSyncStatus).toBe("synced");

    // Org connector's doc should remain unchanged (not an auto-sync connector)
    const updatedOrgDoc = await KbDocumentModel.findById(docOrg.id);
    expect(updatedOrgDoc?.acl).toEqual(["org:*"]);
  });
});
