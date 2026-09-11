import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  AppaApprovalForTurn,
  AppaApprovalReview,
  AuditActorType,
} from "@/types";
import AgentTeamModel from "./agent-team";

const DEFAULT_APPA_APPROVAL_EXPIRY_MS = 600_000; // 10 minutes default for human review

class AppaApprovalModel {
  static async create(params: {
    organizationId: string;
    sessionId: string;
    activeTurnId: string;
    candidateCallId: string;
    rootId: string;
    tool: string;
    argumentsSha256: string;
    offerId: string;
    expiresInMs?: number;
  }) {
    const [approval] = await db
      .insert(schema.appaProxyApprovalsTable)
      .values({
        organizationId: params.organizationId,
        sessionId: params.sessionId,
        activeTurnId: params.activeTurnId,
        candidateCallId: params.candidateCallId,
        rootId: params.rootId,
        tool: params.tool,
        argumentsSha256: params.argumentsSha256,
        offerId: params.offerId,
        expiresAt: new Date(
          Date.now() + (params.expiresInMs ?? DEFAULT_APPA_APPROVAL_EXPIRY_MS),
        ),
      })
      .returning();
    if (!approval) throw new Error("failed to create APPA approval");
    return approval;
  }

  static async list(params: {
    organizationId: string;
    userId: string;
    isAgentAdmin: boolean;
    limit: number;
  }): Promise<AppaApprovalReview[]> {
    const profileIds = await AppaApprovalModel.getAccessibleProfileIds(params);
    if (profileIds.length === 0) return [];

    const rows = await db
      .select(reviewSelection)
      .from(schema.appaProxyApprovalsTable)
      .innerJoin(
        schema.appaProxySessionsTable,
        eq(
          schema.appaProxySessionsTable.id,
          schema.appaProxyApprovalsTable.sessionId,
        ),
      )
      .innerJoin(
        schema.appaProxyCallsTable,
        and(
          eq(
            schema.appaProxyCallsTable.sessionId,
            schema.appaProxyApprovalsTable.sessionId,
          ),
          eq(
            schema.appaProxyCallsTable.callId,
            schema.appaProxyApprovalsTable.candidateCallId,
          ),
        ),
      )
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentsTable.id, schema.appaProxySessionsTable.profileId),
      )
      .where(
        and(
          eq(
            schema.appaProxyApprovalsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.agentsTable.organizationId, params.organizationId),
          inArray(schema.appaProxySessionsTable.profileId, profileIds),
        ),
      )
      .orderBy(desc(schema.appaProxyApprovalsTable.createdAt))
      .limit(params.limit);
    return rows.map(toReview);
  }

  static async get(params: {
    organizationId: string;
    userId: string;
    isAgentAdmin: boolean;
    id: string;
  }): Promise<AppaApprovalReview | null> {
    const profileIds = await AppaApprovalModel.getAccessibleProfileIds(params);
    if (profileIds.length === 0) return null;

    const [row] = await db
      .select(reviewSelection)
      .from(schema.appaProxyApprovalsTable)
      .innerJoin(
        schema.appaProxySessionsTable,
        eq(
          schema.appaProxySessionsTable.id,
          schema.appaProxyApprovalsTable.sessionId,
        ),
      )
      .innerJoin(
        schema.appaProxyCallsTable,
        and(
          eq(
            schema.appaProxyCallsTable.sessionId,
            schema.appaProxyApprovalsTable.sessionId,
          ),
          eq(
            schema.appaProxyCallsTable.callId,
            schema.appaProxyApprovalsTable.candidateCallId,
          ),
        ),
      )
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentsTable.id, schema.appaProxySessionsTable.profileId),
      )
      .where(
        and(
          eq(schema.appaProxyApprovalsTable.id, params.id),
          eq(
            schema.appaProxyApprovalsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.agentsTable.organizationId, params.organizationId),
          inArray(schema.appaProxySessionsTable.profileId, profileIds),
        ),
      )
      .limit(1);
    return row ? toReview(row) : null;
  }

  static async decide(params: {
    organizationId: string;
    id: string;
    userId: string;
    isAgentAdmin: boolean;
    approverId: string;
    decision: "approve" | "deny";
    audit: {
      actorName: string | null;
      actorEmail: string;
      actorType: AuditActorType;
      impersonatedBy: string | null;
      requestId: string;
      httpPath: string;
    };
  }): Promise<AppaApprovalReview | null> {
    const profileIds = await AppaApprovalModel.getAccessibleProfileIds(params);
    if (profileIds.length === 0) return null;

    return await withDbTransaction(async (tx) => {
      const [row] = await tx
        .select(reviewSelection)
        .from(schema.appaProxyApprovalsTable)
        .innerJoin(
          schema.appaProxySessionsTable,
          eq(
            schema.appaProxySessionsTable.id,
            schema.appaProxyApprovalsTable.sessionId,
          ),
        )
        .innerJoin(
          schema.appaProxyCallsTable,
          and(
            eq(
              schema.appaProxyCallsTable.sessionId,
              schema.appaProxyApprovalsTable.sessionId,
            ),
            eq(
              schema.appaProxyCallsTable.callId,
              schema.appaProxyApprovalsTable.candidateCallId,
            ),
          ),
        )
        .innerJoin(
          schema.agentsTable,
          eq(schema.agentsTable.id, schema.appaProxySessionsTable.profileId),
        )
        .where(
          and(
            eq(schema.appaProxyApprovalsTable.id, params.id),
            eq(
              schema.appaProxyApprovalsTable.organizationId,
              params.organizationId,
            ),
            eq(schema.agentsTable.organizationId, params.organizationId),
            inArray(schema.appaProxySessionsTable.profileId, profileIds),
          ),
        )
        .for("update");
      if (!row) return null;

      const now = new Date();
      if (
        row.status !== "pending" ||
        row.expiresAt <= now ||
        row.sessionState !== "in_turn" ||
        row.sessionActiveTurnId !== row.activeTurnId ||
        row.callState !== "authorization_intent" ||
        row.sessionRootId !== row.rootId ||
        row.callTool !== row.approvalTool ||
        sha256(canonicalJson(row.args)) !== row.argumentsSha256
      ) {
        if (row.status === "pending" && row.expiresAt <= now) {
          await tx
            .update(schema.appaProxyApprovalsTable)
            .set({ status: "expired" })
            .where(
              and(
                eq(schema.appaProxyApprovalsTable.id, row.id),
                eq(schema.appaProxyApprovalsTable.status, "pending"),
              ),
            );
        }
        return null;
      }

      const status = params.decision === "approve" ? "approved" : "denied";
      const [approval] = await tx
        .update(schema.appaProxyApprovalsTable)
        .set({ status, approverId: params.approverId, decidedAt: now })
        .where(
          and(
            eq(schema.appaProxyApprovalsTable.id, row.id),
            eq(schema.appaProxyApprovalsTable.status, "pending"),
          ),
        )
        .returning();
      if (!approval) return null;

      await tx.insert(schema.auditLogsTable).values({
        organizationId: params.organizationId,
        occurredAt: now,
        actorId: params.approverId,
        actorType: params.audit.actorType,
        actorName: params.audit.actorName,
        actorEmail: params.audit.actorEmail,
        impersonatedBy: params.audit.impersonatedBy,
        action: "appaApproval.decided",
        outcome: "success",
        resourceType: "appaApproval",
        resourceId: row.id,
        resourceName: row.callTool,
        before: auditSnapshot(row),
        after: auditSnapshot({
          ...row,
          status,
          approverId: params.approverId,
          decidedAt: now,
        }),
        httpMethod: "POST",
        httpPath: params.audit.httpPath,
        httpRoute: "/api/appa-approvals/:id/decision",
        httpStatus: 200,
        requestId: params.audit.requestId,
        sourceIp: null,
        userAgent: null,
      });
      return toReview({
        ...row,
        status,
        approverId: params.approverId,
        decidedAt: now,
      });
    });
  }

  /**
   * Runtime-only grant lookup. The live turn and candidate-call binding are
   * rechecked here so a previously approved row cannot authorize another turn.
   */
  static async getForTurn(params: {
    id: string;
    sessionId: string;
    activeTurnId: string;
    decision?: "approved" | "denied";
  }): Promise<AppaApprovalForTurn | null> {
    const [row] = await db
      .select({
        approval: {
          id: schema.appaProxyApprovalsTable.id,
          organizationId: schema.appaProxyApprovalsTable.organizationId,
          sessionId: schema.appaProxyApprovalsTable.sessionId,
          activeTurnId: schema.appaProxyApprovalsTable.activeTurnId,
          candidateCallId: schema.appaProxyApprovalsTable.candidateCallId,
          rootId: schema.appaProxyApprovalsTable.rootId,
          tool: schema.appaProxyApprovalsTable.tool,
          argumentsSha256: schema.appaProxyApprovalsTable.argumentsSha256,
          offerId: schema.appaProxyApprovalsTable.offerId,
          status: schema.appaProxyApprovalsTable.status,
          expiresAt: schema.appaProxyApprovalsTable.expiresAt,
          approverId: schema.appaProxyApprovalsTable.approverId,
          decidedAt: schema.appaProxyApprovalsTable.decidedAt,
          createdAt: schema.appaProxyApprovalsTable.createdAt,
        },
        args: schema.appaProxyCallsTable.appaTargetArguments,
        sessionState: schema.appaProxySessionsTable.state,
        sessionActiveTurnId: schema.appaProxySessionsTable.activeTurnId,
        sessionRootId: schema.appaProxySessionsTable.rootId,
        callTool: schema.appaProxyCallsTable.appaTargetName,
        callState: schema.appaProxyCallsTable.state,
      })
      .from(schema.appaProxyApprovalsTable)
      .innerJoin(
        schema.appaProxySessionsTable,
        eq(
          schema.appaProxySessionsTable.id,
          schema.appaProxyApprovalsTable.sessionId,
        ),
      )
      .innerJoin(
        schema.appaProxyCallsTable,
        and(
          eq(
            schema.appaProxyCallsTable.sessionId,
            schema.appaProxyApprovalsTable.sessionId,
          ),
          eq(
            schema.appaProxyCallsTable.callId,
            schema.appaProxyApprovalsTable.candidateCallId,
          ),
        ),
      )
      .where(
        and(
          eq(schema.appaProxyApprovalsTable.id, params.id),
          eq(schema.appaProxyApprovalsTable.sessionId, params.sessionId),
        ),
      )
      .limit(1);
    if (
      !row ||
      row.approval.status !== (params.decision ?? "approved") ||
      !row.approval.approverId ||
      !row.approval.decidedAt ||
      row.approval.expiresAt <= new Date() ||
      row.approval.activeTurnId !== params.activeTurnId ||
      row.sessionState !== "in_turn" ||
      row.sessionActiveTurnId !== params.activeTurnId ||
      row.sessionRootId !== row.approval.rootId ||
      row.callState !== "authorization_intent" ||
      row.callTool !== row.approval.tool ||
      sha256(canonicalJson(row.args)) !== row.approval.argumentsSha256
    ) {
      return null;
    }
    return { ...row.approval, args: row.args };
  }

  static async cancel(id: string) {
    await db
      .update(schema.appaProxyApprovalsTable)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(schema.appaProxyApprovalsTable.id, id),
          eq(schema.appaProxyApprovalsTable.status, "pending"),
        ),
      );
  }

  static async waitForDecision(
    id: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<"approved" | "denied" | null> {
    let deadline: number | null =
      options?.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;
    while (true) {
      if (options?.signal?.aborted) {
        await AppaApprovalModel.cancel(id);
        return null;
      }
      const [approval] = await db
        .select({
          status: schema.appaProxyApprovalsTable.status,
          expiresAt: schema.appaProxyApprovalsTable.expiresAt,
        })
        .from(schema.appaProxyApprovalsTable)
        .where(eq(schema.appaProxyApprovalsTable.id, id));
      if (approval?.status === "approved" || approval?.status === "denied")
        return approval.status;
      if (
        !approval ||
        approval.status === "cancelled" ||
        approval.status === "expired"
      )
        return null;

      const expiresAt = approval.expiresAt.getTime();
      deadline ??= expiresAt;
      const stopAt = Math.min(deadline, expiresAt);
      const remaining = stopAt - Date.now();
      if (remaining <= 0) {
        if (Date.now() >= expiresAt) await AppaApprovalModel.expire(id);
        else await AppaApprovalModel.cancel(id);
        return null;
      }
      const aborted = await waitForPoll(
        Math.min(250, remaining),
        options?.signal,
      );
      if (aborted) {
        await AppaApprovalModel.cancel(id);
        return null;
      }
    }
  }

  private static async expire(id: string) {
    await db
      .update(schema.appaProxyApprovalsTable)
      .set({ status: "expired" })
      .where(
        and(
          eq(schema.appaProxyApprovalsTable.id, id),
          eq(schema.appaProxyApprovalsTable.status, "pending"),
          lte(schema.appaProxyApprovalsTable.expiresAt, new Date()),
        ),
      );
  }

  private static async getAccessibleProfileIds(params: {
    userId: string;
    isAgentAdmin: boolean;
  }): Promise<string[]> {
    return AgentTeamModel.getUserAccessibleAgentIds(
      params.userId,
      params.isAgentAdmin,
    );
  }
}

