// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  getArchestraToolFullName,
  PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT,
  TOOL_DELETE_MEMORY_SHORT_NAME,
  TOOL_LIST_MEMORIES_SHORT_NAME,
  TOOL_SAVE_MEMORY_SHORT_NAME,
  TOOL_UPDATE_MEMORY_SHORT_NAME,
} from "@archestra/shared";
import db, { schema } from "@/database";
import { ConversationModel, ProjectShareModel } from "@/models";
import { projectService } from "@/services/project";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent, Project, User } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const SAVE_MEMORY = getArchestraToolFullName(TOOL_SAVE_MEMORY_SHORT_NAME);
const LIST_MEMORIES = getArchestraToolFullName(TOOL_LIST_MEMORIES_SHORT_NAME);
const UPDATE_MEMORY = getArchestraToolFullName(TOOL_UPDATE_MEMORY_SHORT_NAME);
const DELETE_MEMORY = getArchestraToolFullName(TOOL_DELETE_MEMORY_SHORT_NAME);

const text = (result: { content: unknown[] }) =>
  (result.content[0] as any).text as string;

describe("project memory tools", () => {
  let agent: Agent;
  let user: User;
  let organizationId: string;
  let project: Project;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });
    agent = await makeAgent({
      name: "Memory Agent",
      agentType: "agent",
      organizationId,
    });
    project = await projectService.create({
      organizationId,
      userId: user.id,
      name: "memory-tools-project",
      description: null,
    });
  });

  function contextFor(conversationId?: string): ArchestraContext {
    // `agentId` is intentionally omitted so the per-agent assignment gate does
    // not apply — these tests exercise the handlers, not tool assignment.
    return {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId,
      conversationId,
    };
  }

  async function projectConversation() {
    return ConversationModel.create({
      userId: user.id,
      organizationId,
      agentId: agent.id,
      title: "in-project chat",
      projectId: project.id,
    });
  }

  test("save/list/update/delete against the conversation's project", async () => {
    const conversation = await projectConversation();
    const context = contextFor(conversation.id);

    const saved = await executeArchestraTool(
      SAVE_MEMORY,
      { content: "the launch is July 15" },
      context,
    );
    expect(saved.isError).toBe(false);
    const memoryId = (saved.structuredContent as any).id as string;

    const listed = await executeArchestraTool(LIST_MEMORIES, {}, context);
    expect(listed.isError).toBe(false);
    expect(text(listed)).toContain("the launch is July 15");
    expect(text(listed)).toContain(memoryId);

    const updated = await executeArchestraTool(
      UPDATE_MEMORY,
      { memory_id: memoryId, content: "the launch moved to July 22" },
      context,
    );
    expect(updated.isError).toBe(false);

    const deleted = await executeArchestraTool(
      DELETE_MEMORY,
      { memory_id: memoryId },
      context,
    );
    expect(deleted.isError).toBe(false);

    const emptied = await executeArchestraTool(LIST_MEMORIES, {}, context);
    expect(text(emptied)).toContain("no saved memories");
  });

  test("a non-project conversation gets an actionable error", async () => {
    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId,
      agentId: agent.id,
      title: "plain chat",
    });
    const result = await executeArchestraTool(
      SAVE_MEMORY,
      { content: "nowhere to go" },
      contextFor(conversation.id),
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not part of a project");
  });

  test("no conversation and no project_id gets an actionable error", async () => {
    const result = await executeArchestraTool(
      SAVE_MEMORY,
      { content: "stateless" },
      contextFor(undefined),
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not part of a project");
  });

  test("an explicit project_id works without a conversation (gateway caller)", async () => {
    const context = contextFor(undefined);
    const saved = await executeArchestraTool(
      SAVE_MEMORY,
      { content: "from the gateway", project_id: project.id },
      context,
    );
    expect(saved.isError).toBe(false);

    const listed = await executeArchestraTool(
      LIST_MEMORIES,
      { project_id: project.id },
      context,
    );
    expect(text(listed)).toContain("from the gateway");
  });

  test("an explicit project_id the caller cannot access 404s", async ({
    makeUser,
    makeMember,
  }) => {
    const outsider = await makeUser({ email: "memory-outsider@test.com" });
    await makeMember(outsider.id, organizationId, {});
    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: outsider.id,
      organizationId,
    };

    const result = await executeArchestraTool(
      SAVE_MEMORY,
      { content: "should be invisible", project_id: project.id },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Project not found");
  });

  test("a shared member's conversation-scoped save works", async ({
    makeUser,
    makeMember,
  }) => {
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: user.id,
      visibility: "organization",
      teamIds: [],
    });
    const member = await makeUser({ email: "memory-member@test.com" });
    await makeMember(member.id, organizationId, {});
    const conversation = await ConversationModel.create({
      userId: member.id,
      organizationId,
      agentId: agent.id,
      title: "member chat",
      projectId: project.id,
    });
    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      userId: member.id,
      organizationId,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      SAVE_MEMORY,
      { content: "member note" },
      context,
    );
    expect(result.isError).toBe(false);
  });

  test("a userless (org/team token) session is rejected", async () => {
    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      organizationId,
    };
    const result = await executeArchestraTool(
      LIST_MEMORIES,
      { project_id: project.id },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("User context not available");
  });

  test("saving into a full project tells the model to consolidate", async () => {
    const conversation = await projectConversation();
    await db.insert(schema.projectMemoriesTable).values(
      Array.from({ length: PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT }, (_, i) => ({
        projectId: project.id,
        organizationId,
        createdByUserId: user.id,
        content: `memory ${i}`,
      })),
    );

    const result = await executeArchestraTool(
      SAVE_MEMORY,
      { content: "one too many" },
      contextFor(conversation.id),
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("consolidate");
  });
});
