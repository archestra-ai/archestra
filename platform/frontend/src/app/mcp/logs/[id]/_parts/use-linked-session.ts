import type { archestraApiTypes } from "@archestra/shared";
import { useInteractionSessions } from "@/lib/interactions/interaction.query";

/**
 * The LLM session a tool call was recorded in, if it names one. `gone` means
 * it named a session the listing does not return: deleted, or not visible to
 * this user. Either way there is no trace to open.
 */
export function useLinkedSession(call: { sessionId: string | null }) {
  const sessionId = call.sessionId;
  const query = useInteractionSessions({
    sessionId: sessionId ?? undefined,
    limit: 1,
    toastOnError: false,
    enabled: sessionId !== null,
  });
  const session: LogSession | undefined = query.data?.data[0];
  return {
    sessionId,
    session,
    gone: sessionId !== null && query.isSuccess && !session,
  };
}

type LogSession =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number];
