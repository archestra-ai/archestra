import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import type { OpenAppaSession } from "./service";

// Like Archestra's dual-LLM progress bus, this connects a Chat turn to its
// loopback proxy request in the same process. A channel is not an identity:
// the proxy must verify Chat's signature and match the full session scope.
const viewers = new Map<
  string,
  { scope: string; bridge: ChatMcpElicitationBridge }
>();

function scope(session: OpenAppaSession) {
  return JSON.stringify([
    session.organization_id,
    session.caller_id,
    session.session_id,
    session.parent_id ?? null,
  ]);
}

export function registerChatReview(
  channel: string,
  session: OpenAppaSession,
  bridge: ChatMcpElicitationBridge,
) {
  const entry = { scope: scope(session), bridge };
  viewers.set(channel, entry);
  return () => {
    if (viewers.get(channel) === entry) viewers.delete(channel);
  };
}

export function getChatReview(
  channel: string | undefined,
  session: OpenAppaSession,
): ChatMcpElicitationBridge | undefined {
  const entry = channel ? viewers.get(channel) : undefined;
  return entry?.scope === scope(session) ? entry.bridge : undefined;
}
