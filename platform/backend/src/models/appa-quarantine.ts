import { and, desc, eq, inArray } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  AppaQuarantineAcknowledgment,
  AppaQuarantineAcknowledgmentResult,
  AppaQuarantineActionSummary,
  AppaQuarantineDetail,
  AppaQuarantineReview,
  AuditActorType,
} from "@/types";
import AgentTeamModel from "./agent-team";

/**
 * Operator-facing inspection of sessions whose remote outcome is uncertain.
 * This model intentionally has no state-transition methods: quarantine is
 * terminal until the operator investigates outside the proxy.
 */
class AppaQuarantineModel {
  static async list(params: {
    organizationId: string;
    userId: string;
    isAgentAdmin: boolean;
    limit: number;
  }): Promise<AppaQuarantineReview[]> {
    const profileIds =
      await AppaQuarantineModel.getAccessibleProfileIds(params);
    if (profileIds.length === 0) return [];

    const rows = await db
      .select(quarantineSelection)
      .from(schema.appaProxySessionsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentsTable.id, schema.appaProxySessionsTable.profileId),
      )
      .where(
        and(
          eq(schema.appaProxySessionsTable.state, "quarantined"),
          eq(schema.agentsTable.organizationId, params.organizationId),
          inArray(schema.appaProxySessionsTable.profileId, profileIds),
        ),
      )
      .orderBy(desc(schema.appaProxySessionsTable.updatedAt))
      .limit(params.limit);
    return rows.map(toReview);
  }

  static async get(params: {
    organizationId: string;
    userId: string;
    isAgentAdmin: boolean;
    id: string;
  }): Promise<AppaQuarantineDetail | null> {
    const profileIds =
      await AppaQuarantineModel.getAccessibleProfileIds(params);
    if (profileIds.length === 0) return null;

    const [row] = await db
      .select(quarantineSelection)
      .from(schema.appaProxySessionsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentsTable.id, schema.appaProxySessionsTable.profileId),
      )
      .where(
        and(
          eq(schema.appaProxySessionsTable.id, params.id),
          eq(schema.appaProxySessionsTable.state, "quarantined"),
          eq(schema.agentsTable.organizationId, params.organizationId),
          inArray(schema.appaProxySessionsTable.profileId, profileIds),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      ...toReview(row),
      actions: await AppaQuarantineModel.listActionSummaries(row.id),
    };
  }

  static async acknowledge(params: {
    organizationId: string;
    userId: string;
    isAgentAdmin: boolean;
    id: string;
    acknowledgment: AppaQuarantineAcknowledgment;
    audit: {
      actorName: string | null;
      actorEmail: string;
      actorType: AuditActorType;
      impersonatedBy: string | null;
      requestId: string;
      httpPath: string;
    };
  }): Promise<AppaQuarantineAcknowledgmentResult | null> {
    const profileIds =
      await AppaQuarantineModel.getAccessibleProfileIds(params);
    if (profileIds.length === 0) return null;

    return await withDbTransaction(async (tx) => {
      const [row] = await tx
        .select(quarantineSelection)
        .from(schema.appaProxySessionsTable)
        .innerJoin(
          schema.agentsTable,
          eq(schema.agentsTable.id, schema.appaProxySessionsTable.profileId),
        )
        .where(
          and(
            eq(schema.appaProxySessionsTable.id, params.id),
            eq(schema.appaProxySessionsTable.state, "quarantined"),
            eq(schema.agentsTable.organizationId, params.organizationId),
            inArray(schema.appaProxySessionsTable.profileId, profileIds),
          ),
        )
        .for("update");
      if (!row) return null;

      const acknowledgedAt = new Date();
      const action =
        params.acknowledgment === "acknowledged"
          ? "appaQuarantine.acknowledged"
          : "appaQuarantine.reconciled";
      const before = auditSnapshot(row);
      await tx.insert(schema.auditLogsTable).values({
        organizationId: params.organizationId,
        occurredAt: acknowledgedAt,
        actorId: params.userId,
        actorType: params.audit.actorType,
        actorName: params.audit.actorName,
        actorEmail: params.audit.actorEmail,
        impersonatedBy: params.audit.impersonatedBy,
        action,
        outcome: "success",
        resourceType: "appaQuarantine",
        resourceId: row.id,
        resourceName: "quarantined session",
        before,
        after: {
          ...before,
          acknowledgment: params.acknowledgment,
          acknowledgedAt: acknowledgedAt.toISOString(),
        },
        httpMethod: "POST",
        httpPath: params.audit.httpPath,
        httpRoute: "/api/appa-quarantines/:id/acknowledgment",
        httpStatus: 200,
        requestId: params.audit.requestId,
        sourceIp: null,
        userAgent: null,
      });

      // Do not alter the session. Its quarantined state is the safety boundary.
      return {
        quarantine: toReview(row),
        acknowledgment: params.acknowledgment,
        acknowledgedAt,
      };
    });
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

  private static async listActionSummaries(
    sessionId: string,
  ): Promise<AppaQuarantineActionSummary[]> {
    const rows = await db
      .select(actionSummarySelection)
      .from(schema.appaProxyCallsTable)
      .where(eq(schema.appaProxyCallsTable.sessionId, sessionId))
      .orderBy(desc(schema.appaProxyCallsTable.createdAt))
      .limit(100);
    return rows.map(toActionSummary);
  }
}

export default AppaQuarantineModel;

const quarantineSelection = {
  id: schema.appaProxySessionsTable.id,
  profileId: schema.appaProxySessionsTable.profileId,
  createdAt: schema.appaProxySessionsTable.createdAt,
  updatedAt: schema.appaProxySessionsTable.updatedAt,
};

const actionSummarySelection = {
  callRef: schema.appaProxyCallsTable.id,
  tool: schema.appaProxyCallsTable.appaTargetName,
  state: schema.appaProxyCallsTable.state,
  outcome: schema.appaProxyCallsTable.resultStatus,
  createdAt: schema.appaProxyCallsTable.createdAt,
  updatedAt: schema.appaProxyCallsTable.updatedAt,
};

function toReview(row: {
  id: string;
  profileId: string;
  createdAt: Date;
  updatedAt: Date;
}): AppaQuarantineReview {
  return row;
}

function auditSnapshot(row: {
  id: string;
  profileId: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    quarantineId: row.id,
    profileId: row.profileId,
    state: "quarantined",
    quarantinedAt: row.updatedAt.toISOString(),
  };
}

function toActionSummary(row: {
  callRef: string;
  tool: string;
  state: AppaQuarantineActionSummary["state"];
  outcome: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AppaQuarantineActionSummary {
  return {
    ...row,
    outcome:
      row.outcome === "success" ||
      row.outcome === "failure" ||
      row.outcome === "indeterminate"
        ? row.outcome
        : null,
  };
}
