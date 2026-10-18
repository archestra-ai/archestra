import type { CreatedBy } from "@archestra/shared";
import { SERVICE_ACCOUNT_USER_ID_PREFIX } from "@/auth/service-account-user-id";
import logger from "@/logging";
import AppModel from "@/models/app";
import CreatedByModel from "@/models/created-by";
import InteractionModel from "@/models/interaction";
import McpToolCallModel from "@/models/mcp-tool-call";
import OpenAppaYellModel from "@/models/openappa-yell";
import ServiceAccountModel from "@/models/service-account";
import { withoutTrajectoryStamp } from "@/openappa/trajectory-stamp";
import { ApiError } from "@/types";
import type { OpenAppaYellQuery } from "@/types/openappa-yell";

export async function listOpenAppaYells(
  params: OpenAppaYellQuery & { organizationId: string; userId: string },
) {
  const result = await OpenAppaYellModel.list(params);
  return { ...result, data: await present(result.data, params) };
}

export async function resolveOpenAppaYell(params: {
  organizationId: string;
  userId: string;
  id: string;
  resolved: boolean;
}) {
  const row = await OpenAppaYellModel.setResolved(params);
  if (!row) throw new ApiError(404, "Yell not found");
  return (await present([row], params))[0];
}

export async function getOpenAppaYell(params: {
  organizationId: string;
  userId: string;
  id: string;
  /** The chat reading the yell. Becomes its investigation chat if it has none. */
  conversationId?: string;
}) {
  const row = await OpenAppaYellModel.find({
    organizationId: params.organizationId,
    id: params.id,
  });
  if (!row) throw new ApiError(404, "Yell not found");
  if (params.conversationId) {
    await OpenAppaYellModel.linkConversation({
      id: row.id,
      organizationId: params.organizationId,
      conversationId: params.conversationId,
    }).catch((error) =>
      logger.warn(
        { error, yellId: row.id, conversationId: params.conversationId },
        "Could not link the conversation to the OpenAPPA yell",
      ),
    );
  }
  return (await present([row], params))[0];
}

export async function downloadOpenAppaYell(params: {
  organizationId: string;
  userId: string;
  id: string;
}) {
  const archive = await OpenAppaYellModel.findArchive({
    organizationId: params.organizationId,
    id: params.id,
  });
  if (!archive)
    throw new ApiError(404, "Diagnostic archive not available for this yell");
  return archive;
}

async function present<
  T extends {
    id: string;
    callerId: string;
    sessionId: string;
    toolCallId: string;
    createdAt: Date;
  },
>(rows: T[], viewer: { organizationId: string; userId: string }) {
  const [withCaller, conversations, traces] = await Promise.all([
    withCallers(rows, viewer.organizationId),
    OpenAppaYellModel.findConversations({
      ids: rows.map((row) => row.id),
      organizationId: viewer.organizationId,
      userId: viewer.userId,
    }),
    traceLinks(rows, viewer.organizationId),
  ]);
  const byYell = new Map(
    conversations.map(({ yellId, ...conversation }) => [yellId, conversation]),
  );
  return withCaller.map((row) => ({
    ...row,
    conversation: byYell.get(row.id) ?? null,
    trace: traces.get(row.id) ?? null,
  }));
}

/**
 * Each yell's place in a session trace. The LLM session is the client's own
 * session id; the yell's call matches the logged call by the model's call id,
 * else the session's nearest logged `yell` call.
 */
async function traceLinks(
  rows: {
    id: string;
    sessionId: string;
    toolCallId: string;
    createdAt: Date;
  }[],
  organizationId: string,
): Promise<
  Map<string, { llmSessionId: string; mcpToolCallId: string | null }>
> {
  const llmSessionOf = (row: { sessionId: string }) =>
    row.sessionId.slice(row.sessionId.indexOf("|") + 1);
  const sessionIds = [...new Set(rows.map(llmSessionOf))].filter(Boolean);
  const [logged, calls] = await Promise.all([
    InteractionModel.findLoggedSessionIds({ organizationId, sessionIds }),
    McpToolCallModel.findYellCallsBySessions({ organizationId, sessionIds }),
  ]);
  const links = new Map<
    string,
    { llmSessionId: string; mcpToolCallId: string | null }
  >();
  for (const row of rows) {
    const llmSessionId = llmSessionOf(row);
    if (!logged.has(llmSessionId)) continue;
    const callId = withoutTrajectoryStamp(row.toolCallId);
    const inSession = calls.filter((call) => call.sessionId === llmSessionId);
    const call =
      inSession.find(
        (candidate) =>
          candidate.llmToolCallId !== null &&
          withoutTrajectoryStamp(candidate.llmToolCallId) === callId,
      ) ?? nearest(inSession, row.createdAt);
    links.set(row.id, { llmSessionId, mcpToolCallId: call?.id ?? null });
  }
  return links;
}

/** The call logged closest to `at`, within a minute of it. */
function nearest<T extends { createdAt: Date }>(calls: T[], at: Date) {
  let best: T | undefined;
  for (const call of calls) {
    const gap = Math.abs(call.createdAt.getTime() - at.getTime());
    if (gap > 60_000) continue;
    if (!best || gap < Math.abs(best.createdAt.getTime() - at.getTime()))
      best = call;
  }
  return best;
}

async function withCallers<T extends { callerId: string }>(
  rows: T[],
  organizationId: string,
) {
  const principalId = (row: T) =>
    row.callerId.startsWith("user:") ? row.callerId.slice(5) : null;
  const ids = [
    ...new Set(rows.map(principalId).filter((id): id is string => id !== null)),
  ];
  const appIds = [
    ...new Set(
      rows
        .filter((row) => row.callerId.startsWith("app:"))
        .map((row) => row.callerId.slice(4)),
    ),
  ];
  const [users, accounts, apps] = await Promise.all([
    CreatedByModel.resolve(
      ids.filter((id) => !id.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX)),
    ),
    ServiceAccountModel.getNamesByIds(
      ids
        .filter((id) => id.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX))
        .map((id) => id.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length)),
      organizationId,
    ),
    AppModel.getNamesByIds({ ids: appIds, organizationId }),
  ]);
  return rows.map(
    (
      row,
    ): T & {
      caller: CreatedBy | null;
      callerApp: { id: string; name: string } | null;
    } => {
      const appName = row.callerId.startsWith("app:")
        ? apps.get(row.callerId.slice(4))
        : undefined;
      const callerApp =
        appName === undefined
          ? null
          : { id: row.callerId.slice(4), name: appName };
      const id = principalId(row);
      if (!id) return { ...row, caller: null, callerApp };
      if (id.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX)) {
        const name = accounts.get(
          id.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length),
        );
        return {
          ...row,
          caller:
            name === undefined
              ? null
              : { id, name, email: null, type: "service_account" },
          callerApp,
        };
      }
      return { ...row, caller: users.get(id) ?? null, callerApp };
    },
  );
}
