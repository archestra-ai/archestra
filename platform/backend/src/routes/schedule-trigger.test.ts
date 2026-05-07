import { type Mock, vi } from "vitest";
import ConversationModel from "@/models/conversation";
import MessageModel from "@/models/message";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasAnyAgentTypeAdminPermission: vi.fn().mockResolvedValue(false),
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

describe("schedule trigger routes", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    adminUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(adminUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = adminUser;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: scheduleTriggerRoutes } = await import(
      "./schedule-trigger"
    );
    await app.register(scheduleTriggerRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns an existing run conversation for scheduled task admins when it belongs to another user", async ({
    makeAgent,
    makeMember,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeUser,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "org",
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      agentId: agent.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, {
      organizationId,
      runKind: "due",
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        id: "message-1",
        role: "assistant",
        parts: [{ type: "text", text: "Scheduled task result" }],
      },
    });
    await ScheduleTriggerRunModel.setChatConversationId(
      run.id,
      conversation.id,
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${trigger.id}/runs/${run.id}/conversation`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: conversation.id,
      userId: owner.id,
      messages: [
        expect.objectContaining({
          id: expect.any(String),
          parts: [{ type: "text", text: "Scheduled task result" }],
        }),
      ],
    });
  });

  test("returns 403 when a non-admin opens another user's run conversation", async ({
    makeAgent,
    makeMember,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeUser,
  }) => {
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const owner = await makeUser();
    const member = await makeUser();
    await makeMember(owner.id, organizationId, { role: "member" });
    await makeMember(member.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "org",
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      agentId: agent.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, {
      organizationId,
      runKind: "due",
    });

    adminUser = member;

    const response = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${trigger.id}/runs/${run.id}/conversation`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "You do not have access to this scheduled task",
    );
  });
});
