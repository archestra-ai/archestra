import {
  ARCHESTRA_TOOL_PREFIX,
  TOOL_RENDER_APP_SHORT_NAME,
} from "@archestra/shared";
import { generateId, type UIMessage } from "ai";
import {
  AgentModel,
  AppAccessModel,
  AppModel,
  ConversationModel,
  McpServerModel,
  MemberModel,
  MessageModel,
  OrganizationModel,
} from "@/models";
import type { resolveLockedChatCreationIfRequested } from "@/routes/chat/locked-chat";
import { LOCKED_CHAT_STATIC_TITLE } from "@/routes/chat/locked-chat";
import { callerIsAppAdmin } from "@/services/apps/app-authorization";
import {
  buildAppRenderResult,
  buildExternalAppRenderResult,
} from "@/services/apps/app-render-result";
import { escapeAppNameForModelText } from "@/services/apps/app-run-link";
import { chatAgentVisibilityFor } from "@/services/chat-agent-visibility";
import { ApiError } from "@/types";
import { externalAppLabel } from "@/utils/external-app-label";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";
import { toolRequiresInputs } from "@/utils/tool-inputs";

const RENDER_APP_TOOL_NAME =
  `${ARCHESTRA_TOOL_PREFIX}${TOOL_RENDER_APP_SHORT_NAME}` as const;

/**
 * What the route resolved from the request's locked-chat key header: the
 * conversation id the fingerprint is bound to, the row fields to write, and
 * the key to seal seeded messages with. Null for an ordinary app chat.
 */
type LockedChatSeed = NonNullable<
  ReturnType<typeof resolveLockedChatCreationIfRequested>
