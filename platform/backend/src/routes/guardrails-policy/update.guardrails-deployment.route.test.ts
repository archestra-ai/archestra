import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import routes from "./guardrails-deployment.routes";

describe("Deployment-wide Guardrails v2 switch", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let userId: string;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });
  const set = (enabled: boolean) =>
    app.inject({
      method: "PUT",
      url: "/api/guardrails-deployment",
      payload: { enabled },
    });

  test("defaults off and requires both the server flag and shared switch", async () => {
    expect(await isGuardrailsV2Active()).toBe(false);
    for (const featureEnabled of [false, true]) {
      config.openappa.enabled = featureEnabled;
      for (const enabled of [false, true]) {
        const response = await set(enabled);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          enabled,
          featureEnabled,
          active: enabled && featureEnabled,
        });
        expect(await isGuardrailsV2Active()).toBe(enabled && featureEnabled);
      }
    }
  });

  test("a setting saved in one organization applies to another and is audited", async ({
    makeOrganization,
  }) => {
    const originalOrg = organizationId;
    await set(true);
    organizationId = (await makeOrganization()).id;
    const response = await app.inject({
      method: "GET",
      url: "/api/guardrails-deployment",
    });
    expect(response.json()).toMatchObject({ enabled: true, active: true });
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, originalOrg));
      expect(rows).toContainEqual(
        expect.objectContaining({
          action: "organization.updated",
          before: expect.objectContaining({ enabled: false }),
          after: expect.objectContaining({ enabled: true }),
        }),
      );
    });
  });

  test("refuses writes without management permission", async () => {
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.userId, userId));
    expect((await set(true)).statusCode).toBe(403);
    expect(await GuardrailsDeploymentModel.isEnabled()).toBe(false);
  });
});
