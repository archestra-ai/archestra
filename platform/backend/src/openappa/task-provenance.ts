import OpenAppaSessionModel from "@/models/openappa-session";
import { ApiError } from "@/types";
import {
  admitPeerMessage,
  type OpenAppaSession,
  sendPeerMessage,
  startOpenappaSession,
} from "./service";
import { observeUnenforcedSession, startedUnenforced } from "./unenforced";

/** Clone initial labels; later arrivals must join them, never reset the root. */
export async function inheritTaskSession(params: {
  parent: OpenAppaSession;
  session: OpenAppaSession;
  occurrenceId: string;
  input: string;
}): Promise<void> {
  const { parent, session } = params;
  if (
    parent.organization_id !== session.organization_id ||
    !parent.caller_id ||
    parent.caller_id !== session.caller_id
  ) {
    throw new ApiError(403, "The task source belongs to a different caller");
  }
  if (await startedUnenforced(parent)) {
    if (session.session_id === parent.session_id) return;
    // A positive legacy record is not a missing governed parent. Keep this
    // host-created task in that mode without replacing any native trajectory.
    if (
      (await observeUnenforcedSession(session)) !== "unenforced" ||
      !(await startedUnenforced(session))
    ) {
      throw new ApiError(
        409,
        "The task session cannot replace an existing governed trajectory",
      );
    }
    return;
  }
  const ownedParent = await OpenAppaSessionModel.familySession({
    organizationId: parent.organization_id,
    sessionId: parent.session_id,
    callerId: parent.caller_id,
  });
  if (!ownedParent || ownedParent.parentId !== (parent.parent_id ?? null)) {
    throw new ApiError(409, "The producing task source is unavailable");
  }
  if (session.session_id === parent.session_id) return;
  const existing = await OpenAppaSessionModel.familySession({
    organizationId: session.organization_id,
    sessionId: session.session_id,
    callerId: session.caller_id,
  });
  if (!existing) {
    await startOpenappaSession({
      ...session,
      fork_of: parent.session_id,
    });
    return;
  }
  const sent = await sendPeerMessage({
    session: parent,
    operationId: `task-input:${params.occurrenceId}`,
    recipientSessionId: session.session_id,
    ...(existing.parentId ? { recipientParentId: existing.parentId } : {}),
    value: params.input,
  });
  if (sent.kind !== "released") {
    throw new ApiError(
      409,
      "The task input cannot be delivered to this session",
    );
  }
  const admitted = await admitPeerMessage({
    session: {
      ...session,
      ...(existing.parentId ? { parent_id: existing.parentId } : {}),
    },
    messageId: sent.messageId,
    senderSessionId: parent.session_id,
    value: params.input,
    structured: true,
  });
  if (admitted.kind !== "admitted" || admitted.value !== params.input) {
    throw new ApiError(
      409,
      "The task input cannot be shown to this retained session",
    );
  }
}
