import { EDITOR_ROLE_NAME } from "@archestra/shared";
import { AuditLogModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import routes from "./log-events.routes";

describe("GET /api/logs/events", () => {
  test("each type follows its own permission, read for your own and none for the rest", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    makeInteraction,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({ organizationId: organization.id });
    const editor = await makeUser({ name: "Ada Lovelace" });
    await makeMember(editor.id, organization.id, { role: EDITOR_ROLE_NAME });
    const other = await makeUser({ name: "Grace Hopper" });
    await makeMember(other.id, organization.id);
    const mine = await makeInteraction(agent.id, { userId: editor.id });
    await makeInteraction(agent.id, { userId: other.id });
    const audit = await AuditLogModel.create({
      organizationId: organization.id,
      actorId: other.id,
      actorType: "user",
      actorName: "Grace Hopper",
      actorEmail: "grace@example.com",
      action: "agent.updated",
      outcome: "success",
      occurredAt: new Date(),
      resourceType: "agent",
      resourceId: agent.id,
      resourceName: agent.name,
      before: null,
      after: null,
      httpMethod: "PUT",
      httpPath: `/api/agents/${agent.id}`,
      httpRoute: "/api/agents/:id",
      httpStatus: 200,
      sourceIp: "127.0.0.1",
      userAgent: "test",
    });
    const auditor = await makeUser({ name: "Audit Only" });
    const auditRole = await makeCustomRole(organization.id, {
      permission: { auditLog: ["read", "admin"] },
    });
    await makeMember(auditor.id, organization.id, { role: auditRole.role });
    const nobody = await makeUser();
    const guardrailsRole = await makeCustomRole(organization.id, {
      permission: { guardrailsPolicy: ["read"] },
    });
    await makeMember(nobody.id, organization.id, { role: guardrailsRole.role });

    const app = await authenticatedRouteApp({
      organizationId: organization.id,
      routes: [routes],
    });
    const list = (userId: string) =>
      app.inject({
        method: "GET",
        url: "/api/logs/events?hours=1",
        headers: { [USER_HEADER]: userId },
      });
    try {
      // An editor holds log:read: their own LLM request, no one else's, and
      // no audit events.
      const asEditor = (await list(editor.id)).json();
      expect(
        asEditor.data
          .filter((e: { source: string }) => e.source === "llm")
          .map((e: { id: string }) => e.id),
      ).toEqual([mine.id]);
      expect(
        asEditor.data.some((e: { source: string }) => e.source === "audit"),
      ).toBe(false);

      // auditLog alone opens the feed with audit events only.
      const asAuditor = (await list(auditor.id)).json();
      expect(asAuditor.data.map((e: { id: string }) => e.id)).toEqual([
        audit.id,
      ]);
      expect(asAuditor.data[0]).toMatchObject({
        source: "audit",
        title: "Agent updated",
        actor: { kind: "user", name: "Grace Hopper" },
        href: `/audit/logs/${audit.id}`,
      });

      expect((await list(nobody.id)).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
