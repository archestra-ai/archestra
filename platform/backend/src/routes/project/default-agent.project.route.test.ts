import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { AgentModel, ProjectModel, ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("project default agent", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = owner;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedProject(name = "pinned") {
    return projectService.create({
      organizationId,
      userId: owner.id,
      name,
      description: null,
    });
  }

  test("pins an org-scoped chat agent and reports it on the detail", async ({
    makeInternalAgent,
  }) => {
    const project = await seedProject();
    const agent = await makeInternalAgent({
      organizationId,
      scope: "org",
      name: "Test1 Agent",
    });

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { defaultAgentId: agent.id },
    });
    expect(patch.statusCode).toBe(200);
    expect((await ProjectModel.findById(project.id))?.defaultAgentId).toBe(
      agent.id,
    );

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().defaultAgent).toEqual({
      id: agent.id,
      name: "Test1 Agent",
    });
  });

  test("accepts the default agent at creation", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({ organizationId, scope: "org" });

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "created-with-agent", defaultAgentId: agent.id },
    });
    expect(created.statusCode).toBe(200);
    expect(
      (await ProjectModel.findById(created.json().id))?.defaultAgentId,
    ).toBe(agent.id);
  });

  test("rejects an ineligible agent at creation, creating nothing", async ({
    makeInternalAgent,
  }) => {
    const personalAgent = await makeInternalAgent({
      organizationId,
      scope: "personal",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "never-created", defaultAgentId: personalAgent.id },
    });
    expect(res.statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: "/api/projects" });
    expect(list.json()).toEqual([]);
  });

  test("reports a null default agent when the project pins none", async () => {
    const project = await seedProject("unpinned");

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().defaultAgent).toBeNull();
  });

  test("null clears the pin", async ({ makeInternalAgent }) => {
    const project = await seedProject("clearable");
    const agent = await makeInternalAgent({ organizationId, scope: "org" });
    await projectService.update({
      id: project.id,
      organizationId,
      userId: owner.id,
      defaultAgentId: agent.id,
    });

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { defaultAgentId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      (await ProjectModel.findById(project.id))?.defaultAgentId,
    ).toBeNull();
  });

  test("an omitted defaultAgentId leaves the existing pin alone", async ({
    makeInternalAgent,
  }) => {
    const project = await seedProject("untouched");
    const agent = await makeInternalAgent({ organizationId, scope: "org" });
    await projectService.update({
      id: project.id,
      organizationId,
      userId: owner.id,
      defaultAgentId: agent.id,
    });

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { name: "renamed-only" },
    });
    expect(renamed.statusCode).toBe(200);
    expect((await ProjectModel.findById(project.id))?.defaultAgentId).toBe(
      agent.id,
    );
  });

  describe("eligibility follows who the project is shared with", () => {
    test("the owner may pin their own personal agent while the project is unshared", async ({
      makeInternalAgent,
    }) => {
      const project = await seedProject("private-personal");
      const personal = await makeInternalAgent({
        organizationId,
        scope: "personal",
        authorId: owner.id,
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { defaultAgentId: personal.id },
      });
      expect(res.statusCode).toBe(200);
      expect((await ProjectModel.findById(project.id))?.defaultAgentId).toBe(
        personal.id,
      );
    });

    test("that same personal agent is rejected once the project is org-wide", async ({
      makeInternalAgent,
    }) => {
      const project = await seedProject("org-shared-personal");
      const personal = await makeInternalAgent({
        organizationId,
        scope: "personal",
        authorId: owner.id,
      });
      await ProjectShareModel.upsert({
        projectId: project.id,
        organizationId,
        createdByUserId: owner.id,
        visibility: "organization",
        teamIds: [],
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { defaultAgentId: personal.id },
      });
      expect(res.statusCode).toBe(400);
    });

    test("sharing a project drops a pin only its owner could use", async ({
      makeInternalAgent,
      makeTeam,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, owner.id, { name: "Shared" });
      await makeTeamMember(team.id, owner.id);
      const project = await seedProject("outgrown");
      const personal = await makeInternalAgent({
        organizationId,
        scope: "personal",
        authorId: owner.id,
      });
      await projectService.update({
        id: project.id,
        organizationId,
        userId: owner.id,
        defaultAgentId: personal.id,
      });

      // The rest of the team cannot reach the owner's personal agent, so the
      // pin cannot survive the share.
      const shared = await app.inject({
        method: "PUT",
        url: `/api/projects/${project.id}/share`,
        payload: { visibility: "team", teamIds: [team.id], userIds: [] },
      });
      expect(shared.statusCode).toBe(200);
      expect(
        (await ProjectModel.findById(project.id))?.defaultAgentId,
      ).toBeNull();
    });

    test("a team agent must cover every team the project is shared with", async ({
      makeTeam,
      makeTeamMember,
      makeInternalAgent,
    }) => {
      const teamA = await makeTeam(organizationId, owner.id, { name: "A" });
      const teamB = await makeTeam(organizationId, owner.id, { name: "B" });
      await makeTeamMember(teamA.id, owner.id);
      await makeTeamMember(teamB.id, owner.id);
      const coversBoth = await makeInternalAgent({
        organizationId,
        scope: "team",
        teams: [teamA.id, teamB.id],
      });
      const coversOne = await makeInternalAgent({
        organizationId,
        scope: "team",
        teams: [teamA.id],
      });

      const project = await seedProject("team-shared");
      await ProjectShareModel.upsert({
        projectId: project.id,
        organizationId,
        createdByUserId: owner.id,
        visibility: "team",
        teamIds: [teamA.id, teamB.id],
      });

      const rejected = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { defaultAgentId: coversOne.id },
      });
      expect(rejected.statusCode).toBe(400);

      const accepted = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { defaultAgentId: coversBoth.id },
      });
      expect(accepted.statusCode).toBe(200);
      expect((await ProjectModel.findById(project.id))?.defaultAgentId).toBe(
        coversBoth.id,
      );
    });

    test("a team agent the owner cannot reach is refused, even though it covers the shared team", async ({
      makeInternalAgent,
      makeTeam,
      makeTeamMember,
      makeUser,
      makeMember,
    }) => {
      // The owner starts chats here too, so a pin they cannot run is broken for
      // them — and unsharing later would have to take it away again.
      const outsider = await makeUser({ email: "outsider@test.com" });
      await makeMember(outsider.id, organizationId, {});
      const team = await makeTeam(organizationId, outsider.id, { name: "Far" });
      await makeTeamMember(team.id, outsider.id);
      const teamAgent = await makeInternalAgent({
        organizationId,
        scope: "team",
        teams: [team.id],
      });

      const project = await seedProject("owner-outside-team");
      await ProjectShareModel.upsert({
        projectId: project.id,
        organizationId,
        createdByUserId: owner.id,
        visibility: "team",
        teamIds: [team.id],
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { defaultAgentId: teamAgent.id },
      });
      expect(res.statusCode).toBe(400);
    });

    test("a named-user share needs an agent every named person can reach", async ({
      makeInternalAgent,
      makeMember,
      makeUser,
    }) => {
      const colleague = await makeUser({ email: "colleague@test.com" });
      await makeMember(colleague.id, organizationId, {});
      const stranger = await makeUser({ email: "stranger@test.com" });
      await makeMember(stranger.id, organizationId, {});
      const sharedWithColleague = await makeInternalAgent({
        organizationId,
        scope: "personal",
        authorId: owner.id,
        users: [colleague.id],
      });

      const project = await seedProject("user-shared");
      await ProjectShareModel.upsert({
        projectId: project.id,
        organizationId,
        createdByUserId: owner.id,
        visibility: "user",
        teamIds: [],
        userIds: [colleague.id],
      });

      const accepted = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { defaultAgentId: sharedWithColleague.id },
      });
      expect(accepted.statusCode).toBe(200);

      // Adding someone the agent was never shared with outgrows the pin.
      await ProjectShareModel.upsert({
        projectId: project.id,
        organizationId,
        createdByUserId: owner.id,
        visibility: "user",
        teamIds: [],
        userIds: [colleague.id, stranger.id],
      });
      const detail = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
      });
      expect(detail.json().defaultAgent).toBeNull();
    });
  });

  describe("rejects an agent the whole project cannot use", () => {
    test.for([
      // Scoped to a team the owner is not in / authored by someone else, so
      // even the owner cannot reach it.
      { label: "team-scoped", overrides: { scope: "team" as const } },
      { label: "personal-scoped", overrides: { scope: "personal" as const } },
      // Not a chat agent at all.
      {
        label: "an mcp_gateway",
        overrides: { scope: "org" as const, agentType: "mcp_gateway" as const },
      },
      {
        label: "an llm_proxy",
        overrides: { scope: "org" as const, agentType: "llm_proxy" as const },
      },
      // A platform-internal agent that never appears in the chat picker.
      {
        label: "built-in",
        overrides: {
          scope: "org" as const,
          builtInAgentConfig: {
            name: BUILT_IN_AGENT_IDS.CHAT_TITLE_GENERATION,
          } as const,
        },
      },
    ])("$label", async ({ label, overrides }, { makeAgent }) => {
      const project = await seedProject(`reject-${label}`);
      const agent = await makeAgent({
        organizationId,
        agentType: "agent",
        ...overrides,
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { defaultAgentId: agent.id },
      });
      expect(res.statusCode).toBe(400);
      expect(
        (await ProjectModel.findById(project.id))?.defaultAgentId,
      ).toBeNull();
    });
  });

  test("rejects an agent from another organization", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const project = await seedProject("cross-org");
    const otherOrg = await makeOrganization();
    const foreignAgent = await makeInternalAgent({
      organizationId: otherOrg.id,
      scope: "org",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { defaultAgentId: foreignAgent.id },
    });
    expect(res.statusCode).toBe(400);
    expect(
      (await ProjectModel.findById(project.id))?.defaultAgentId,
    ).toBeNull();
  });

  test("rejects a soft-deleted agent", async ({ makeInternalAgent }) => {
    const project = await seedProject("deleted-agent");
    const agent = await makeInternalAgent({ organizationId, scope: "org" });
    await AgentModel.delete(agent.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { defaultAgentId: agent.id },
    });
    expect(res.statusCode).toBe(400);
    expect(
      (await ProjectModel.findById(project.id))?.defaultAgentId,
    ).toBeNull();
  });

  // Agents soft-delete, so the column's ON DELETE SET NULL never fires and the
  // pin outlives its eligibility. The read path is what has to notice.
  test("stops reporting a pin whose agent was deleted", async ({
    makeInternalAgent,
  }) => {
    const project = await seedProject("goes-stale");
    const agent = await makeInternalAgent({ organizationId, scope: "org" });
    await projectService.update({
      id: project.id,
      organizationId,
      userId: owner.id,
      defaultAgentId: agent.id,
    });

    await AgentModel.delete(agent.id);

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().defaultAgent).toBeNull();
    // The column keeps its value; re-picking in the dialog repairs it.
    expect((await ProjectModel.findById(project.id))?.defaultAgentId).toBe(
      agent.id,
    );
  });

  // The editor is shown "no default" for a stale pin, so selecting that back is
  // a no-op it cannot send. Without the repair, re-widening the agent's scope
  // resurrects a pin the user was last told was absent.
  test("clears a stale pin on the next update instead of letting it resurrect", async ({
    makeInternalAgent,
  }) => {
    const project = await seedProject("no-resurrect");
    const agent = await makeInternalAgent({ organizationId, scope: "org" });
    await projectService.update({
      id: project.id,
      organizationId,
      userId: owner.id,
      defaultAgentId: agent.id,
    });

    await AgentModel.update(agent.id, { scope: "team" });

    // An unrelated edit — the caller never mentions the default agent.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { name: "renamed-while-stale" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      (await ProjectModel.findById(project.id))?.defaultAgentId,
    ).toBeNull();

    await AgentModel.update(agent.id, { scope: "org" });

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(detail.json().defaultAgent).toBeNull();
  });

  test("leaves a still-valid pin alone on an unrelated update", async ({
    makeInternalAgent,
  }) => {
    const project = await seedProject("valid-pin-kept");
    const agent = await makeInternalAgent({ organizationId, scope: "org" });
    await projectService.update({
      id: project.id,
      organizationId,
      userId: owner.id,
      defaultAgentId: agent.id,
    });

    await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { description: "unrelated" },
    });
    expect((await ProjectModel.findById(project.id))?.defaultAgentId).toBe(
      agent.id,
    );
  });

  test("stops reporting a pin whose agent was rescoped away from the org", async ({
    makeInternalAgent,
  }) => {
    const project = await seedProject("rescoped");
    const agent = await makeInternalAgent({ organizationId, scope: "org" });
    await projectService.update({
      id: project.id,
      organizationId,
      userId: owner.id,
      defaultAgentId: agent.id,
    });

    await AgentModel.update(agent.id, { scope: "team" });

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().defaultAgent).toBeNull();
  });
});
