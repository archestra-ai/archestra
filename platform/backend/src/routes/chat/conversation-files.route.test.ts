// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ConversationModel from "@/models/conversation";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import { projectService } from "@/services/project";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { shareForTest } from "@/test/sharing";
import { grantRoleEverywhere } from "@/test/wildcard-grants";
import routes from "./routes";

describe("conversation file read access", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
  });

  test("owners and explicit readers see the same files, while management stays owner-only", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const owner = ctx.user;
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const conversation = await ConversationModel.create({
      organizationId: ctx.organizationId,
      userId: owner.id,
      agentId: agent.id,
    });
    const attachment = await attach({
      conversationId: conversation.id,
      organizationId: ctx.organizationId,
      userId: owner.id,
    });
    const url = `/api/chat/conversations/${conversation.id}/files`;
    const own = await ctx.app.inject({ method: "GET", url });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      canManageFiles: true,
      attachments: [
        {
          id: attachment.id,
          name: "notes.txt",
          mimeType: "text/plain",
          contentUrl: `/api/chat/attachments/${attachment.id}/content`,
        },
      ],
    });
    const reader = await makeUser();
    await makeMember(reader.id, ctx.organizationId);
    ctx.user = reader;
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(404);
    const byteUrl = `/api/chat/attachments/${attachment.id}/content`;
    expect(
      (await ctx.app.inject({ method: "GET", url: byteUrl })).statusCode,
    ).toBe(403);
    await shareForTest({
      organizationId: ctx.organizationId,
      resource: "conversation",
      scope: conversation.id,
      visibility: "user",
      userIds: [reader.id],
    });
    const shared = await ctx.app.inject({ method: "GET", url });
    expect(shared.statusCode).toBe(200);
    expect(shared.json()).toEqual({ ...own.json(), canManageFiles: false });
    const bytes = await ctx.app.inject({ method: "GET", url: byteUrl });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe("notes");
  });

  test("foreign, missing and deleted conversations remain undiscoverable", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const foreign = await makeOrganization();
    const agent = await makeAgent({ organizationId: foreign.id });
    const conversation = await ConversationModel.create({
      organizationId: foreign.id,
      userId: ctx.user.id,
      agentId: agent.id,
    });
    const attachment = await attach({
      conversationId: conversation.id,
      organizationId: foreign.id,
      userId: ctx.user.id,
    });
    for (const id of [conversation.id, crypto.randomUUID()]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/chat/conversations/${id}/files`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("Conversation not found");
    }
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/chat/attachments/${attachment.id}/content`,
        })
      ).statusCode,
    ).toBe(403);
    const local = await ConversationModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      agentId: agent.id,
    });
    await ConversationModel.delete(local.id, ctx.user.id, ctx.organizationId);
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/chat/conversations/${local.id}/files`,
        })
      ).statusCode,
    ).toBe(404);
  });

  test("project access and the read-all-chat grant are both required for another author's files", async ({
    makeAgent,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, ctx.organizationId);
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const project = await projectService.create({
      organizationId: ctx.organizationId,
      userId: owner.id,
      name: "Shared research",
      description: null,
    });
    const conversation = await ConversationModel.create({
      organizationId: ctx.organizationId,
      userId: owner.id,
      agentId: agent.id,
      projectId: project.id,
    });
    const attachment = await attach({
      conversationId: conversation.id,
      organizationId: ctx.organizationId,
      userId: owner.id,
    });
    await shareForTest({
      organizationId: ctx.organizationId,
      resource: "project",
      scope: project.id,
      visibility: "organization",
    });
    const url = `/api/chat/conversations/${conversation.id}/files`;
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(404);
    const role = await makeCustomRole(ctx.organizationId, { permission: {} });
    await grantRoleEverywhere({
      organizationId: ctx.organizationId,
      resource: "conversation",
      roleId: role.id,
      actions: ["read"],
    });
    const reader = await makeUser();
    await makeMember(reader.id, ctx.organizationId, { role: role.role });
    ctx.user = reader;
    const shared = await ctx.app.inject({ method: "GET", url });
    expect(shared.statusCode).toBe(200);
    expect(shared.json()).toMatchObject({
      projectName: "Shared research",
      canManageFiles: false,
      attachments: [{ id: attachment.id }],
    });
    await shareForTest({
      organizationId: ctx.organizationId,
      resource: "project",
      scope: project.id,
      visibility: null,
    });
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(404);
  });

  test("scheduled-run oversight permits its files without opening unrelated private chats", async ({
    makeAgent,
    makeUser,
    makeMember,
    makeAdmin,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, ctx.organizationId);
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const conversation = await ConversationModel.create({
      organizationId: ctx.organizationId,
      userId: owner.id,
      agentId: agent.id,
    });
    const attachment = await attach({
      conversationId: conversation.id,
      organizationId: ctx.organizationId,
      userId: owner.id,
    });
    const trigger = await makeScheduleTrigger({
      organizationId: ctx.organizationId,
      actorUserId: owner.id,
      agentId: agent.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, {
      organizationId: ctx.organizationId,
    });
    await ScheduleTriggerRunModel.setChatConversationId(
      run.id,
      conversation.id,
    );
    const url = `/api/chat/conversations/${conversation.id}/files`;
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(404);
    const admin = await makeAdmin();
    await makeMember(admin.id, ctx.organizationId, { role: "admin" });
    ctx.user = admin;
    const response = await ctx.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      canManageFiles: false,
      attachments: [{ id: attachment.id }],
    });
    const foreignOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: foreignOrg.id });
    const foreign = await ConversationModel.create({
      organizationId: foreignOrg.id,
      userId: owner.id,
      agentId: foreignAgent.id,
    });
    await ScheduleTriggerRunModel.setChatConversationId(run.id, foreign.id);
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/chat/conversations/${foreign.id}/files`,
        })
      ).statusCode,
    ).toBe(404);

    const unrelated = await ConversationModel.create({
      organizationId: ctx.organizationId,
      userId: owner.id,
      agentId: agent.id,
    });
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/chat/conversations/${unrelated.id}/files`,
        })
      ).statusCode,
    ).toBe(404);
  });
});

function attach(params: {
  conversationId: string;
  organizationId: string;
  userId: string;
}) {
  return ConversationAttachmentModel.create({
    conversationId: params.conversationId,
    organizationId: params.organizationId,
    uploadedByUserId: params.userId,
    originalName: "notes.txt",
    mimeType: "text/plain",
    fileSize: 5,
    contentHash: "notes-hash",
    fileData: Buffer.from("notes"),
    textPreviewStatus: "unsupported",
  });
}
