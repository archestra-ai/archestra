import { userHasPermission } from "@/auth";
import {
  InteractionModel,
  McpToolCallModel,
  OpenAppaSessionModel,
  OpenappaExternalConsultModel,
} from "@/models";
import type { ExternalConsultFilters } from "@/models/openappa-external-consult";
import { clientSessionId } from "@/openappa/actor";
import { withoutTrajectoryStamp } from "@/openappa/trajectory-stamp";
import type { ExternalConsult } from "@/types/openappa-external-consults";

/** What one viewer may read of the organization's consults. */
type ExternalConsultAccess = {
  /** The one caller whose consults the viewer reads; absent with `openappaDiagnostics:admin`. */
  callerId: string | undefined;
  canSeeMembers: boolean;
};

type ExternalConsultQuery = Omit<ExternalConsultFilters, "callerId">;

export async function externalConsultAccess(params: {
  userId: string;
  organizationId: string;
}): Promise<ExternalConsultAccess> {
  const [canSeeAllLogs, canSeeMembers] = await Promise.all([
    userHasPermission(
      params.userId,
      params.organizationId,
      "openappaDiagnostics",
      "admin",
    ),
    userHasPermission(params.userId, params.organizationId, "member", "read"),
  ]);
  return {
    callerId: canSeeAllLogs ? undefined : `user:${params.userId}`,
    canSeeMembers,
  };
}

/** One page of the consults a viewer may read, newest first. */
export async function listExternalConsults(params: {
  organizationId: string;
  access: ExternalConsultAccess;
  query: ExternalConsultQuery;
  limit: number;
  cursor?: string;
}) {
  const page = await OpenappaExternalConsultModel.findCursorPaginated({
    organizationId: params.organizationId,
    filters: { ...params.query, callerId: params.access.callerId },
    limit: params.limit,
    cursor: params.cursor,
  });
  return {
    data: page.data.map((row) => visibleTo(row, params.access)),
    pagination: page.pagination,
  };
}

/**
 * One consult a viewer may read, with where it happened: the LLM session it
 * belongs to and the tool call it was raised for, when those are logged.
 * The session is the client session that opened the consult's root, so a
 * sub-agent's consult leads to the session its parent ran in.
 */
export async function findExternalConsult(params: {
  organizationId: string;
  access: ExternalConsultAccess;
  id: string;
}): Promise<{
  consult: ExternalConsult;
  llmSessionId: string | null;
  mcpToolCallId: string | null;
} | null> {
  const { organizationId } = params;
  const row = await OpenappaExternalConsultModel.findById({
    organizationId,
    id: params.id,
    callerId: params.access.callerId,
  });
  if (!row) return null;

  const candidate =
    (await OpenAppaSessionModel.rootClientSessionId({
      organizationId,
      root: row.root,
    })) ?? (row.sessionId ? clientSessionId(row.sessionId) : null);
  const llmSessionId =
    candidate &&
    (await InteractionModel.existsBySessionId({
      organizationId,
      sessionId: candidate,
    }))
      ? candidate
      : null;

  // Tool calls log the model's call id, sometimes with a trajectory stamp;
  // the consult keeps the runtime's operation id, `call:<id>`.
  const callId = row.callId?.replace(/^call:/, "") ?? null;
  let mcpToolCallId: string | null = null;
  if (llmSessionId && callId) {
    const calls = await McpToolCallModel.findModelCallIdsBySession({
      organizationId,
      sessionId: llmSessionId,
    });
    mcpToolCallId =
      calls.find(
        (call) => withoutTrajectoryStamp(call.llmToolCallId) === callId,
      )?.id ?? null;
  }

  return {
    consult: visibleTo(row, params.access),
    llmSessionId,
    mcpToolCallId,
  };
}

/** Up to `max` of the consults a viewer may read, in the same order. */
export async function* exportExternalConsults(params: {
  organizationId: string;
  access: ExternalConsultAccess;
  query: ExternalConsultQuery;
  max: number;
  cursor?: string;
}): AsyncGenerator<ExternalConsult> {
  const rows = OpenappaExternalConsultModel.exportRows({
    organizationId: params.organizationId,
    filters: { ...params.query, callerId: params.access.callerId },
    max: params.max,
    cursor: params.cursor,
  });
  for await (const row of rows) yield visibleTo(row, params.access);
}

// === Internal ===

/**
 * An audience source's consult names people, so its contents are withheld
 * from a viewer who cannot read members.
 */
function visibleTo(
  row: ExternalConsult,
  access: ExternalConsultAccess,
): ExternalConsult {
  if (row.role !== "audience_source" || access.canSeeMembers) return row;
  return {
    ...row,
    request: null,
    answer: null,
    rawResponse: null,
    diagnostics: null,
  };
}