export default AppaApprovalModel;

const reviewSelection = {
  id: schema.appaProxyApprovalsTable.id,
  candidateCallId: schema.appaProxyApprovalsTable.candidateCallId,
  approvalTool: schema.appaProxyApprovalsTable.tool,
  argumentsSha256: schema.appaProxyApprovalsTable.argumentsSha256,
  status: schema.appaProxyApprovalsTable.status,
  expiresAt: schema.appaProxyApprovalsTable.expiresAt,
  approverId: schema.appaProxyApprovalsTable.approverId,
  decidedAt: schema.appaProxyApprovalsTable.decidedAt,
  createdAt: schema.appaProxyApprovalsTable.createdAt,
  activeTurnId: schema.appaProxyApprovalsTable.activeTurnId,
  rootId: schema.appaProxyApprovalsTable.rootId,
  profileId: schema.appaProxySessionsTable.profileId,
  sessionState: schema.appaProxySessionsTable.state,
  sessionActiveTurnId: schema.appaProxySessionsTable.activeTurnId,
  sessionRootId: schema.appaProxySessionsTable.rootId,
  callTool: schema.appaProxyCallsTable.appaTargetName,
  args: schema.appaProxyCallsTable.appaTargetArguments,
  callState: schema.appaProxyCallsTable.state,
};

