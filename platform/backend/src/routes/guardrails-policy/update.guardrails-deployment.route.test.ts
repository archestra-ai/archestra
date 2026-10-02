import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
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
    registerRoutePermissions(app);
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
  const setUnsupportedClientAction = (unsupportedClientAction: string) =>
    app.inject({
      method: "PUT",
      url: "/api/guardrails-deployment",
      payload: { unsupportedClientAction },
    });

  test("defaults off and requires both the server flag and shared switch", async () => {
    expect(await isGuardrailsV2Active()).toBe(false);
    expect(
      (
        await app.inject({ method: "GET", url: "/api/guardrails-deployment" })
      ).json(),
    ).toMatchObject({ enabled: false, unsupportedClientAction: "bypass" });
    for (const featureEnabled of [false, true]) {
      config.openappa.enabled = featureEnabled;
      for (const enabled of [false, true]) {
        const response = await set(enabled);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
          enabled,
          unsupportedClientAction: "bypass",
          featureEnabled,
          active: enabled && featureEnabled,
        });
        expect(await isGuardrailsV2Active()).toBe(enabled && featureEnabled);
      }
    }
  });

  test("administrators can block unsupported clients without changing enforcement", async () => {
    await set(true);
    const response = await setUnsupportedClientAction("block");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      active: true,
      unsupportedClientAction: "block",
    });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/guardrails-deployment" })
      ).json(),
    ).toMatchObject({ unsupportedClientAction: "block" });
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, organizationId));
      expect(rows).toContainEqual(
        expect.objectContaining({
          action: "organization.updated",
          before: expect.objectContaining({
            unsupportedClientAction: "bypass",
          }),
          after: expect.objectContaining({ unsupportedClientAction: "block" }),
        }),
      );
    });
    expect((await setUnsupportedClientAction("bypass")).json()).toMatchObject({
      enabled: true,
      unsupportedClientAction: "bypass",
    });
  });

  test("rejects an unsupported action without changing the saved setting", async () => {
    expect((await setUnsupportedClientAction("allow-all")).statusCode).toBe(
      400,
    );
    expect(
      (await GuardrailsDeploymentModel.get()).unsupportedClientAction,
    ).toBe("bypass");
  });

  test("a setting saved in one organization applies to another and is audited", async ({
    makeOrganization,
    makeMember,
  }) => {
    const originalOrg = organizationId;
    await set(true);
    organizationId = (await makeOrganization()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
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

  test("stays off while a saved policy is one the runtime refuses to open", async () => {
    // A revision written before the save-time check opened the policy, or by
    // the unvalidated declaration migration, can still hold such a rule.
    const refused =
      '[policy]\nversion = 2\n[[policy.tool]]\nname = "grain__*"\ndelta = {}\n';
    await GuardrailsPolicyModel.saveDeclarationMigration({
      organizationId,
      content: refused,
      contentHash: createHash("sha256").update(refused).digest("hex"),
      expectedRevision: 0,
    });

    const response = await set(true);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain(
      'Revision 1: unsupported policy: tool "grain__*" has an invalid qualified identity',
    );
    expect(await GuardrailsDeploymentModel.isEnabled()).toBe(false);
    // Turning it off is never refused.
    expect((await set(false)).statusCode).toBe(200);
  });

  test("refuses writes without management permission", async () => {
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.userId, userId));
    expect((await set(true)).statusCode).toBe(403);
    expect((await setUnsupportedClientAction("block")).statusCode).toBe(403);
    expect(await GuardrailsDeploymentModel.isEnabled()).toBe(false);
  });
});
