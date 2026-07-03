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
    greeting: buildAppOpenedGreeting(app.name),
  });
}

/**
 * How an external app conversation was set up: `render` seeds the app already
 * mounted (no model turn); `prompt` leaves the conversation empty and hands the
 * client an opening user prompt to send through the normal chat path, so the
 * agent collects the tool's required inputs before calling it.
 */
type ExternalAppOpenResult = {
  conversationId: string;
  mode: "render" | "prompt";
  /** The opening user message to send; present only for `mode: "prompt"`. */
  prompt?: string;
};

/**
 * Create a chat conversation for an external (MCP-server) UI app, the external
 * analogue of {@link createSeededAppConversation}. Backs the apps-page
 * deep-link for an MCP-server app card. Returns the conversation id to
 * navigate to (`/chat/<id>`) plus the open mode.
 *
 * Two modes, decided by the tool's input schema:
 * - No required inputs: seed a synthetic tool-call message whose output
 *   carries the UI pointer (`_meta.ui.resourceUri`) plus the concrete
 *   `mcpServerId`, so the chat mounts the app against that install via the
 *   server endpoint with no model turn (`mode: "render"`).
 * - Required inputs: rendering with input `{}` would mount a broken app, so
 *   the conversation is created empty and the caller gets an opening prompt
 *   (`mode: "prompt"`) to send as the first user message — the agent asks for
 *   the inputs, calls the tool, and the tool result mounts the app.
 */
export async function createSeededExternalAppConversation(params: {
  mcpServerId: string;
  resourceUri: string;
  userId: string;
  organizationId: string;
  /** Agent to bind the chat to; defaults to the caller's default chat agent. */
  agentId?: string;
}): Promise<ExternalAppOpenResult> {
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

  if (toolRequiresInputs(uiResource.toolParameters)) {
    const { conversationId } = await createAppChatConversation({
      userId,
      organizationId,
      agentId: params.agentId,
      title: label,
    });
    return {
      conversationId,
      mode: "prompt",
      prompt:
        `Open the ${label} app. ` +
        `Ask me for any inputs you need first, then call the ` +
        `${uiResource.toolName} tool on the ${uiResource.serverName} MCP server.`,
    };
  }

  const { conversationId } = await seedConversationWithRender({
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
  return { conversationId, mode: "render" };
}

// === internal ===

/**
 * Whether calling the tool with input `{}` cannot succeed: its input schema
 * declares required properties. Mirrors `normalizeToolInputSchema`
 * (routes/mcp-gateway.utils.ts): anything that isn't a `type: "object"` schema
 * normalizes to an empty object schema, i.e. no required inputs.
 */
function toolRequiresInputs(parameters: unknown): boolean {
  if (
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters)
  ) {
    return false;
  }
  const schema = parameters as { type?: unknown; required?: unknown };
  if (schema.type !== "object") return false;
  return Array.isArray(schema.required) && schema.required.length > 0;
}

/**
 * Bind a new, empty conversation to the caller's chat agent (resolving its LLM
 * selection). Shared by the render seeding below and the prompt-mode external
 * open (which leaves the conversation empty for the client's first send).
 */
async function createAppChatConversation(params: {
  userId: string;
  organizationId: string;
  agentId?: string;
  title: string;
}): Promise<{ conversationId: string }> {
  const { userId, organizationId, title } = params;

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

  return { conversationId: conversation.id };
}

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
  const { userId, organizationId, agentId, title, part, greeting } = params;

  const { conversationId } = await createAppChatConversation({
    userId,
    organizationId,
    agentId,
    title,
  });

  const content: UIMessage = {
    id: generateId(),
    role: "assistant",
    parts: [part],
  };

  await MessageModel.create({
    conversationId,
    role: "assistant",
    content,
  });

  // Separate message so the render above stays a byte-for-byte model-driven render.
  if (greeting) {
    await MessageModel.create({
      conversationId,
      role: "assistant",
      content: {
        id: generateId(),
        role: "assistant",
        parts: [{ type: "text", text: greeting }],
      } satisfies UIMessage,
    });
  }

  return { conversationId };
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
    `Here's **${name}**.\n\n` +
    `Want to change the app? Tell me how!\n\n` +
    `Want to use the app? Use the UI 👉, or ask me to!`
  );
}
