import ConversationModel from "@/models/conversation";
import MessageModel from "@/models/message";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("project routes", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    currentUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const [{ default: projectRoutes }, { default: chatRoutes }] =
      await Promise.all([import("./project"), import("./chat/routes")]);
    await app.register(projectRoutes);
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates a personal project by default", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Support triage",
        description: "Daily support queue work",
        icon: "P",
        instructions: "Prioritize unresolved customer tickets.",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: expect.any(String),
      name: "Support triage",
      scope: "personal",
      teams: [],
      knowledgeBaseIds: [],
    });
  });

  test("member default role can create a personal project", async ({
    makeMember,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    currentUser = member;

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Personal member project",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Personal member project",
      scope: "personal",
      authorId: member.id,
    });
  });

  test("filters list results to visible projects", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const teammate = await makeUser();
    const otherUser = await makeUser();
    await makeMember(teammate.id, organizationId, { role: "member" });
    await makeMember(otherUser.id, organizationId, { role: "member" });
    const team = await makeTeam(organizationId, currentUser.id);
    await makeTeamMember(team.id, teammate.id);

    const ownPersonal = await createProject("Own personal");
    await createProject("Org shared", { scope: "org" });
    await createProject("Team shared", {
      scope: "team",
      teamIds: [team.id],
    });

    currentUser = otherUser;
    await createProject("Other personal");

    currentUser = teammate;
    const response = await app.inject({
      method: "GET",
      url: "/api/projects?limit=20&offset=0",
    });

    expect(response.statusCode).toBe(200);
    const names = response
      .json()
      .data.map((project: { name: string }) => project.name);
    expect(names).toContain("Org shared");
    expect(names).toContain("Team shared");
    expect(names).not.toContain("Own personal");
    expect(names).not.toContain("Other personal");
    const ids = response
      .json()
      .data.map((project: { id: string }) => project.id);
    expect(ids).not.toContain(ownPersonal.id);
  });

  test("requires project admin permission to create an org project", async ({
    makeMember,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    currentUser = member;

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Shared from member",
        scope: "org",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  test("requires project team-admin permission to create a team project", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    const team = await makeTeam(organizationId, currentUser.id);
    await makeTeamMember(team.id, member.id);
    currentUser = member;

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Team project from member",
        scope: "team",
        teamIds: [team.id],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/team-admin/i);
  });

  test("project team-admin can create team projects only for their teams", async ({
    makeCustomRole,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeCustomRole(organizationId, {
      role: "project_team_admin_role",
      permission: {
        project: ["read", "create", "update", "delete", "team-admin"],
        team: ["read"],
      },
    });
    await makeMember(member.id, organizationId, {
      role: "project_team_admin_role",
    });
    const team = await makeTeam(organizationId, currentUser.id);
    const otherTeam = await makeTeam(organizationId, currentUser.id, {
      name: "Other team",
    });
    await makeTeamMember(team.id, member.id);
    currentUser = member;

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Team-admin project",
        scope: "team",
        teamIds: [team.id],
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      scope: "team",
      teams: [expect.objectContaining({ id: team.id })],
    });

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Wrong team project",
        scope: "team",
        teamIds: [otherTeam.id],
      },
    });

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.message).toMatch(
      /only assign teams you are a member of/i,
    );
  });

  test("prevents visible non-owners from updating a project", async ({
    makeMember,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    const project = await createProject("Org visible", { scope: "org" });

    currentUser = member;
    const response = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: {
        name: "Updated by member",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  test("associates new chat conversations with accessible projects", async ({
    makeAgent,
  }) => {
    const project = await createProject("Launch plan");
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: {
        agentId: agent.id,
        projectId: project.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectId: project.id,
      project: {
        id: project.id,
        name: "Launch plan",
      },
    });
  });

  test("rejects chat association with inaccessible projects", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId, { role: "member" });
    currentUser = owner;
    const project = await createProject("Private project");

    const other = await makeUser();
    await makeMember(other.id, organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId,
      authorId: other.id,
      scope: "personal",
    });
    currentUser = other;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: {
        agentId: agent.id,
        projectId: project.id,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  test("project detail includes recent conversations", async ({
    makeAgent,
  }) => {
    const project = await createProject("Recent work");
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
      projectId: project.id,
      title: "Investigate regression",
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "Check why the importer is slow" }],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().recentConversations).toEqual([
      expect.objectContaining({
        id: conversation.id,
        projectId: project.id,
        messages: [
          expect.objectContaining({
            parts: [
              expect.objectContaining({
                text: "Check why the importer is slow",
              }),
            ],
          }),
        ],
      }),
    ]);
  });

  async function createProject(
    name: string,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name,
        ...overrides,
      },
    });

    expect(response.statusCode).toBe(200);
    return response.json();
  }
});
