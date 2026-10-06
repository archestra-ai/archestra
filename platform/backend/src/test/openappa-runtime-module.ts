import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db from "@/database";
import { openappaSessionsTable } from "@/database/schemas/openappa";
import { openappaActor } from "@/openappa/actor";

const sessions = openappaSessionsTable;

type Dispatch = (raw: string) => Promise<string> | string;

/**
 * Native module stand-in. Every dispatch, including a test override, persists
 * the session row the real runtime would write. A child reuses its parent's
 * root. A fork gets its own root and forkedFrom. A missing parent is not invented.
 */
export function createRuntimeModule() {
  const dispatchHook = vi.fn(async (raw: string) => {
    await persistNativeSessionStart(raw);
    return JSON.stringify({ decision: "ack" });
  });
  const implement = dispatchHook.mockImplementation.bind(dispatchHook);
  dispatchHook.mockImplementation = ((impl: Dispatch) =>
    implement(async (raw: string) => {
      await persistNativeSessionStart(raw);
      return impl(raw);
    })) as typeof dispatchHook.mockImplementation;
  return {
    initializeOpenappa: vi.fn(),
    dispatchHook,
    loadChildReturns: vi.fn(
      async (
        _organizationId: string,
        _parentSessionId: string,
      ): Promise<
        Array<{
          childSessionId: string;
          spawnCallId?: string;
          childNativeId?: string;
          value: string;
        }>
      > => [],
    ),
    loadChildAddresses: vi.fn(
      async (
        _organizationId: string,
        _childSessionId: string,
      ): Promise<Array<{ parentSessionId: string; value: string }>> => [],
    ),
    listBundledOpenappaBatteries: vi.fn(async () => []),
    parseOpenappaDeclarations: vi.fn(async () => ({
      include: [],
      serverAliases: [],
      credentials: [],
      routedAnnotators: [],
      runtimeCredentials: [],
      errors: [],
    })),
    composeOpenappaPolicy: vi.fn(async (input: { root: string }) => ({
      content: input.root,
      errors: [],
    })),
  };
}

async function persistNativeSessionStart(raw: string): Promise<void> {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (event.event !== "session_start") return;
  const sessionId =
    typeof event.session_id === "string" ? event.session_id : "";
  const organizationId =
    typeof event.organization_id === "string" ? event.organization_id : "";
  if (!sessionId || !organizationId) return;
  const parentId = typeof event.parent_id === "string" ? event.parent_id : null;
  const forkedFrom = typeof event.fork_of === "string" ? event.fork_of : null;
  if (parentId && forkedFrom) return;
  const root = parentId
    ? await parentRoot(organizationId, parentId)
    : openappaActor(sessionId);
  if (!root) return;
  await db
    .insert(sessions)
    .values({
      actor: openappaActor(sessionId),
      root,
      organizationId,
      callerId: typeof event.caller_id === "string" ? event.caller_id : null,
      sessionId,
      parentId,
      forkedFrom,
      startDecision: { decision: "ack" },
    })
    .onConflictDoNothing();
}

async function parentRoot(
  organizationId: string,
  parentId: string,
): Promise<string | null> {
  const [parent] = await db
    .select({ root: sessions.root })
    .from(sessions)
    .where(
      and(
        eq(sessions.organizationId, organizationId),
        eq(sessions.actor, openappaActor(parentId)),
      ),
    )
    .limit(1);
  return parent?.root ?? null;
}
