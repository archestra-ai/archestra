import { makeSignature } from "better-auth/crypto";
import { vi } from "vitest";
import { auth as betterAuth } from "@/auth/better-auth";
import { authPlugin } from "@/auth/fastify-plugin";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import ConversationModel from "@/models/conversation";
import MessageModel from "@/models/message";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import { projectService } from "@/services/project";
import { createAndLinkRunConversation } from "@/services/scheduled-run-conversation";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("schedule trigger routes", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: adminUser.id } }) as never,
    );

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
    registerAuditLogHook(app);
    await app.register(scheduleTriggerRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("editing a disabled schedule preserves its state and audits the actual change", async ({
    makeAgent,
    makeScheduleTrigger,
  }) => {
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    const trigger = await makeScheduleTrigger({
      organizationId,
      agentId: agent.id,
      actorUserId: adminUser.id,
      enabled: false,
      name: "Before",
    });
    const response = await app.inject({
      method: "PUT",
      url: `/api/schedule-triggers/${trigger.id}`,
      payload: { name: "After" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "After", enabled: false });
    await vi.waitFor(async () => {
      const { data } = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "scheduleTrigger",
        limit: 10,
        offset: 0,
      });
      expect(data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "scheduleTrigger.updated",
            resourceId: trigger.id,
            before: expect.objectContaining({ name: "Before", enabled: false }),
            after: expect.objectContaining({ name: "After", enabled: false }),
          }),
        ]),
      );
    });
    const empty = await app.inject({
      method: "PUT",
      url: `/api/schedule-triggers/${trigger.id}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  test("deletion returns success and records the removed schedule", async ({
    makeAgent,
    makeScheduleTrigger,
  }) => {
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    const trigger = await makeScheduleTrigger({
      organizationId,
      agentId: agent.id,
      actorUserId: adminUser.id,
      name: "Removed schedule",
    });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/schedule-triggers/${trigger.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    await vi.waitFor(async () => {
      const { data } = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "scheduleTrigger",
        limit: 10,
        offset: 0,
      });
      expect(data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "scheduleTrigger.deleted",
            resourceId: trigger.id,
            before: expect.objectContaining({ name: "Removed schedule" }),
            after: null,
          }),
        ]),
      );
    });
    const second = await app.inject({
      method: "DELETE",
      url: `/api/schedule-triggers/${trigger.id}`,
    });
    expect(second.statusCode).toBe(404);
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
    const owner = await makeUser();
    const member = await makeUser();
    await makeMember(owner.id, organizationId, { role: "member" });
    await makeMember(member.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
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

  test("a tuner viewer opens a tuner run's conversation, never minting one, but cannot run, toggle or edit the tuner", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeUser,
  }) => {
    config.tuners.enabled = true;
    const executor = adminUser;
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    const trigger = await makeScheduleTrigger({
      organizationId,
      agentId: agent.id,
      actorUserId: executor.id,
      tunerKind: "appa",
    });
    const [run, unopened] = await Promise.all([
      makeScheduleTriggerRun(trigger.id, { organizationId, runKind: "due" }),
      makeScheduleTriggerRun(trigger.id, { organizationId, runKind: "due" }),
    ]);
    // What the run handler links when the run starts.
    const linked = await createAndLinkRunConversation({
      run,
      trigger,
      ownerUserId: executor.id,
      organizationId,
    });
    await MessageModel.create({
      conversationId: linked.id,
      role: "assistant",
      content: {
        id: "message-1",
        role: "assistant",
        parts: [
          { type: "text", text: "Filed one suggestion" },
          { type: "data-hook-run", data: { hook: "pre-tool", stdout: "x" } },
        ],
      },
    });
    config.hooks.enabled = true;
    await ConversationModel.setHooksDebugEnabled({
      id: linked.id,
      userId: executor.id,
      organizationId,
      enabled: true,
    });
    const nextActor = await makeUser();
    await makeMember(nextActor.id, organizationId, { role: "admin" });
    await ScheduleTriggerModel.update(trigger.id, {
      actorUserId: nextActor.id,
    });
    const viewer = await makeUser();
    const { role } = await makeCustomRole(organizationId, {
      permission: { tuner: ["read"], log: ["read", "admin"] },
    });
    await makeMember(viewer.id, organizationId, { role });
    adminUser = viewer;
    const open = (runId: string) =>
      app.inject({
        method: "POST",
        url: `/api/schedule-triggers/${trigger.id}/runs/${runId}/conversation`,
      });

    const partTypes = (body: { messages: { parts: { type: string }[] }[] }) =>
      body.messages.flatMap((m) => m.parts.map((p) => p.type));
    const opened = await open(run.id);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({
      userId: executor.id,
      agentId: agent.id,
    });
    expect(partTypes(opened.json())).toEqual(["text"]);
    adminUser = executor;
    expect(partTypes((await open(run.id)).json())).toEqual([
      "text",
      "data-hook-run",
    ]);
    adminUser = viewer;
    expect((await open(unopened.id)).statusCode).toBe(404);
    expect(
      (await ScheduleTriggerRunModel.findById(unopened.id))?.chatConversationId,
    ).toBeNull();

    const base = `/api/schedule-triggers/${trigger.id}`;
    const refused = await Promise.all([
      app.inject({ method: "POST", url: `${base}/run-now` }),
      app.inject({ method: "POST", url: `${base}/enable` }),
      app.inject({ method: "POST", url: `${base}/disable` }),
      app.inject({ method: "PUT", url: base, payload: { name: "Renamed" } }),
    ]);
    expect(refused.map((r) => r.statusCode)).toEqual([404, 404, 404, 404]);
    expect(
      await ScheduleTriggerRunModel.countByTrigger({
        organizationId,
        triggerId: trigger.id,
      }),
    ).toBe(2);
  });

  test("POST create rejects a payload without a project", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
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
    expect(response.json().error.message).toContain("projectId");
  });

  test("POST create associates the trigger with its project", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
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

  test("run-now and by-id reads 404 once the trigger's project is soft-deleted", async ({
    makeInternalAgent,
    makeScheduleTrigger,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
    });
    const project = await projectService.create({
      organizationId,
      userId: adminUser.id,
      name: "doomed-scheduled",
      description: null,
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      // The actor normally always has access; the soft-deleted project overrides
      // even that, so run-now can't execute into a hidden project.
      actorUserId: adminUser.id,
      agentId: agent.id,
      projectId: project.id,
    });

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: adminUser.id,
    });

    const runNow = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${trigger.id}/run-now`,
    });
    expect(runNow.statusCode).toBe(404);

    const byId = await app.inject({
      method: "GET",
      url: `/api/schedule-triggers/${trigger.id}`,
    });
    expect(byId.statusCode).toBe(404);
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

  test("POST create without an agentId prefers the project's default agent over the org's", async ({
    makeInternalAgent,
  }) => {
    // Same "basic user" path, but the project pins its own agent. Without this
    // the pin is honored only for callers whose UI can send an agentId.
    const orgDefault = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
      isDefault: true,
    });
    const projectAgent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
    });
    const project = await projectService.create({
      organizationId,
      userId: adminUser.id,
      name: "pinned-agent-project",
      description: null,
      defaultAgentId: projectAgent.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/schedule-triggers",
      payload: {
        name: "Project pin wins",
        projectId: project.id,
        messageTemplate: "go",
        cronExpression: "* * * * *",
        timezone: "UTC",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agentId).toBe(projectAgent.id);
    expect(response.json().agentId).not.toBe(orgDefault.id);
  });

  test("POST create with an explicit agentId keeps it over the project's pin", async ({
    makeInternalAgent,
  }) => {
    const projectAgent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
    });
    const chosenAgent = await makeInternalAgent({
      organizationId,
      authorId: adminUser.id,
    });
    const project = await projectService.create({
      organizationId,
      userId: adminUser.id,
      name: "explicit-over-pin",
      description: null,
      defaultAgentId: projectAgent.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/schedule-triggers",
      payload: {
        name: "Explicit wins",
        projectId: project.id,
        agentId: chosenAgent.id,
        messageTemplate: "go",
        cronExpression: "* * * * *",
        timezone: "UTC",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agentId).toBe(chosenAgent.id);
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

describe("opening a run conversation through the auth middleware", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let executor: User;
  let tunerViewer: User;
  let agentId: string;
  let cookie: string;

  beforeEach(
    async ({
      makeAgent,
      makeCustomRole,
      makeMember,
      makeOrganization,
      makeSession,
      makeUser,
    }) => {
      config.tuners.enabled = true;
      organizationId = (await makeOrganization()).id;
      executor = await makeUser();
      await makeMember(executor.id, organizationId, { role: "admin" });
      tunerViewer = await makeUser();
      const { role } = await makeCustomRole(organizationId, {
        permission: { tuner: ["read"], log: ["read", "admin"] },
      });
      await makeMember(tunerViewer.id, organizationId, { role });
      agentId = (await makeAgent({ organizationId, agentType: "agent" })).id;
      const session = await makeSession(tunerViewer.id, {
        activeOrganizationId: organizationId,
      });
      const signature = await makeSignature(
        session.token,
        process.env.ARCHESTRA_AUTH_SECRET as string,
      );
      cookie = `archestra.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;

      app = createFastifyInstance();
      await app.register(authPlugin);
      const { default: scheduleTriggerRoutes } = await import(
        "./schedule-trigger"
      );
      await app.register(scheduleTriggerRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  const openAsTunerViewer = (triggerId: string, runId: string) =>
    app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${triggerId}/runs/${runId}/conversation`,
      headers: { cookie },
    });

  test("a tuner viewer without project:create opens a linked tuner run conversation", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const trigger = await makeScheduleTrigger({
      organizationId,
      agentId,
      actorUserId: executor.id,
      tunerKind: "appa",
    });
    const [run, unopened] = await Promise.all([
      makeScheduleTriggerRun(trigger.id, { organizationId, runKind: "due" }),
      makeScheduleTriggerRun(trigger.id, { organizationId, runKind: "due" }),
    ]);
    const linked = await createAndLinkRunConversation({
      run,
      trigger,
      ownerUserId: executor.id,
      organizationId,
    });

    const opened = await openAsTunerViewer(trigger.id, run.id);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({ id: linked.id, userId: executor.id });
    expect((await openAsTunerViewer(trigger.id, unopened.id)).statusCode).toBe(
      404,
    );
  });

  test("a caller without project:create cannot open a generic trigger's run conversation, even as its actor", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const trigger = await makeScheduleTrigger({
      organizationId,
      agentId,
      actorUserId: tunerViewer.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, {
      organizationId,
      runKind: "due",
    });
    const conversation = await ConversationModel.create({
      userId: tunerViewer.id,
      organizationId,
      agentId,
    });
    await ScheduleTriggerRunModel.setChatConversationId(
      run.id,
      conversation.id,
    );

    const response = await openAsTunerViewer(trigger.id, run.id);
    expect(response.statusCode, response.body).toBe(403);
  });
});