function toReview(row: {
  id: string;
  candidateCallId: string;
  callTool: string;
  args: Record<string, unknown>;
  argumentsSha256: string;
  status: AppaApprovalReview["status"];
  expiresAt: Date;
  approverId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}): AppaApprovalReview {
  return {
    id: row.id,
    candidateCallId: row.candidateCallId,
    tool: row.callTool,
    args: row.args,
    argumentsSha256: row.argumentsSha256,
    status:
      row.status === "pending" && row.expiresAt <= new Date()
        ? "expired"
        : row.status,
    expiresAt: row.expiresAt,
    approverId: row.approverId,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

function auditSnapshot(row: {
  id: string;
  profileId: string;
  candidateCallId: string;
  callTool: string;
  argumentsSha256: string;
  status: AppaApprovalReview["status"];
  approverId: string | null;
  decidedAt: Date | null;
}) {
  return {
    approvalId: row.id,
    profileId: row.profileId,
    candidateCallId: row.candidateCallId,
    tool: row.callTool,
    argumentsSha256: row.argumentsSha256,
    status: row.status,
    approverId: row.approverId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

function canonicalJson(value: Record<string, unknown>): string {
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return canonicalJson(value as Record<string, unknown>);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function waitForPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => done(false), ms);
    const onAbort = () => done(true);
    const done = (aborted: boolean) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(aborted);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
