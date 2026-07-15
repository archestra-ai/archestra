// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import FileModel from "@/models/file";
import { fileStore } from "@/skills-sandbox/file-store";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const TOOL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_project_from_conversation`;

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
