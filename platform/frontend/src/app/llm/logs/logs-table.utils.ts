import { type archestraApiTypes, DynamicInteraction } from "@shared";

export type AgentNameSource = {
  id: string;
  name: string;
};

export type SessionData =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number];

type SessionDisplaySource = {
  sessionId: string | null;
  interactionId: string | null;
  conversationTitle: string | null;
  claudeCodeTitle: string | null;
  sessionSource: string | null;
  lastInteractionRequest: unknown;
  lastInteractionType: string | null;
};

type SessionDisplayData = {
  isSingleInteraction: string | null;
  conversationTitle: string | null;
  isArchestraChat: string | null;
  isClaudeCodeSession: boolean;
  lastUserMessage: string;
  displayText: string;
};

export type EnrichedSessionRow = SessionData & SessionDisplayData;

export function buildAgentNameMap(
  agents: AgentNameSource[] | undefined,
): Map<string, string> {
  return new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
}

export function enrichSessionRows<T extends SessionDisplaySource>(
  sessions: T[],
): Array<T & SessionDisplayData> {
  return sessions.map((session) => ({
    ...session,
    ...getSessionDisplayData(session),
  }));
}

function getSessionDisplayData(
  session: SessionDisplaySource,
): SessionDisplayData {
  const isSingleInteraction =
    session.sessionId === null ? session.interactionId : null;
  const conversationTitle = session.conversationTitle;
  const isArchestraChat = conversationTitle ? session.sessionId : null;
  const claudeCodeTitle = session.claudeCodeTitle;
  const isClaudeCodeSession = session.sessionSource === "claude_code";

  let lastUserMessage = "";
  if (session.lastInteractionRequest && session.lastInteractionType) {
    try {
      const mockInteraction = {
        request: session.lastInteractionRequest,
        response: {},
        type: session.lastInteractionType,
      };
      const interaction = new DynamicInteraction(
        mockInteraction as archestraApiTypes.GetInteractionResponses["200"],
      );
      lastUserMessage = interaction.getLastUserMessage();
    } catch {
      lastUserMessage = "";
    }
  }

  return {
    isSingleInteraction,
    conversationTitle,
    isArchestraChat,
    isClaudeCodeSession,
    lastUserMessage,
    displayText: claudeCodeTitle || lastUserMessage,
  };
}
