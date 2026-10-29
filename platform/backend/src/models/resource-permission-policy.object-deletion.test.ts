import { ADMIN_ROLE_NAME, type ScopedResource } from "@archestra/shared";
import { withDbTransaction } from "@/database";
import {
  AppModel,
  ConversationModel,
  KbFileModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  VirtualApiKeyModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { projectService } from "@/services/project";
import { describe, expect, test } from "@/test";

/**
 * An object's permission policy is keyed by `(resource, scope = object id)`
 * with no foreign key to the object, so whatever removes the object for good
 * has to remove its policy too. Otherwise the policy outlives the object and
 * lingers forever, still naming the users and teams it was shared with.
 */
describe("removing an object for good removes its permission policy", () => {
  const policyOf = (params: {
    organizationId: string;
    resource: ScopedResource;
    scope: string;
  }) => ResourcePermissionPolicyModel.find(params);

  test("purging a knowledge connector", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const kb = await makeKnowledgeBase(organizationId);
    const connector = await makeKnowledgeBaseConnector(kb.id, organizationId);
    const key = {
      organizationId,
      resource: "knowledgeConnector" as const,
      scope: connector.id,
    };
    expect(await policyOf(key)).not.toBeNull();

    await KnowledgeBaseConnectorModel.delete(connector.id);
    // The trash keeps the grants, so a restore brings the sharing back.
    expect(await policyOf(key)).not.toBeNull();

    expect(
      await KnowledgeBaseConnectorModel.purge({
        id: connector.id,
        organizationId,
      }),
    ).toBe(true);
    expect(await policyOf(key)).toBeNull();
  });

  test("purging a knowledge base", async ({ makeOrganization }) => {
    const organizationId = (await makeOrganization()).id;
    const kb = await KnowledgeBaseModel.create({
      organizationId,
      name: "doomed",
    });
    const key = {
      organizationId,
      resource: "knowledgeBase" as const,
      scope: kb.id,
    };
    expect(await policyOf(key)).not.toBeNull();

    await KnowledgeBaseModel.delete(kb.id);
    expect(await policyOf(key)).not.toBeNull();

    expect(await KnowledgeBaseModel.purge({ id: kb.id, organizationId })).toBe(
      true,
    );
    expect(await policyOf(key)).toBeNull();
  });

  test("purging a project", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    await makeMember(owner.id, organizationId);
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "doomed",
      description: null,
    });
    const key = {
      organizationId,
      resource: "project" as const,
      scope: project.id,
    };
    expect(await policyOf(key)).not.toBeNull();

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });
    expect(await policyOf(key)).not.toBeNull();

    await projectService.purge({
      id: project.id,
      organizationId,
      userId: admin.id,
    });
    expect(await policyOf(key)).toBeNull();
  });

  test("deleting an app, which has no trash to restore it from", async ({
    makeOrganization,
    makeApp,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const app = await makeApp({ organizationId });
    const key = { organizationId, resource: "app" as const, scope: app.id };
    expect(await policyOf(key)).not.toBeNull();

    expect(await AppModel.delete(app.id)).toBe(true);
    expect(await policyOf(key)).toBeNull();
  });

  test("deleting a knowledge file", async ({ makeOrganization, makeUser }) => {
    const organizationId = (await makeOrganization()).id;
    const uploader = await makeUser();
    const file = await KbFileModel.create({
      organizationId,
      directoryId: null,
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      contentHash: "abc",
      data: Buffer.from("abc"),
      uploadedBy: uploader.id,
    });
    const key = {
      organizationId,
      resource: "knowledgeFile" as const,
      scope: file.id,
    };
    expect(await policyOf(key)).not.toBeNull();

    expect(await KbFileModel.delete({ id: file.id, organizationId })).toBe(
      true,
    );
    expect(await policyOf(key)).toBeNull();
  });

  test("deleting a virtual key", async ({
    makeOrganization,
    makeVirtualApiKey,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const virtualKey = await makeVirtualApiKey(organizationId);
    const key = {
      organizationId,
      resource: "llmVirtualKey" as const,
      scope: virtualKey.id,
    };
    expect(await policyOf(key)).not.toBeNull();

    expect(await VirtualApiKeyModel.delete(virtualKey.id)).toBe(true);
    expect(await policyOf(key)).toBeNull();
  });

  test("expiring a chat under the retention window", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    const agent = await makeAgent({ organizationId });
    const conversation = await ConversationModel.create({
      organizationId,
      userId: user.id,
      agentId: agent.id,
      title: "old",
    });
    const key = {
      organizationId,
      resource: "conversation" as const,
      scope: conversation.id,
    };
    expect(await policyOf(key)).not.toBeNull();

    await withDbTransaction((tx) =>
      ConversationModel.deleteExpiredLocked(tx, conversation.id),
    );
    expect(await policyOf(key)).toBeNull();
  });
});
