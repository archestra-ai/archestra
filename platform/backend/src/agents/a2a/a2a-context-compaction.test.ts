import {
  A2AContextCompactionModel,
  A2AMessageModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import type { A2AMessage } from "@/types";
import { applyA2AContextCompaction } from "./a2a-context-compaction";
import { A2AContextManager } from "./a2a-model-manager";

/**
 * Budget math: the agent model's contextLength is 1000 tokens, the shared
 * threshold is 80% → 800 tokens ≈ 3200 chars. Each seeded message carries
 * ~800 chars of text, so 8 messages (~1700 tokens serialized) overflow the
 * threshold, while the post-compaction view (short summary + small recent
 * suffix) stays well under it.
 */
const CONTEXT_LENGTH_TOKENS = 1000;
const MESSAGE_TEXT_CHARS = 800;

async function setUpAgentWithModel(fixtures: {
  makeUser: (overrides: { email: string }) => Promise<{ id: string }>;
  makeOrganization: () => Promise<{ id: string }>;
  makeSecret: (overrides: {
    secret: { apiKey: string };
  }) => Promise<{ id: string }>;
  makeLlmProviderApiKey: (
    organizationId: string,
    secretId: string,
    overrides: { name: string; provider: "anthropic"; scope: "org" },
  ) => Promise<{ id: string }>;
  makeInternalAgent: (overrides: {
    organizationId: string;
    llmApiKeyId: string;
    modelId: string;
  }) => Promise<{
    id: string;
    llmApiKeyId: string | null;
    modelId: string | null;
  }>;
}) {
  const user = await fixtures.makeUser({ email: "compaction@example.com" });
  const org = await fixtures.makeOrganization();
  const secret = await fixtures.makeSecret({ secret: { apiKey: "sk-test" } });
  const apiKey = await fixtures.makeLlmProviderApiKey(org.id, secret.id, {
    name: "Test Anthropic",
    provider: "anthropic",
    scope: "org",
  });
  const model = await ModelModel.create({
    externalId: "anthropic/claude-compaction-test",
    provider: "anthropic",
    modelId: "claude-compaction-test",
    contextLength: CONTEXT_LENGTH_TOKENS,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    lastSyncedAt: new Date(),
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKey.id, [
    model.id,
  ]);
  const agent = await fixtures.makeInternalAgent({
    organizationId: org.id,
    llmApiKeyId: apiKey.id,
    modelId: model.id,
  });

  return {
    userId: user.id,
    agent: {
      id: agent.id,
      llmApiKeyId: agent.llmApiKeyId,
      modelId: agent.modelId,
      organizationId: org.id,
    },
  };
}

async function seedContextMessages(params: {
  actorId: string;
  organizationId: string;
  count: number;
}): Promise<{ contextId: string; messages: A2AMessage[] }> {
  const context = await A2AContextManager.createContext({
    kind: "user",
    id: params.actorId,
    organizationId: params.organizationId,
  });
  const messages: A2AMessage[] = [];
  for (let i = 0; i < params.count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const text = `turn-${i} ${"x".repeat(MESSAGE_TEXT_CHARS)}`;
    messages.push(
      await A2AMessageModel.create({
        contextId: context.id,
        role,
        parts: [],
        content: {
          id: `msg-${i}`,
          role,
          parts: [{ type: "text", text }],
        },
      }),
    );
  }
  return { contextId: context.id, messages };
}

describe("applyA2AContextCompaction", () => {
  test("compacts an over-budget history, persists the summary, and applies it on the next load", async ({
    makeUser,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeInternalAgent,
  }) => {
    const { userId, agent } = await setUpAgentWithModel({
      makeUser,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeInternalAgent,
    });
    const { contextId, messages } = await seedContextMessages({
      actorId: userId,
      organizationId: agent.organizationId,
      count: 8,
    });

    const summarizeCalls: Array<{
      transcript: string;
      previousSummary: string | null;
    }> = [];
    const result = await applyA2AContextCompaction({
      contextId,
      messages,
      agent,
      userId,
      summarizeTranscript: async (params) => {
        summarizeCalls.push(params);
        return "THE-SUMMARY";
      },
    });

    // A compaction happened: summary message first, then the verbatim recent
    // suffix — strictly fewer messages than the original history.
    expect(result.created).not.toBeNull();
    expect(result.messages.length).toBeLessThan(messages.length);
    const summaryContent = result.messages[0].content as {
      parts: Array<{ text: string }>;
    };
    expect(summaryContent.parts[0].text).toContain("THE-SUMMARY");
    // The summary is framed as untrusted history, not instructions.
    expect(summaryContent.parts[0].text).toContain("untrusted");

    // The summarizer saw the compacted prefix but not the recent suffix.
    expect(summarizeCalls).toHaveLength(1);
    expect(summarizeCalls[0].previousSummary).toBeNull();
    expect(summarizeCalls[0].transcript).toContain("turn-0");
    const recent = result.messages.slice(1);
    const lastRecentText = (
      recent.at(-1)?.content as { parts: Array<{ text: string }> }
    ).parts[0].text;
    expect(summarizeCalls[0].transcript).not.toContain(
      lastRecentText.slice(0, 8),
    );

    // Persisted record anchors at the last compacted message.
    const record =
      await A2AContextCompactionModel.findLatestByContext(contextId);
    expect(record).not.toBeNull();
    expect(record?.summary).toBe("THE-SUMMARY");
    const boundaryIndex = messages.length - recent.length - 1;
    expect(record?.boundaryMessageId).toBe(messages[boundaryIndex].id);

    // Next load: the stored summary is applied and no new compaction is
    // created — the compacted view is back under the threshold.
    const secondLoad = await applyA2AContextCompaction({
      contextId,
      messages,
      agent,
      userId,
      summarizeTranscript: async () => {
        throw new Error("should not summarize again");
      },
    });
    expect(secondLoad.created).toBeNull();
    const secondSummary = secondLoad.messages[0].content as {
      parts: Array<{ text: string }>;
    };
    expect(secondSummary.parts[0].text).toContain("THE-SUMMARY");
    expect(secondLoad.messages.length).toBe(recent.length + 1);
  });

  test("returns history unchanged when under the threshold", async ({
    makeUser,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeInternalAgent,
  }) => {
    const { userId, agent } = await setUpAgentWithModel({
      makeUser,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeInternalAgent,
    });
    const { contextId, messages } = await seedContextMessages({
      actorId: userId,
      organizationId: agent.organizationId,
      count: 2,
    });

    const result = await applyA2AContextCompaction({
      contextId,
      messages,
      agent,
      userId,
      summarizeTranscript: async () => {
        throw new Error("should not summarize");
      },
    });

    expect(result.created).toBeNull();
    expect(result.messages).toEqual(messages);
  });

  test("survives a failing summarizer by returning the uncompacted view", async ({
    makeUser,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeInternalAgent,
  }) => {
    const { userId, agent } = await setUpAgentWithModel({
      makeUser,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      makeInternalAgent,
    });
    const { contextId, messages } = await seedContextMessages({
      actorId: userId,
      organizationId: agent.organizationId,
      count: 8,
    });

    const result = await applyA2AContextCompaction({
      contextId,
      messages,
      agent,
      userId,
      summarizeTranscript: async () => {
        throw new Error("provider down");
      },
    });

    expect(result.created).toBeNull();
    expect(result.messages).toEqual(messages);
    expect(
      await A2AContextCompactionModel.findLatestByContext(contextId),
    ).toBeNull();
  });
});
