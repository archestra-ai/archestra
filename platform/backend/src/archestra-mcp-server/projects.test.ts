// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import FileModel from "@/models/file";
import ProjectShareModel from "@/models/project-share";
import { projectService } from "@/services/project";
import { fileStore } from "@/skills-sandbox/file-store";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const TOOL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_project_from_conversation`;
const SHARE_TOOL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}set_project_share`;

describe("create_project_from_conversation tool", () => {
  let agent: Agent;
  let userId: string;
  let organizationId: string;
  let baseContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    userId = user.id;
    organizationId = org.id;
    agent = await makeAgent({ organizationId });
    baseContext = {
      agent: { id: agent.id, name: agent.name },
      userId,
      organizationId,
    };
  });

  test("creates a project from the current chat and moves its files", async ({
    makeConversation,
  }) => {
    const conv = await makeConversation(agent.id, {
      userId,
      organizationId,
      title: "Research chat",
    });
    await fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId: conv.id,
      filename: "notes.md",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("abc"),
    });

    const result = await executeArchestraTool(
      TOOL_NAME,
      {},
      { ...baseContext, conversationId: conv.id },
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      success: true,
      project_name: "Research chat",
      files_transferred: 1,
    });
    const projectId = (result.structuredContent as { project_id: string })
      .project_id;
    const meta = await ConversationModel.getOwnedMeta({
      id: conv.id,
      userId,
      organizationId,
    });
    expect(meta?.projectId).toBe(projectId);
    expect(
      await FileModel.listByProject({ organizationId, projectId }),
    ).toHaveLength(1);
  });

  test("errors without an active chat conversation", async () => {
    const result = await executeArchestraTool(TOOL_NAME, {}, baseContext);
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "requires an active chat conversation",
    );
  });
});

describe("set_project_share tool", () => {
  let agent: Agent;
  let userId: string;
  let organizationId: string;
  let baseContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    userId = user.id;
    organizationId = org.id;
    agent = await makeAgent({ organizationId });
    baseContext = {
      agent: { id: agent.id, name: agent.name },
      userId,
      organizationId,
    };
  });

  /** A project whose chat is the "current" conversation of the context. */
  async function makeProjectWithChat(makeConversation: any) {
    const conv = await makeConversation(agent.id, {
      userId,
      organizationId,
      title: "Project chat",
    });
    const { project } = await projectService.createProjectFromConversation({
      organizationId,
      userId,
      conversationId: conv.id,
      name: null,
      description: null,
    });
    return { conversationId: conv.id as string, project };
  }

  test("shares the current chat's project with the organization", async ({
    makeConversation,
  }) => {
    const { conversationId, project } =
      await makeProjectWithChat(makeConversation);

    const result = await executeArchestraTool(
      SHARE_TOOL_NAME,
      { visibility: "organization" },
      { ...baseContext, conversationId },
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      success: true,
      project_id: project.id,
      visibility: "organization",
    });
    expect(
      (await ProjectShareModel.findByProjectId(project.id))?.visibility,
    ).toBe("organization");
  });

  test("shares an explicit project with teams and unshares it", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, userId);
    const project = await projectService.create({
      organizationId,
      userId,
      name: "shared-with-teams",
      description: null,
    });

    const shared = await executeArchestraTool(
      SHARE_TOOL_NAME,
      { visibility: "team", team_ids: [team.id], project_id: project.id },
      baseContext,
    );
    expect(shared.isError).toBe(false);
    const share = await ProjectShareModel.findByProjectId(project.id);
    expect(share?.visibility).toBe("team");
    expect(share?.teamIds).toEqual([team.id]);

    const unshared = await executeArchestraTool(
      SHARE_TOOL_NAME,
      { visibility: "none", project_id: project.id },
      baseContext,
    );
    expect(unshared.isError).toBe(false);
    expect(await ProjectShareModel.findByProjectId(project.id)).toBeNull();
  });

  test("rejects team visibility without team ids and with unknown team ids", async () => {
    const project = await projectService.create({
      organizationId,
      userId,
      name: "needs-teams",
      description: null,
    });

    const noTeams = await executeArchestraTool(
      SHARE_TOOL_NAME,
      { visibility: "team", project_id: project.id },
      baseContext,
    );
    expect(noTeams.isError).toBe(true);
    expect((noTeams.content[0] as any).text).toContain("at least one entry");

    const unknownTeam = await executeArchestraTool(
      SHARE_TOOL_NAME,
      {
        visibility: "team",
        team_ids: [crypto.randomUUID()],
        project_id: project.id,
      },
      baseContext,
    );
    expect(unknownTeam.isError).toBe(true);
    expect((unknownTeam.content[0] as any).text).toContain("Unknown team id");
  });

  test("errors when the chat has no project and no project_id is given", async ({
    makeConversation,
  }) => {
    const conv = await makeConversation(agent.id, {
      userId,
      organizationId,
    });
    const result = await executeArchestraTool(
      SHARE_TOOL_NAME,
      { visibility: "organization" },
      { ...baseContext, conversationId: conv.id },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "does not belong to a project",
    );
  });

  test("surfaces the org-share permission error for owners without project:share-org", async ({
    makeCustomRole,
    makeMember,
    makeUser,
    makeAgent,
  }) => {
    const restricted = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "create", "update", "delete"] },
    });
    await makeMember(restricted.id, organizationId, { role: role.role });
    const restrictedAgent = await makeAgent({ organizationId });
    const project = await projectService.create({
      organizationId,
      userId: restricted.id,
      name: "not-org-sharable",
      description: null,
    });

    const result = await executeArchestraTool(
      SHARE_TOOL_NAME,
      { visibility: "organization", project_id: project.id },
      {
        agent: { id: restrictedAgent.id, name: restrictedAgent.name },
        userId: restricted.id,
        organizationId,
      },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "organization-wide project sharing",
    );
    expect(await ProjectShareModel.findByProjectId(project.id)).toBeNull();
  });
});
