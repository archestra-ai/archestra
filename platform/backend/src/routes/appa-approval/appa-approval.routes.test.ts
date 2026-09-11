import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { AppaApprovalModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("OpenAPPA approval routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let agentId: string;
  let authMethod: "session" | "api_key" | "service_account";

  beforeEach(async ({ makeAdmin, makeAgent, makeMember, makeOrganization }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    authMethod = "session";
    user = await makeAdmin({ id: "synthetic-reviewer-text-id" });
    await makeMember(user.id, organizationId, { role: "admin" });
    const agent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });
    agentId = agent.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = user;
      request.authMethod = authMethod;
    });
    const { default: appaApprovalRoutes } = await import(
      "./appa-approval.routes"
    );
    await app.register(appaApprovalRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("shows the exact normalized call arguments without exposing correlation secrets", async () => {
    const approval = await createApproval({
      args: { destination: "ops", message: "deploy at midnight" },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/appa-approvals/${approval.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: approval.id,
      candidateCallId: approval.candidateCallId,
      tool: "deploy__release",
      args: { destination: "ops", message: "deploy at midnight" },
      argumentsSha256: approval.argumentsSha256,
      status: "pending",
    });
    expect(response.json()).not.toHaveProperty("sessionId");
    expect(response.json()).not.toHaveProperty("rootId");
    expect(response.json()).not.toHaveProperty("ownerScopeHash");
  });

  test("does not reveal a pending approval for an inaccessible profile", async ({
    makeAgent,
    makeUser,
  }) => {
    const author = await makeUser();
    const privateAgent = await makeAgent({
      organizationId,
      authorId: author.id,
      agentType: "agent",
      scope: "personal",
    });
    const approval = await createApproval({ profileId: privateAgent.id });

    user = await makeUser();
    const response = await app.inject({
      method: "GET",
      url: `/api/appa-approvals/${approval.id}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("does not reveal a row whose bound profile belongs to another organization", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const foreignOrganization = await makeOrganization();
    const foreignAuthor = await makeUser();
    const foreignAgent = await makeAgent({
      organizationId: foreignOrganization.id,
      authorId: foreignAuthor.id,
      agentType: "agent",
      scope: "org",
    });
    const approval = await createApproval({ profileId: foreignAgent.id });

    const response = await app.inject({
      method: "GET",
      url: `/api/appa-approvals/${approval.id}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("records one decision and a redacted audit row", async () => {
    const approval = await createApproval({
      args: { token: "review-only-secret" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/appa-approvals/${approval.id}/decision`,
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "approved",
      approverId: user.id,
    });
    const [audit] = await db
      .select({
        action: schema.auditLogsTable.action,
        actorId: schema.auditLogsTable.actorId,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.resourceId, approval.id),
          eq(schema.auditLogsTable.action, "appaApproval.decided"),
        ),
      );
    expect(audit).toMatchObject({
      action: "appaApproval.decided",
      actorId: user.id,
      before: {
        approvalId: approval.id,
        profileId: agentId,
        argumentsSha256: approval.argumentsSha256,
        status: "pending",
      },
      after: {
        approvalId: approval.id,
        profileId: agentId,
        argumentsSha256: approval.argumentsSha256,
        status: "approved",
        approverId: user.id,
      },
    });
    expect(JSON.stringify(audit)).not.toContain("review-only-secret");
  });

  test.each([
    ["API key", "api_key", "approve"],
    ["API key", "api_key", "deny"],
    ["service account", "service_account", "approve"],
    ["service account", "service_account", "deny"],
  ] as const)("rejects %s authority for %s decisions", async (_, method, decision) => {
    authMethod = method;
    const approval = await createApproval({});

    const response = await app.inject({
      method: "POST",
      url: `/api/appa-approvals/${approval.id}/decision`,
      payload: { decision },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        message: "Human approval decisions require an interactive user session",
      },
    });
    const [stored] = await db
      .select({ status: schema.appaApprovalsTable.status })
      .from(schema.appaApprovalsTable)
      .where(eq(schema.appaApprovalsTable.id, approval.id));
    expect(stored?.status).toBe("pending");
    const audits = await db
      .select({ id: schema.auditLogsTable.id })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, approval.id));
    expect(audits).toHaveLength(0);
  });

  test("rejects expired and stale-turn approvals without recording a decision", async () => {
    const expired = await createApproval({
      expiresAt: new Date(Date.now() - 1),
    });
    const stale = await createApproval({ activeTurnId: "turn-stale" });

    const [expiredResponse, staleResponse] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/appa-approvals/${expired.id}/decision`,
        payload: { decision: "approve" },
      }),
      app.inject({
        method: "POST",
        url: `/api/appa-approvals/${stale.id}/decision`,
        payload: { decision: "deny" },
      }),
    ]);

    expect(expiredResponse.statusCode).toBe(409);
    expect(staleResponse.statusCode).toBe(409);
    const [storedExpired] = await db
      .select({ status: schema.appaApprovalsTable.status })
      .from(schema.appaApprovalsTable)
      .where(eq(schema.appaApprovalsTable.id, expired.id));
    expect(storedExpired?.status).toBe("expired");
    const decisions = await db
      .select({ id: schema.auditLogsTable.id })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.action, "appaApproval.decided"));
    expect(decisions).toHaveLength(0);
  });

  test("rejects a decision when the candidate arguments no longer match its digest", async () => {
    const approval = await createApproval({});
    await db
      .update(schema.appaProxyCallsTable)
      .set({ appaTargetArguments: { target: "changed" } })
      .where(
        and(
          eq(schema.appaProxyCallsTable.sessionId, approval.sessionId),
          eq(schema.appaProxyCallsTable.callId, approval.candidateCallId),
        ),
      );

    const response = await app.inject({
      method: "POST",
      url: `/api/appa-approvals/${approval.id}/decision`,
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(409);
    const audits = await db
      .select({ id: schema.auditLogsTable.id })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.action, "appaApproval.decided"));
    expect(audits).toHaveLength(0);
  });

  test("allows exactly one concurrent decision to win", async () => {
    const approval = await createApproval({});

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/appa-approvals/${approval.id}/decision`,
        payload: { decision: "approve" },
      }),
      app.inject({
        method: "POST",
        url: `/api/appa-approvals/${approval.id}/decision`,
        payload: { decision: "deny" },
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const decisions = await db
      .select({ id: schema.auditLogsTable.id })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.action, "appaApproval.decided"));
    expect(decisions).toHaveLength(1);
  });

  test("cancels a pending approval when a bounded wait times out", async () => {
    const approval = await createApproval({});

    await expect(
      AppaApprovalModel.waitForDecision(approval.id, { timeoutMs: 1 }),
    ).resolves.toBeNull();
    const [stored] = await db
      .select({ status: schema.appaApprovalsTable.status })
      .from(schema.appaApprovalsTable)
      .where(eq(schema.appaApprovalsTable.id, approval.id));
    expect(stored?.status).toBe("cancelled");
  });

  test("returns a runtime grant only for the live approved candidate", async () => {
    const approval = await createApproval({ args: { target: "production" } });
    await db
      .update(schema.appaApprovalsTable)
      .set({ status: "approved", approverId: user.id, decidedAt: new Date() })
      .where(eq(schema.appaApprovalsTable.id, approval.id));

    const grant = await AppaApprovalModel.getForTurn({
      id: approval.id,
      sessionId: approval.sessionId,
      activeTurnId: approval.activeTurnId,
    });

    expect(grant).toMatchObject({
      id: approval.id,
      approverId: user.id,
      expiresAt: approval.expiresAt,
      offerId: approval.offerId,
      tool: "deploy__release",
      argumentsSha256: approval.argumentsSha256,
      args: { target: "production" },
    });
    await db
      .update(schema.appaApprovalsTable)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.appaApprovalsTable.id, approval.id));
    await expect(
      AppaApprovalModel.getForTurn({
        id: approval.id,
        sessionId: approval.sessionId,
        activeTurnId: approval.activeTurnId,
      }),
    ).resolves.toBeNull();
    await db
      .update(schema.appaApprovalsTable)
      .set({ expiresAt: new Date(Date.now() + 120_000) })
      .where(eq(schema.appaApprovalsTable.id, approval.id));
    await db
      .update(schema.appaProxySessionsTable)
      .set({ activeTurnId: "turn-replaced" })
      .where(eq(schema.appaProxySessionsTable.id, approval.sessionId));
    await expect(
      AppaApprovalModel.getForTurn({
        id: approval.id,
        sessionId: approval.sessionId,
        activeTurnId: approval.activeTurnId,
      }),
    ).resolves.toBeNull();
  });

  async function createApproval(params: {
    profileId?: string;
    activeTurnId?: string;
    expiresAt?: Date;
    args?: Record<string, unknown>;
  }) {
    const profileId = params.profileId ?? agentId;
    const activeTurnId = "turn-current";
    const candidateCallId = crypto.randomUUID();
    const rootId = `root-${crypto.randomUUID()}`;
    const args = params.args ?? { target: "production" };
    const argumentsSha256 = createHash("sha256")
      .update(canonicalJson(args))
      .digest("hex");
    const [session] = await db
      .insert(schema.appaProxySessionsTable)
      .values({
        profileId,
        ownerScopeHash: `scope-${crypto.randomUUID()}`,
        clientSessionId: `client-${crypto.randomUUID()}`,
        rootId,
        state: "in_turn",
        activeTurnId,
      })
      .returning();
    if (!session) throw new Error("missing APPA session");
    await db.insert(schema.appaProxyCallsTable).values({
      sessionId: session.id,
      callId: candidateCallId,
      emittedName: "deploy__release",
      emittedArguments: JSON.stringify(args),
      emittedArgumentsCanonical: canonicalJson(args),
      appaTargetName: "deploy__release",
      appaTargetArguments: args,
      state: "authorization_intent",
    });
    const [approval] = await db
      .insert(schema.appaApprovalsTable)
      .values({
        organizationId,
        sessionId: session.id,
        activeTurnId: params.activeTurnId ?? activeTurnId,
        candidateCallId,
        rootId,
        tool: "deploy__release",
        argumentsSha256,
        offerId: crypto.randomUUID(),
        expiresAt: params.expiresAt ?? new Date(Date.now() + 120_000),
      })
      .returning();
    if (!approval) throw new Error("missing APPA approval");
    return approval;
  }
});

function canonicalJson(value: Record<string, unknown>): string {
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`)
    .join(",")}}`;
}
