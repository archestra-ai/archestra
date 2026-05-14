import type { SupportedProvider } from "@shared";
import { and, eq, like } from "drizzle-orm";
import db, { schema } from "@/database";
import { seedDefaultUserAndOrg } from "@/database/seed";
import logger from "@/logging";
import {
  AgentModel,
  ConversationModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  MemberModel,
  OrganizationModel,
} from "@/models";
import type {
  Agent,
  Conversation,
  InsertConversationChatError,
  InsertMessage,
  LlmProviderApiKey,
  Organization,
} from "@/types";
import {
  type SeededChatPreviewScenario,
  seededChatPreviewScenarios,
  seededChatPreviewScenariosById,
} from "./chat-scenarios";

export const DEBUG_CHAT_TITLE_PREFIX = "[Debug seed]";
export const DEFAULT_CHAT_BASE_URL = "http://localhost:3000";

export type SeedChatScenariosOptions = {
  scenarioId?: string;
  keepExisting?: boolean;
  chatBaseUrl?: string;
};

export type SeededChatScenarioResult = {
  scenarioId: string;
  conversationId: string;
  url: string;
};

type SeedChatLlmSelection = {
  chatApiKeyId?: string;
  selectedModel: string;
  selectedProvider: SupportedProvider;
};

export async function seedChatScenarios(
  options: SeedChatScenariosOptions = {},
): Promise<SeededChatScenarioResult[]> {
  const scenarios = resolveScenarios(options.scenarioId);
  const user = await seedDefaultUserAndOrg();
  const organization = await OrganizationModel.getOrCreateDefaultOrganization();
  const agent = await findDefaultChatAgent({
    userId: user.id,
    organizationId: organization.id,
  });
  const llmSelection = await resolveSeedLlmSelection(organization);

  if (!options.keepExisting) {
    await deleteSeededConversations({
      titlePrefix: DEBUG_CHAT_TITLE_PREFIX,
      userId: user.id,
      organizationId: organization.id,
    });
  }

  const results: SeededChatScenarioResult[] = [];

  for (const scenario of scenarios) {
    const conversation = await createScenarioConversation({
      scenario,
      user,
      organizationId: organization.id,
      agent,
      llmSelection,
    });
    const url = buildConversationUrl({
      baseUrl: options.chatBaseUrl ?? DEFAULT_CHAT_BASE_URL,
      conversationId: conversation.id,
    });

    results.push({
      scenarioId: scenario.id,
      conversationId: conversation.id,
      url,
    });
  }

  logger.info(
    {
      count: results.length,
      keepExisting: options.keepExisting ?? false,
      scenarioId: options.scenarioId,
      urls: results.map((result) => result.url),
    },
    "Seeded chat debug scenarios",
  );

  return results;
}

function resolveScenarios(
  scenarioId: string | undefined,
): SeededChatPreviewScenario[] {
  if (!scenarioId) {
    return seededChatPreviewScenarios;
  }

  const scenario = seededChatPreviewScenariosById.get(scenarioId);
  if (!scenario) {
    const validScenarioIds = seededChatPreviewScenarios
      .map((candidate) => candidate.id)
      .join(", ");
    throw new Error(
      `Unknown chat scenario "${scenarioId}". Valid scenarios: ${validScenarioIds}`,
    );
  }

  return [scenario];
}

async function findDefaultChatAgent(params: {
  userId: string;
  organizationId: string;
}): Promise<Agent> {
  await AgentModel.ensurePersonalChatAgent(params);

  const defaultAgentId = await MemberModel.getDefaultAgentId(
    params.userId,
    params.organizationId,
  );
  if (!defaultAgentId) {
    throw new Error(
      "Default chat agent is unavailable after ensuring the personal chat agent",
    );
  }

  const agent = await AgentModel.findById(defaultAgentId, params.userId, true);
  if (!agent || agent.organizationId !== params.organizationId) {
    throw new Error(
      "Default chat agent could not be loaded for chat scenario seeding",
    );
  }

  return agent;
}

