import { userHasPermission } from "@/auth";
import { OpenappaExternalConsultModel } from "@/models";
import type { ExternalConsultFilters } from "@/models/openappa-external-consult";
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
