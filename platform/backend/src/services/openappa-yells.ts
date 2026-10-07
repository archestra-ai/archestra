import type { CreatedBy } from "@archestra/shared";
import { SERVICE_ACCOUNT_USER_ID_PREFIX } from "@/auth/service-account-user-id";
import logger from "@/logging";
import CreatedByModel from "@/models/created-by";
import OpenAppaYellModel from "@/models/openappa-yell";
import ServiceAccountModel from "@/models/service-account";
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

async function present<T extends { id: string; callerId: string }>(
  rows: T[],
  viewer: { organizationId: string; userId: string },
) {
  const [withCaller, conversations] = await Promise.all([
    withCallers(rows, viewer.organizationId),
    OpenAppaYellModel.findConversations({
      ids: rows.map((row) => row.id),
      organizationId: viewer.organizationId,
      userId: viewer.userId,
    }),
  ]);
  const byYell = new Map(
    conversations.map(({ yellId, ...conversation }) => [yellId, conversation]),
  );
  return withCaller.map((row) => ({
    ...row,
    conversation: byYell.get(row.id) ?? null,
  }));
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
  const [users, accounts] = await Promise.all([
    CreatedByModel.resolve(
      ids.filter((id) => !id.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX)),
    ),
    ServiceAccountModel.getNamesByIds(
      ids
        .filter((id) => id.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX))
        .map((id) => id.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length)),
      organizationId,
    ),
  ]);
  return rows.map((row): T & { caller: CreatedBy | null } => {
    const id = principalId(row);
    if (!id) return { ...row, caller: null };
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
      };
    }
    return { ...row, caller: users.get(id) ?? null };
  });
}