async function resolveSeedLlmSelection(
  organization: Organization,
): Promise<SeedChatLlmSelection> {
  const apiKey = await findSeedLlmProviderKey(organization);
  if (!apiKey) {
    return {
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
    };
  }

  const bestModel = await LlmProviderApiKeyModelLinkModel.getBestModel(
    apiKey.id,
  );

  return {
    chatApiKeyId: apiKey.id,
    selectedModel:
      bestModel?.modelId ?? organization.defaultLlmModel ?? "gpt-4o",
    selectedProvider:
      bestModel?.provider ?? organization.defaultLlmProvider ?? apiKey.provider,
  };
}

async function findSeedLlmProviderKey(
  organization: Organization,
): Promise<LlmProviderApiKey | null> {
  if (organization.defaultLlmApiKeyId) {
    const defaultApiKey = await LlmProviderApiKeyModel.findById(
      organization.defaultLlmApiKeyId,
    );
    if (defaultApiKey?.organizationId === organization.id) {
      return defaultApiKey;
    }
  }

  const [firstApiKey] = await LlmProviderApiKeyModel.findByOrganizationId(
    organization.id,
  );
  return firstApiKey ?? null;
}

async function createScenarioConversation(params: {
  scenario: SeededChatPreviewScenario;
  user: { id: string };
  organizationId: string;
  agent: Agent;
  llmSelection: SeedChatLlmSelection;
}): Promise<Conversation> {
  const conversation = await ConversationModel.create({
    userId: params.user.id,
    organizationId: params.organizationId,
    agentId: params.agent.id,
    title: `${DEBUG_CHAT_TITLE_PREFIX} ${params.scenario.title}`,
    chatApiKeyId: params.llmSelection.chatApiKeyId,
    selectedModel: params.llmSelection.selectedModel,
    selectedProvider: params.llmSelection.selectedProvider,
  });

  await bulkInsertSeedMessages(
    params.scenario.messages.map((message, index) => ({
      conversationId: conversation.id,
      role: message.role,
      content: message,
      createdAt: getMessageCreatedAt(message, index),
    })),
  );

  await bulkInsertSeedChatErrors(
    (params.scenario.chatErrors ?? []).map((chatError) => ({
      conversationId: conversation.id,
      error: chatError.error,
      createdAt: new Date(chatError.createdAt),
    })),
  );

  const seededConversation = await ConversationModel.findById({
    id: conversation.id,
    userId: params.user.id,
    organizationId: params.organizationId,
  });

  if (!seededConversation) {
    throw new Error(`Failed to load seeded conversation ${conversation.id}`);
  }

  return seededConversation;
}

async function deleteSeededConversations(params: {
  titlePrefix: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  await db
    .delete(schema.conversationsTable)
    .where(
      and(
        eq(schema.conversationsTable.userId, params.userId),
        eq(schema.conversationsTable.organizationId, params.organizationId),
        like(schema.conversationsTable.title, `${params.titlePrefix}%`),
      ),
    );
}

async function bulkInsertSeedMessages(
  messages: Array<InsertMessage & { createdAt: Date }>,
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  await db.insert(schema.messagesTable).values(messages);

  const uniqueConversationIds = [
    ...new Set(messages.map((message) => message.conversationId)),
  ];
  await Promise.all(
    uniqueConversationIds.map((conversationId) =>
      touchConversation(conversationId),
    ),
  );
}

async function bulkInsertSeedChatErrors(
  chatErrors: Array<InsertConversationChatError & { createdAt: Date }>,
): Promise<void> {
  if (chatErrors.length === 0) {
    return;
  }

  await db.insert(schema.conversationChatErrorsTable).values(chatErrors);
}

async function touchConversation(conversationId: string): Promise<void> {
  await db
    .update(schema.conversationsTable)
    .set({ updatedAt: new Date() })
    .where(eq(schema.conversationsTable.id, conversationId));
}

function getMessageCreatedAt(message: { metadata?: unknown }, index: number) {
  if (
    typeof message.metadata === "object" &&
    message.metadata !== null &&
    "createdAt" in message.metadata &&
    typeof message.metadata.createdAt === "string"
  ) {
    return new Date(message.metadata.createdAt);
  }

  return new Date(Date.UTC(2026, 3, 23, 10, 0, index));
}

function buildConversationUrl(params: {
  baseUrl: string;
  conversationId: string;
}): string {
  const baseUrl = params.baseUrl.replace(/\/$/, "");
  return `${baseUrl}/chat/${params.conversationId}`;
}
