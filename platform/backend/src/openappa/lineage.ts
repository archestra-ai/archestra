import { OpenAppaSessionModel } from "@/models";
import { ApiError } from "@/types";

/**
 * Determines parent session lineage for incoming conversation history.
 *
 * The deepest verified source is the history head. All other sources must be
 * ancestors along a single fork line. If a history mixes unrelated sessions,
 * the request is rejected because it lacks a single trajectory.
 *
 * Returns the parent session ID for a new fork, or undefined if the request
 * continues its own session. A session that already governs its own trajectory
 * never becomes a fork.
 */
export async function forkedSession(params: {
  organizationId: string;
  sessionId: string;
  traced: readonly string[];
  scope: (sessionId: string) => string;
}): Promise<string | undefined> {
  const started = await OpenAppaSessionModel.startedSessionIds({
    organizationId: params.organizationId,
    sessionIds: params.traced.map(params.scope),
  });
  if (params.traced.some((session) => !started.has(params.scope(session)))) {
    throw new ApiError(
      400,
      "OpenAPPA cannot continue context whose source session is unavailable",
    );
  }
  const traced = [...new Set(params.traced)];
  const lines = await OpenAppaSessionModel.forkLines({
    organizationId: params.organizationId,
    sessionIds: traced.map(params.scope),
  });
  const head = traced.find((candidate) => {
    const ancestors = new Set(lines.get(params.scope(candidate)));
    return traced.every(
      (session) =>
        session === candidate || ancestors.has(params.scope(session)),
    );
  });
  if (head === undefined) {
    if (traced.length === 0) return undefined;
    throw new ApiError(
      400,
      "OpenAPPA cannot continue a history that mixes context from unrelated sessions. Resume one of those sessions instead.",
    );
  }
  if (head === params.sessionId) return undefined;
  const existing = await OpenAppaSessionModel.find({
    organizationId: params.organizationId,
    sessionId: params.scope(params.sessionId),
  });
  if (existing && existing.forkedFrom !== params.scope(head)) {
    throw new ApiError(
      409,
      "OpenAPPA cannot continue another session's history in a session that governs its own trajectory. Start a new session or resume the source session.",
    );
  }
  return head;
}
