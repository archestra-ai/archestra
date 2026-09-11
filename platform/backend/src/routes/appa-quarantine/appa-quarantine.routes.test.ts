import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("OpenAPPA quarantine routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let agentId: string;

  beforeEach(async ({ makeAdmin, makeAgent, makeMember, makeOrganization }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin({ id: "synthetic-quarantine-reviewer-id" });
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
    });
    const { default: appaQuarantineRoutes } = await import(
      "./appa-quarantine.routes"
    );
    await app.register(appaQuarantineRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("lists only a safe quarantine projection", async () => {
    const quarantine = await createQuarantine({
      pendingRemoteEvent: "result delivery secret=never-expose",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/appa-quarantines",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: quarantine.id,
        profileId: agentId,
      }),
    ]);
    const body = JSON.stringify(response.json());
    expect(body).not.toContain("never-expose");
    expect(body).not.toContain("ownerScopeHash");
    expect(body).not.toContain("clientSessionId");
    expect(body).not.toContain("rootId");
    expect(body).not.toContain("pendingRemoteEvent");
  });

  test("returns bounded safe action summaries without call arguments or outcomes", async () => {
    const quarantine = await createQuarantine({});
    const admitted = await createQuarantineAction({
      sessionId: quarantine.id,
      tool: "billing__charge",
      state: "result_admitted",
      resultStatus: "success",
      secret: "charge-token-never-expose",
    });
    await createQuarantineAction({
      sessionId: quarantine.id,
      tool: "deployment__publish",
      state: "result_intent",
      resultStatus: "internal detail=never-expose",
      secret: "deployment-secret-never-expose",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/appa-quarantines/${quarantine.id}`,
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json();
    expect(responseBody).toMatchObject({ id: quarantine.id });
    expect(responseBody.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callRef: admitted.id,
          tool: "billing__charge",
          state: "result_admitted",
          outcome: "success",
        }),
        expect.objectContaining({
          tool: "deployment__publish",
          state: "result_intent",
          outcome: null,
        }),
      ]),
    );
    expect(responseBody.actions).toHaveLength(2);
    const body = JSON.stringify(responseBody);
    expect(body).not.toContain("charge-token-never-expose");
    expect(body).not.toContain("deployment-secret-never-expose");
    expect(body).not.toContain("internal detail=never-expose");
    expect(body).not.toContain("appaTargetArguments");
    expect(body).not.toContain("emittedArguments");
    expect(body).not.toContain("resultHash");
    expect(body).not.toContain("resultPresentation");
    expect(body).not.toContain("callId");
  });

  test("does not reveal quarantines for inaccessible or foreign profiles", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const privateAuthor = await makeUser();
    const privateAgent = await makeAgent({
      organizationId,
      authorId: privateAuthor.id,
      agentType: "agent",
      scope: "personal",
    });
    const inaccessible = await createQuarantine({ profileId: privateAgent.id });

    user = await makeUser();
    const inaccessibleResponse = await app.inject({
      method: "GET",
      url: `/api/appa-quarantines/${inaccessible.id}`,
    });

    expect(inaccessibleResponse.statusCode).toBe(404);

    const foreignOrganization = await makeOrganization();
    const foreignAuthor = await makeUser();
    const foreignAgent = await makeAgent({
      organizationId: foreignOrganization.id,
      authorId: foreignAuthor.id,
      agentType: "agent",
      scope: "org",
    });
    const foreign = await createQuarantine({ profileId: foreignAgent.id });
    const foreignResponse = await app.inject({
      method: "GET",
      url: `/api/appa-quarantines/${foreign.id}`,
    });

    expect(foreignResponse.statusCode).toBe(404);
  });

  test("records reconciliation without releasing quarantine", async () => {
    const quarantine = await createQuarantine({
      pendingRemoteEvent: "tool result credential=do-not-audit",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/appa-quarantines/${quarantine.id}/acknowledgment`,
      payload: { acknowledgment: "reconciled" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      quarantine: { id: quarantine.id, profileId: agentId },
      acknowledgment: "reconciled",
    });
    const [stored] = await db
      .select({ state: schema.appaProxySessionsTable.state })
      .from(schema.appaProxySessionsTable)
      .where(eq(schema.appaProxySessionsTable.id, quarantine.id));
    expect(stored?.state).toBe("quarantined");

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
          eq(schema.auditLogsTable.resourceId, quarantine.id),
          eq(schema.auditLogsTable.action, "appaQuarantine.reconciled"),
        ),
      );
    expect(audit).toMatchObject({
      action: "appaQuarantine.reconciled",
      actorId: user.id,
      before: {
        quarantineId: quarantine.id,
        profileId: agentId,
        state: "quarantined",
      },
      after: {
        quarantineId: quarantine.id,
        profileId: agentId,
        state: "quarantined",
        acknowledgment: "reconciled",
      },
    });
    expect(JSON.stringify(audit)).not.toContain("do-not-audit");
  });

  async function createQuarantine(params: {
    profileId?: string;
    pendingRemoteEvent?: string;
  }) {
    const [session] = await db
      .insert(schema.appaProxySessionsTable)
      .values({
        profileId: params.profileId ?? agentId,
        ownerScopeHash: `scope-${crypto.randomUUID()}`,
        clientSessionId: `client-${crypto.randomUUID()}`,
        rootId: `root-${crypto.randomUUID()}`,
        state: "quarantined",
        pendingRemoteEvent: params.pendingRemoteEvent ?? "remote event unknown",
      })
      .returning();
    if (!session) throw new Error("missing quarantined session");
    return session;
  }

  async function createQuarantineAction(params: {
    sessionId: string;
    tool: string;
    state:
      | "authorization_intent"
      | "open"
      | "result_intent"
      | "result_admitted"
      | "denied";
    resultStatus: string;
    secret: string;
  }) {
    const [call] = await db
      .insert(schema.appaProxyCallsTable)
      .values({
        sessionId: params.sessionId,
        callId: `client-call-${crypto.randomUUID()}`,
        emittedName: params.tool,
        emittedArguments: JSON.stringify({ credential: params.secret }),
        emittedArgumentsCanonical: JSON.stringify({
          credential: params.secret,
        }),
        appaTargetName: params.tool,
        appaTargetArguments: { credential: params.secret },
        state: params.state,
        resultHash: `hash-${params.secret}`,
        resultStatus: params.resultStatus,
        resultPresentation: params.secret,
      })
      .returning();
    if (!call) throw new Error("missing quarantined action");
    return call;
  }
});