>;

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
  /**
   * The chat agent to bind the conversation to. Callers that had to resolve it
   * before this call — app creation binds the new app to that agent's
   * environment — pass it in so the app and the conversation cannot disagree
   * about which agent is building the app. Omitted, it is resolved here.
   */
  agentId?: string;
  /**
   * This conversation is the app's own creation-time build chat, and its caller
   * grants it the app's creation grace the moment it has an id. An app an
   * organization default disabled at birth is therefore seeded rather than
   * refused: the authoring tools will answer this one conversation. Deep links
   * to an existing app never set it, and so still meet the T-980 refusal below.
   */
  creationBuildChat?: boolean;
  /**
   * Present when the caller asked for a LOCKED app chat: the open-in-chat POST
   * carried the browser's conversation key, so this conversation is created
   * locked and everything seeded into it is sealed under that key. See
   * `resolveLockedChatCreationIfRequested`.
   */
  lockedChat?: LockedChatSeed | null;
}): Promise<{ conversationId: string }> {
  const { appId, userId, organizationId, agentId, lockedChat } = params;

  const app = await AppModel.findByIdForCaller({
    id: appId,
    organizationId,
    userId,
    isAppAdmin: await callerIsAppAdmin(userId, organizationId),
  });
  // A disabled app does not exist for chat (T-980) — deep-link seeding
  // included, or the seeded render would hand the model the very app every
  // chat tool refuses to acknowledge. Its author previews it from the Apps
  // page instead. The app's own build chat is the exception: there the tools
  // do answer this conversation, so seeding it hands the model an app it can
  // actually work on.
  if (!app || (!app.enabled && !params.creationBuildChat)) {
    throw new ApiError(404, `No app found with id ${appId}.`);
  }

  // An app-admin can open an app they only see through oversight (someone
  // else's personal app). They may use it and change its settings, but not edit
  // it via chat — so the greeting must not invite edits the authoring tools
  // will refuse. "Reachable without the admin bypass" is exactly "not oversight".
  const isOversight = !(await AppAccessModel.userHasAppAccess({
    organizationId,
    userId,
    app,
    isAppAdmin: false,
  }));

  return seedConversationWithRender({
    userId,
    organizationId,
    agentId,
    lockedChat,
    title: app.name,
    part: {
      type: "dynamic-tool",
      toolName: RENDER_APP_TOOL_NAME,
      toolCallId: generateId(),
      state: "output-available",
      input: { appId: app.id },
      output: buildAppRenderResult(app),
    },
    greeting: buildAppOpenedGreeting(app.name, isOversight),
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
  /** See the same field on {@link createSeededAppConversation}. */
  lockedChat?: LockedChatSeed | null;
}): Promise<ExternalAppOpenResult> {
  const { mcpServerId, resourceUri, userId, organizationId, lockedChat } =
    params;

  const uiResource = await McpServerModel.findInstalledUiResourceForCaller({
    userId,
    mcpServerId,
    resourceUri,
  });
  if (!uiResource) {
    throw new ApiError(404, "No runnable app found for this install.");
  }

  // The apps-page card title: the server name, "/ <tool>"-suffixed only when
  // the server exposes several UI tools. Reused as the conversation title and
  // the rendered app's display label so all three surfaces agree.
  const label = externalAppLabel(uiResource);

  if (toolRequiresInputs(uiResource.toolParameters)) {
    const { conversationId } = await createAppChatConversation({
      userId,
      organizationId,
      title: label,
      lockedChat,
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
    title: label,
    lockedChat,
    part: {
      type: "dynamic-tool",
      // The tool's stored name, verbatim. `serverName`/`toolName` are a display
      // pair — the stored prefix is a slug of the catalog's human name (and may
      // be truncated), so recombining them names a tool that dispatches nowhere
      // and puts a fake name in front of the model.
      toolName: uiResource.fullToolName,
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

/**
 * The chat agent a caller's app conversation binds to — the agent that builds
 * an app opened from the Apps page. Exported because app creation needs it
 * *before* the conversation exists: a new app is bound to this agent's
 * environment, so the agent can assign the tools it discovers there.
 *
 * Mirrors the /chat page chain (resolveInitialAgentSelection); keep the two in
 * sync. A project's pinned agent outranks everything here, but app chats are
 * never started in a project, so this chain begins one rung lower.
 */
export async function resolveDefaultChatAgentId(params: {
  userId: string;
  organizationId: string;
}): Promise<string> {
  const { userId, organizationId } = params;
  // Both rungs below judge an agent by the same rule that granted the pin, so
  // resolve the caller's visibility once and reuse it.
  const visibility = await chatAgentVisibilityFor({ userId, organizationId });

  // 1. The member's pinned default — a deliberate choice, so it outranks the
  //    organization's. It is a bare FK, so re-check it still names something
  //    this caller can chat with: the pin survives the agent being deleted or
  //    the caller losing access to it, and either must fall through rather
  //    than bind the conversation to an agent they cannot use. The check is
  //    the one that granted the pin, so the two can never disagree.
  const memberDefaultId = await MemberModel.getDefaultAgentId(
    userId,
    organizationId,
  );
  if (memberDefaultId) {
    const memberDefault = await visibility.find(memberDefaultId);
    if (memberDefault) return memberDefault.id;
  }

  // 2. The organization default, under the same visibility check — it only
  //    counts when it would appear in the /chat picker for this caller.
  const organization = await OrganizationModel.getById(organizationId);
  if (organization?.defaultAgentId) {
    const orgDefault = await visibility.find(organization.defaultAgentId);
    if (orgDefault) return orgDefault.id;
  }

  // 3. The caller's own personal chat agent, seeded on first use. This is the
  //    tail every member lands on before an admin configures anything, and it
  //    must not be reached through `members.default_agent_id`: that column now
  //    records only a deliberate choice (step 1) and is null for members who
  //    never made one.
  const personalAgentId = await AgentModel.ensurePersonalChatAgent({
    userId,
    organizationId,
  });
  if (personalAgentId) return personalAgentId;

  // 4. Reached only by a member who authored personal chat agents and deleted
  //    them all — seeding deliberately does not resurrect one — in an
  //    organization with no default either. The /chat picker still offers them
  //    every chat agent they can reach and starts on the first, so do the same
  //    here rather than refusing an app chat the composer would have allowed.
  const accessible = await AgentModel.findAll(userId, false, {
    agentType: "agent",
    excludeBuiltIn: true,
  });
  const [first] = accessible.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  if (first) return first.id;

  throw new ApiError(
    400,
    "You have no default agent. Create a personal agent or ask an admin to set an organization default.",
  );
}

// === internal ===

/**
 * Bind a new, empty conversation to the caller's chat agent (resolving its LLM
 * selection). Shared by the render seeding below and the prompt-mode external
 * open (which leaves the conversation empty for the client's first send).
 */
async function createAppChatConversation(params: {
  userId: string;
  organizationId: string;
  title: string;
  /** Pre-resolved chat agent; resolved here when the caller has none. */
  agentId?: string;
  lockedChat?: LockedChatSeed | null;
}): Promise<{ conversationId: string }> {
  const { userId, organizationId, title, lockedChat } = params;

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
    // A locked chat is titled like every other locked chat. The app's name
    // would otherwise sit in a plaintext column and say which app the chat is
    // running — the sort of thing the lock exists to keep out of the database.
    // It is the final title too, so it is not marked a placeholder.
    ...(lockedChat
      ? {
          id: lockedChat.conversationId,
          ...lockedChat.fields,
          title: LOCKED_CHAT_STATIC_TITLE,
          titleIsPlaceholder: false,
        }
      : {
          title,
          // The app's name above is a stand-in so the header and sidebar have
          // something to show before the first exchange; title generation
          // replaces it once there is a real conversation to title.
          titleIsPlaceholder: true,
        }),
    modelId: llmSelection.modelId,
    chatApiKeyId: llmSelection.chatApiKeyId,
    // App-opened chats are drafts: the conversations list hides them until the
    // user writes a message (see ConversationModel.findAll), so clicking
    // through apps doesn't pile unused chats into the sidebar.
    origin: "app_open",
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
  title: string;
  part: UIMessage["parts"][number];
  greeting?: string;
  /** Pre-resolved chat agent; resolved downstream when the caller has none. */
  agentId?: string;
  lockedChat?: LockedChatSeed | null;
}): Promise<{ conversationId: string }> {
  const { userId, organizationId, title, part, greeting, agentId, lockedChat } =
    params;

  const { conversationId } = await createAppChatConversation({
    userId,
    organizationId,
    title,
    agentId,
    lockedChat,
  });

  const content: UIMessage = {
    id: generateId(),
    role: "assistant",
    parts: [part],
  };

  // Seeded server-side, but stored exactly like a model-written message —
  // sealed under the conversation key when the chat is locked.
  await MessageModel.create(
    {
      conversationId,
      role: "assistant",
      content,
    },
    lockedChat?.key ?? null,
  );

  // Separate message so the render above stays a byte-for-byte model-driven render.
  if (greeting) {
    await MessageModel.create(
      {
        conversationId,
        role: "assistant",
        content: {
          id: generateId(),
          role: "assistant",
          parts: [{ type: "text", text: greeting }],
        } satisfies UIMessage,
      },
      lockedChat?.key ?? null,
    );
  }

  return { conversationId };
}

/**
 * Markdown greeting seeded when an owned app is opened in chat. For an admin
 * viewing an app they only see through oversight, it invites use — not edits —
 * since the authoring tools refuse to modify someone else's app.
 */
function buildAppOpenedGreeting(name: string, isOversight: boolean): string {
  const heading = `Here's **${escapeAppNameForModelText(name)}**.`;
  if (isOversight) {
    return (
      `${heading}\n\n` +
      `You're viewing this app as an administrator — it belongs to another ` +
      `user. You can use it and change its settings, but not modify the app ` +
      `itself here.\n\n` +
      `Want to use the app? Use the UI 👉, or ask me to!`
    );
  }
  return (
    `${heading}\n\n` +
    `Want to change the app? Tell me how!\n\n` +
    `Want to use the app? Use the UI 👉, or ask me to!`
  );
}
