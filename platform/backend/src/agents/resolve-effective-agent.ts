import {
  getArchestraToolShortName,
  TOOL_SWAP_AGENT_SHORT_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
} from "@shared";
import { isAgentTypeAdmin } from "@/auth/agent-type-permissions";
import logger from "@/logging";
import {
  AgentModel,
  ConversationModel,
  MemberModel,
  MessageModel,
} from "@/models";

/**
 * Walk a conversation's stored message history in order and return the agent
 * that was effectively active by the end of the chat. Honors successful
 * `archestra__swap_agent` / `archestra__swap_to_default_agent` tool calls
 * (state === "output-available"); ignores errored or pending swaps.
 *
 * Used by `create_scheduled_task` so that when the agent omits `agentId`, the
 * scheduled task attaches to the right agent even when the conversation
 * involved multiple agents via swap.
 *
 * Falls back to the conversation's stored `agentId` (or `params.fallbackAgentId`
 * if the conversation can't be loaded) on any unrecoverable error — never
 * throws.
 */
export async function resolveEffectiveAgentForConversation(params: {
  conversationId: string | undefined;
  userId: string;
  organizationId: string;
  fallbackAgentId: string;
}): Promise<string> {
  const { conversationId, userId, organizationId, fallbackAgentId } = params;

  if (!conversationId) return fallbackAgentId;

  try {
    const conversation = await ConversationModel.findById({
      id: conversationId,
      userId,
      organizationId,
    });
    if (!conversation || conversation.organizationId !== organizationId) {
      return fallbackAgentId;
    }

    let active = conversation.agentId ?? fallbackAgentId;
    const messages = await MessageModel.findByConversation(conversationId);
    const isAgentAdmin = await isAgentTypeAdmin({
      userId,
      organizationId,
      agentType: "agent",
    });

    for (const message of messages) {
      const parts = extractParts(message.content);
      for (const part of parts) {
        const swapKind = classifySwapPart(part);
        if (!swapKind) continue;

        const resolved =
          swapKind === "swap_agent"
            ? await resolveSwapTarget({
                part,
                userId,
                organizationId,
                isAgentAdmin,
              })
            : await MemberModel.getDefaultAgentId(userId, organizationId);

        if (resolved) active = resolved;
      }
    }

    return active;
  } catch (error) {
    logger.warn(
      { err: error, conversationId, userId, organizationId },
      "resolveEffectiveAgentForConversation: falling back due to error",
    );
    return fallbackAgentId;
  }
}


type SwapKind = "swap_agent" | "swap_to_default_agent";

type ToolPart = {
  type: string;
  state?: string;
  input?: { agent_name?: unknown } | null;
};

function extractParts(content: unknown): ToolPart[] {
  if (!content || typeof content !== "object") return [];
  const parts = (content as { parts?: unknown }).parts;
  return Array.isArray(parts) ? (parts as ToolPart[]) : [];
}

function classifySwapPart(part: ToolPart): SwapKind | null {
  if (!part || typeof part.type !== "string") return null;
  if (part.state !== "output-available") return null;
  if (!part.type.startsWith("tool-")) return null;

  const toolName = part.type.slice("tool-".length);
  const shortName = getArchestraToolShortName(toolName);
  if (shortName === TOOL_SWAP_AGENT_SHORT_NAME) return "swap_agent";
  if (shortName === TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME) {
    return "swap_to_default_agent";
  }
  return null;
}

async function resolveSwapTarget(params: {
  part: ToolPart;
  userId: string;
  organizationId: string;
  isAgentAdmin: boolean;
}): Promise<string | null> {
  const rawName = params.part.input?.agent_name;
  if (typeof rawName !== "string") return null;
  const agentName = rawName.trim();
  if (!agentName) return null;

  // mirror the swap_agent tool's lookup so the resolver picks the same agent
  const results = await AgentModel.findAllPaginated(
    { limit: 5, offset: 0 },
    undefined,
    {
      name: agentName,
      agentType: "agent",
      excludeOtherPersonalAgents: true,
    },
    params.userId,
    params.isAgentAdmin,
  );

  if (results.data.length === 0) return null;

  const exact = results.data.find(
    (a) => a.name.toLowerCase() === agentName.toLowerCase(),
  );
  const target = exact ?? results.data[0];

  if (!target || target.organizationId !== params.organizationId) return null;
  if (target.agentType !== "agent") return null;
  return target.id;
}
