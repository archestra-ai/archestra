import { userHasPermission } from "@/auth";
import { encodeCursor } from "@/database/utils/pagination";
import {
  externalConsultAccess,
  listExternalConsults,
} from "@/services/openappa-external-consults";
import { listOpenAppaYells } from "@/services/openappa-yells";
import { ApiError } from "@/types";
import type {
  ExternalConsult,
  ExternalConsultOutcome,
} from "@/types/openappa-external-consults";

type Yell = Awaited<ReturnType<typeof listOpenAppaYells>>["data"][number];

export type GuardrailEvent =
  | { type: "consult"; consult: ExternalConsult }
  | { type: "yell"; yell: Yell };

/**
 * One page of what Guardrails recorded for a viewer, newest first: its
 * consults of external services and the yells agents raised, in one timeline.
 * Each kind is read under its own permission: consults under `log:read` (the
 * viewer's own sessions without `log:admin`), yells under
 * `guardrailsYell:read` (the viewer's own without `guardrailsYell:admin`). A
 * kind the viewer may not read is left out; a viewer who may read neither is
 * refused. The two pages are merged on the position both lists share, the
 * creation time and then the id.
 */
export async function listGuardrailEvents(params: {
  organizationId: string;
  userId: string;
  query: {
    type: "all" | "consult" | "yell";
    search?: string;
    from?: Date;
    to?: Date;
    /** A consult's outcome: yells have none, so it leaves them out. */
    outcome?: ExternalConsultOutcome;
    /** Whether a yell is resolved: consults are neither, so it leaves them out. */
    yellStatus: "all" | "unresolved" | "resolved";
  };
  limit: number;
  cursor?: string;
}): Promise<{
  data: GuardrailEvent[];
  pagination: { limit: number; nextCursor: string | null; hasNext: boolean };
}> {
  const { organizationId, userId, query, limit, cursor } = params;
  const [canReadConsults, canReadYells] = await Promise.all([
    userHasPermission(userId, organizationId, "log", "read"),
    userHasPermission(userId, organizationId, "guardrailsYell", "read"),
  ]);
  if (!canReadConsults && !canReadYells) {
    throw new ApiError(
      403,
      "Reading the Guardrails log requires log:read or guardrailsYell:read",
    );
  }
  const wantConsults =
    canReadConsults && query.type !== "yell" && query.yellStatus === "all";
  const wantYells = canReadYells && query.type !== "consult" && !query.outcome;

  const [consults, yells] = await Promise.all([
    wantConsults
      ? listExternalConsults({
          organizationId,
          access: await externalConsultAccess({ userId, organizationId }),
          query: {
            search: query.search,
            from: query.from,
            to: query.to,
            outcome: query.outcome,
          },
          limit,
          cursor,
        })
      : null,
    wantYells
      ? listOpenAppaYells({
          organizationId,
          userId,
          search: query.search,
          status: query.yellStatus,
          from: query.from,
          to: query.to,
          limit,
          cursor,
        })
      : null,
  ]);

  // Each list holds its newest `limit` rows after the cursor, so the newest
  // `limit` of both together are among them.
  const merged = [
    ...(consults?.data ?? []).map(
      (consult): GuardrailEvent => ({ type: "consult", consult }),
    ),
    ...(yells?.data ?? []).map(
      (yell): GuardrailEvent => ({ type: "yell", yell }),
    ),
  ].sort((a, b) => {
    const [left, right] = [position(a), position(b)];
    return (
      right.time - left.time ||
      (right.id > left.id ? 1 : right.id < left.id ? -1 : 0)
    );
  });
  const data = merged.slice(0, limit);
  const hasNext =
    merged.length > limit ||
    consults?.pagination.hasNext === true ||
    yells?.pagination.hasNext === true;
  const last = data.at(-1);
  return {
    data,
    pagination: {
      limit,
      hasNext,
      nextCursor:
        hasNext && last
          ? encodeCursor({
              value: new Date(position(last).time).toISOString(),
              id: position(last).id,
            })
          : null,
    },
  };
}

function position(event: GuardrailEvent): { time: number; id: string } {
  const row = event.type === "consult" ? event.consult : event.yell;
  return { time: new Date(row.createdAt).getTime(), id: row.id };
}
