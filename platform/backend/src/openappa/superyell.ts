import OpenAppaSuperyellModel from "@/models/openappa-superyell";
import type { OpenAppaSession } from "@/openappa/service";
import { startedUnenforced } from "@/openappa/unenforced";

/**
 * A session a person took out of OpenAPPA.
 *
 * `superyell` runs only after the person running the session approves it: the
 * default policy gives it a `human-approval` rule. Once it runs, the proxy
 * stops consulting OpenAPPA for the session, the same way it ignores a session
 * that started while enforcement was off. The session's label stops applying,
 * so it starts again from nothing. Children the session starts after that are
 * out of OpenAPPA too.
 */

/** Records that the person running `session` took it out of OpenAPPA. */
export async function superyell(params: {
  session: OpenAppaSession;
  userId: string | undefined;
}): Promise<void> {
  await OpenAppaSuperyellModel.recordSession({
    organizationId: params.session.organization_id,
    sessionId: params.session.session_id,
    userId: params.userId,
  });
}

/**
 * Whether the session, or the parent that started it, was superyelled. A
 * child of such a parent is recorded too, so its own children follow it.
 * Never cached, so every replica decides from the same rows.
 */
export async function superyelled(session: OpenAppaSession): Promise<boolean> {
  const recorded = await OpenAppaSuperyellModel.findSessionIds({
    organizationId: session.organization_id,
    sessionIds: [
      session.session_id,
      ...(session.parent_id ? [session.parent_id] : []),
    ],
  });
  if (recorded.has(session.session_id)) return true;
  if (!session.parent_id || !recorded.has(session.parent_id)) return false;
  await OpenAppaSuperyellModel.recordSession({
    organizationId: session.organization_id,
    sessionId: session.session_id,
    userId: undefined,
  });
  return true;
}

/**
 * Whether OpenAPPA leaves the session alone: it started while enforcement was
 * off, or a person superyelled it.
 */
export async function ungoverned(session: OpenAppaSession): Promise<boolean> {
  return (await superyelled(session)) || (await startedUnenforced(session));
}
