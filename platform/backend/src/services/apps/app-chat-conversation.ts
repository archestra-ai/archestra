import {
  ARCHESTRA_TOOL_PREFIX,
  TOOL_RENDER_APP_SHORT_NAME,
} from "@archestra/shared";
import { generateId, type UIMessage } from "ai";
import {
  AgentModel,
  AppModel,
  ConversationModel,
  MemberModel,
  MessageModel,
} from "@/models";
import { callerIsAppAdmin } from "@/services/apps/app-authorization";
import { buildAppRenderResult } from "@/services/apps/app-render-result";
import { ApiError } from "@/types";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";

const RENDER_APP_TOOL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_RENDER_APP_SHORT_NAME}` as const;

/**
 * Create a chat conversation with the app already mounted: it seeds a synthetic
 * `render_app` assistant message so the app renders inline on load and the
 * right-panel Apps tab opens — with no model turn. Backs the apps-page deep-link
 * (open an existing app, and create-new-then-open). Returns the conversation id
 * to navigate to (`/chat/<id>`).
 *
 * The seeded message is byte-for-byte what a model-driven `render_app` produces
 * (see {@link buildAppRenderResult}), so the chat renderer and `deriveAppsFromMessages`
 * treat it identically.
 */
export async function createSeededAppConversation(params: {
  appId: string;
  userId: string;
  organizationId: string;
  /** Agent to bind the chat to; defaults to the caller's default chat agent. */
  agentId?: string;
}): Promise<{ conversationId: string }> {
  const { appId, userId, organizationId } = params;

  const app = await AppModel.findByIdForCaller({
    id: appId,
    organizationId,
    userId,
    isAppAdmin: await callerIsAppAdmin(userId, organizationId),
  });
  if (!app) {
    throw new ApiError(404, `No app found with id ${appId}.`);
  }

  const agentId =
    params.agentId ??
    (await resolveDefaultChatAgentId({ userId, organizationId }));
  const agent = await AgentModel.findById(agentId);
  if (!agent || agent.organizationId !== organizationId) {
    throw new ApiError(404, "Agent not found");
  }

  const llmSelection = await resolveConversationLlmSelectionForAgent({
    agent: {
      llmApiKeyId: agent.llmApiKeyId ?? null,
      modelId: agent.modelId ?? null,
    },
    organizationId,
    userId,
  });

  const conversation = await ConversationModel.create({
    userId,
    organizationId,
    agentId,
    title: app.name,
    modelId: llmSelection.modelId,
    chatApiKeyId: llmSelection.chatApiKeyId,
  });

  // Typed as the AI SDK's UIMessage so the hand-built shape is checked at compile
  // time (the `content` column is `$type<any>`): `id`/`toolCallId` use the SDK's
  // generator so a seeded render is indistinguishable from a model-driven one.
  const content: UIMessage = {
    id: generateId(),
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: RENDER_APP_TOOL_NAME,
        toolCallId: generateId(),
        state: "output-available",
        input: { appId: app.id },
        output: buildAppRenderResult(app),
      },
    ],
  };

  await MessageModel.create({
    conversationId: conversation.id,
    role: "assistant",
    content,
  });

  return { conversationId: conversation.id };
}

// === internal ===

async function resolveDefaultChatAgentId(params: {
  userId: string;
  organizationId: string;
}): Promise<string> {
  const { userId, organizationId } = params;
  const existing = await MemberModel.getDefaultAgentId(userId, organizationId);
  if (existing) return existing;

  // No default yet (e.g. the member's first chat): bootstrap their personal chat
  // agent, mirroring how the chat page resolves a default agent.
  await AgentModel.ensurePersonalChatAgent({ userId, organizationId });
  const created = await MemberModel.getDefaultAgentId(userId, organizationId);
  if (!created) {
    throw new ApiError(500, "Could not resolve a default chat agent.");
  }
  return created;
}
