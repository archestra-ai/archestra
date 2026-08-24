import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("PATCH /api/llm-proxy", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);

    const { default: llmProxyRoutes } = await import("./llm-proxy.routes");
    await app.register(llmProxyRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("404 for an identity provider outside the organization", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/llm-proxy",
      payload: { identityProviderId: "idp-does-not-exist" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { message: "Identity provider not found" },
    });
  });

  test("clears the identity provider and writes an audit record", async () => {
    const proxy = await AgentModel.getOrgLlmProxy(organizationId);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/llm-proxy",
      payload: { identityProviderId: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: proxy.id,
      identityProviderId: null,
    });

    const rows = await db
      .select({
        action: schema.auditLogsTable.action,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "llmProxy.updated"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("llmProxy");
  });
});
