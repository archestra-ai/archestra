import { type Mock, vi } from "vitest";
import ConversationModel from "@/models/conversation";
import MessageModel from "@/models/message";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
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

  test("returns the schedule's shared conversation (with its run history) for scheduled task admins when it belongs to another user", async ({
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
    // All runs share the trigger's conversation, so the run-conversation route
    // resolves it from the trigger link (not a per-run link).
    await ScheduleTriggerModel.setChatConversationId(
      trigger.id,
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

  test("POST /conversation creates and reuses one shared conversation for a schedule", async ({
    makeInternalAgent,
    makeScheduleTrigger,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: adminUser.id,
      agentId: agent.id,
    });

    const first = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${trigger.id}/conversation`,
    });
    expect(first.statusCode).toBe(200);
    const conversationId = first.json().id as string;
    expect(conversationId).toEqual(expect.any(String));
    expect(first.json().origin).toBe("schedule_trigger");

    // The trigger is now linked, and a second open returns the same chat.
    const linked = await ScheduleTriggerModel.findById(trigger.id);
    expect(linked?.chatConversationId).toBe(conversationId);

    const second = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${trigger.id}/conversation`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(conversationId);
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

  test("POST /conversation lets a project member who is not the actor open a project schedule's chat", async ({
    makeInternalAgent,
    makeMember,
    makeScheduleTrigger,
    makeUser,
  }) => {
    // Not the actor and not a scheduledTask admin — access comes purely from
    // project membership (mirrors the project-scoped schedule listing).
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const actor = await makeUser();
    const member = await makeUser();
    await makeMember(actor.id, organizationId, { role: "member" });
    await makeMember(member.id, organizationId, { role: "member" });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: actor.id,
      scope: "org",
    });
    // The member owns the project, so they can see (and now open) its schedules.
    const project = await projectService.create({
      organizationId,
      userId: member.id,
      name: "shared",
      description: null,
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: actor.id,
      agentId: agent.id,
      projectId: project.id,
    });

    adminUser = member;

    const response = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${trigger.id}/conversation`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().projectId).toBe(project.id);
  });

  test("POST /conversation 403s for a non-actor without project access", async ({
    makeInternalAgent,
    makeMember,
    makeScheduleTrigger,
    makeUser,
  }) => {
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const actor = await makeUser();
    const stranger = await makeUser();
    await makeMember(actor.id, organizationId, { role: "member" });
    await makeMember(stranger.id, organizationId, { role: "member" });
    const agent = await makeInternalAgent({
      organizationId,
      authorId: actor.id,
      scope: "org",
    });
    // Unscoped schedule: there is no project to grant the stranger access.
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: actor.id,
      agentId: agent.id,
    });

    adminUser = stranger;

    const response = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${trigger.id}/conversation`,
    });

    expect(response.statusCode).toBe(403);
  });

  test("POST create requires a project when the projects feature is on", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
      scope: "org",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/schedule-triggers",
      payload: {
        name: "No project",
        agentId: agent.id,
        messageTemplate: "go",
        cronExpression: "* * * * *",
        timezone: "UTC",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "A project is required for scheduled tasks",
    );
  });

  test("POST create associates the trigger with its project", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
      scope: "org",
    });
    const project = await projectService.create({
      organizationId,
      userId: adminUser.id,
      name: "scheduled-project",
      description: null,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/schedule-triggers",
      payload: {
        name: "With project",
        agentId: agent.id,
        projectId: project.id,
        messageTemplate: "go",
        cronExpression: "* * * * *",
        timezone: "UTC",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().projectId).toBe(project.id);
  });

  test("POST create without an agentId falls back to the org default agent", async ({
    makeInternalAgent,
  }) => {
    // The "basic user" path: a caller without `agent:read` omits the agent, and
    // the schedule implicitly runs the org's default agent — no agent-access
    // check is performed against a picked agent.
    const defaultAgent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
      scope: "org",
      isDefault: true,
    });
    const project = await projectService.create({
      organizationId,
      userId: adminUser.id,
      name: "default-agent-project",
      description: null,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/schedule-triggers",
      payload: {
        name: "No agent chosen",
        projectId: project.id,
        messageTemplate: "go",
        cronExpression: "* * * * *",
        timezone: "UTC",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agentId).toBe(defaultAgent.id);
  });

  test("POST create without an agentId and no default agent returns 400", async () => {
    const project = await projectService.create({
      organizationId,
      userId: adminUser.id,
      name: "no-default-project",
      description: null,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/schedule-triggers",
      payload: {
        name: "No agent, no default",
        projectId: project.id,
        messageTemplate: "go",
        cronExpression: "* * * * *",
        timezone: "UTC",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "No default agent is configured",
    );
  });

  test("PUT cannot move a trigger to an inaccessible project", async ({
    makeInternalAgent,
    makeScheduleTrigger,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
      scope: "org",
    });
    const project = await projectService.create({
      organizationId,
      userId: adminUser.id,
      name: "owned",
      description: null,
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: adminUser.id,
      agentId: agent.id,
      projectId: project.id,
    });
    const response = await app.inject({
      method: "PUT",
      url: `/api/schedule-triggers/${trigger.id}`,
      payload: { projectId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(response.statusCode).toBe(404);
  });
});
