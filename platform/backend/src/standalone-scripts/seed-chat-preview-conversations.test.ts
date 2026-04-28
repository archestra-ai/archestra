import { seededChatPreviewScenarios } from "@shared";
import type { UIMessage } from "ai";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { ConversationModel } from "@/models";
import { expect, test } from "@/test";
import {
  CHAT_PREVIEW_AGENT_NAME,
  seedChatPreviewConversations,
} from "./seed-chat-preview-conversations";

test("seedChatPreviewConversations creates preview conversations with ordered messages and chat errors", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();

  const result = await seedChatPreviewConversations({
    userId: user.id,
    organizationId: organization.id,
  });

  expect(result.conversationCount).toBe(seededChatPreviewScenarios.length);
  expect(result.messageCount).toBe(
    seededChatPreviewScenarios.reduce(
      (total, scenario) => total + scenario.messages.length,
      0,
    ),
  );
  expect(result.chatErrorCount).toBe(
    seededChatPreviewScenarios.reduce(
      (total, scenario) => total + (scenario.chatErrors?.length ?? 0),
      0,
    ),
  );

  const [agent] = await db
    .select()
    .from(schema.agentsTable)
    .where(eq(schema.agentsTable.id, result.agentId));

  expect(agent).toMatchObject({
    name: CHAT_PREVIEW_AGENT_NAME,
    agentType: "agent",
    scope: "personal",
    organizationId: organization.id,
    authorId: user.id,
  });

  const timelineScenario = seededChatPreviewScenarios.find(
    (scenario) => scenario.id === "timeline-errors",
  );
  expect(timelineScenario).toBeDefined();

  const conversation = await ConversationModel.findById({
    id: timelineScenario?.conversationId ?? "",
    userId: user.id,
    organizationId: organization.id,
  });

  expect(conversation?.agentId).toBe(result.agentId);
  expect(conversation?.title).toBe(timelineScenario?.title);
  expect(conversation?.messages.map((message) => message.role)).toEqual([
    "user",
    "user",
  ]);
  expect(
    conversation?.messages.map((message) => message.metadata?.createdAt),
  ).toEqual(["2026-04-23T10:00:00.000Z", "2026-04-23T10:02:00.000Z"]);
  expect(conversation?.chatErrors.map((chatError) => chatError.error)).toEqual(
    timelineScenario?.chatErrors?.map((chatError) => chatError.error),
  );

  const scenariosWithReasoning = seededChatPreviewScenarios.filter((scenario) =>
    scenario.messages.some((message) =>
      message.parts.some((part) => part.type === "reasoning"),
    ),
  );
  expect(scenariosWithReasoning.length).toBeGreaterThan(0);

  for (const scenario of scenariosWithReasoning) {
    const seededConversation = await ConversationModel.findById({
      id: scenario.conversationId,
      userId: user.id,
      organizationId: organization.id,
    });

    const reasoningParts = (
      seededConversation?.messages as UIMessage[]
    ).flatMap((message) =>
      message.parts.filter((part) => part.type === "reasoning"),
    );

    expect(reasoningParts).toEqual(
      scenario.messages.flatMap((message) =>
        message.parts.filter((part) => part.type === "reasoning"),
      ),
    );
    expect(reasoningParts?.every((part) => part.state === "done")).toBe(true);
  }
});
