import {
  ARCHESTRA_TOOL_PREFIX,
  buildFullToolName,
  TOOL_RENDER_APP_SHORT_NAME,
} from "@archestra/shared";
import { generateId, type UIMessage } from "ai";
import {
  AgentModel,
  AppModel,
  ConversationModel,
  McpServerModel,
  MemberModel,
  MessageModel,
} from "@/models";
import { callerIsAppAdmin } from "@/services/apps/app-authorization";
import {
  buildAppRenderResult,
  buildExternalAppRenderResult,
} from "@/services/apps/app-render-result";
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

  return seedConversationWithRender({
    userId,
    organizationId,
    agentId: params.agentId,
    title: app.name,
    part: {
      type: "dynamic-tool",
      toolName: RENDER_APP_TOOL_NAME,
      toolCallId: generateId(),
      state: "output-available",
      input: { appId: app.id },
      output: buildAppRenderResult(app),
    },
    // Skip for a brand-new app: its default template already lists these capabilities.
    greeting:
      app.latestVersion > 1 ? buildAppOpenedGreeting(app.name) : undefined,
  });
}

/**
 * Create a chat conversation with an external (MCP-server) UI app already
 * mounted, the external analogue of {@link createSeededAppConversation}. It
 * seeds a synthetic tool-call message whose output carries the UI pointer
 * (`_meta.ui.resourceUri`) plus the concrete `mcpServerId`, so the chat mounts
 * the app against that install via the server endpoint with no model turn.
 * Backs the apps-page deep-link for an MCP-server app card. Returns the
 * conversation id to navigate to (`/chat/<id>`).
 */
export async function createSeededExternalAppConversation(params: {
  mcpServerId: string;
  resourceUri: string;
  userId: string;
  organizationId: string;
  /** Agent to bind the chat to; defaults to the caller's default chat agent. */
  agentId?: string;
}): Promise<{ conversationId: string }> {
  const { mcpServerId, resourceUri, userId, organizationId } = params;

  const uiResource = await McpServerModel.findInstalledUiResourceForCaller({
    userId,
    mcpServerId,
    resourceUri,
  });
  if (!uiResource) {
    throw new ApiError(404, "No runnable app found for this install.");
  }

  // The card title: "<server> / <tool>" — also the seeded part's tool name, so
  // the chat's `mcpToolLabel` derives the same label.
  const label = `${uiResource.serverName} / ${uiResource.toolName}`;
  return seedConversationWithRender({
    userId,
    organizationId,
    agentId: params.agentId,
    title: label,
    part: {
      type: "dynamic-tool",
      toolName: buildFullToolName(uiResource.serverName, uiResource.toolName),
      toolCallId: generateId(),
      state: "output-available",
      input: {},
      output: buildExternalAppRenderResult({
        mcpServerId,
        resourceUri: uiResource.resourceUri,
        label,
      }),
    },
  });
}

// === internal ===

/**
 * Shared seeding: bind a new conversation to the caller's chat agent (resolving
 * its LLM selection) and persist a single hand-built assistant message whose one
 * part renders an app inline — no model turn. The part is typed as the AI SDK's
 * `UIMessage` part so the synthetic shape is compile-checked (the `content`
 * column is `$type<any>`) and is indistinguishable from a model-driven render.
 */
async function seedConversationWithRender(params: {
  userId: string;
  organizationId: string;
  agentId?: string;
  title: string;
  part: UIMessage["parts"][number];
  greeting?: string;
}): Promise<{ conversationId: string }> {
  const { userId, organizationId, title, part, greeting } = params;

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
    title,
    modelId: llmSelection.modelId,
    chatApiKeyId: llmSelection.chatApiKeyId,
  });

  const content: UIMessage = {
    id: generateId(),
    role: "assistant",
    parts: [part],
  };

  await MessageModel.create({
    conversationId: conversation.id,
    role: "assistant",
    content,
  });

  // Separate message so the render above stays a byte-for-byte model-driven render.
  if (greeting) {
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        id: generateId(),
        role: "assistant",
        parts: [{ type: "text", text: greeting }],
      } satisfies UIMessage,
    });
  }

  return { conversationId: conversation.id };
}

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

/** Markdown greeting seeded when an owned app is opened in chat. */
function buildAppOpenedGreeting(name: string): string {
  return (
    `Here's **${name}**, up and running.\n\n` +
    `It's an MCP app, so it can use:\n` +
    `- Your connected MCP tools & servers\n` +
    `- A private + shared data store\n` +
    `- Built-in AI to summarize & generate\n\n` +
    `Use it as-is, or tell me what you'd like to change or add ` +
    `— I'll update it live.`
  );
}
