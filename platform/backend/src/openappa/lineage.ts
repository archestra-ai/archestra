import { OpenAppaSessionModel } from "@/models";
import { ApiError } from "@/types";

/**
 * Where a request whose history carries this caller's stamped calls belongs.
 *
 * The session that made the history's latest calls is its head: the request's
 * own session when it made calls in this history, otherwise the last stamped
 * session. Every other session the history names must be an ancestor of the
 * head on its fork line; a history that mixes unrelated sessions has no one
 * trajectory to continue, and taking any one of them would drop the others'
 * labels, so it is refused.
 *
 * Returns the session a new session forks, or undefined when the request
 * continues a session of its own. A session that already governs a trajectory
 * of its own never becomes a fork. All ids are the client's own, unscoped;
 * `scope` adds the caller prefix the runtime keys sessions by.
 */
export async function forkedSession(params: {
  organizationId: string;
  sessionId: string;
  stamped: readonly string[];
  scope: (sessionId: string) => string;
}): Promise<string | undefined> {
  const own = params.stamped.includes(params.sessionId);
  const head = own ? params.sessionId : params.stamped.at(-1);
  if (head === undefined) return undefined;
  const others = params.stamped.filter((session) => session !== head);
  if (others.length > 0) {
    const line = new Set(
      await OpenAppaSessionModel.forkLine({
        organizationId: params.organizationId,
        sessionId: params.scope(head),
      }),
    );
    if (others.some((session) => !line.has(params.scope(session)))) {
      throw new ApiError(
        400,
        "OpenAPPA cannot continue a history that mixes calls from unrelated sessions; resume one of those sessions instead",
      );
    }
  }
  if (own) return undefined;
  const existing = await OpenAppaSessionModel.find({
    organizationId: params.organizationId,
    sessionId: params.scope(params.sessionId),
  });
  if (existing && existing.forkedFrom !== params.scope(head)) {
    throw new ApiError(
      409,
      "OpenAPPA cannot continue another session's history in a session that governs its own trajectory; start a new session or resume the one this history came from",
    );
  }
  return head;
}
