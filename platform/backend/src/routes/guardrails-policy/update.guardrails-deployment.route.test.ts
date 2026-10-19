import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import {
  breakTheGlassActiveIn,
  getGuardrailsDeployment,
  isGuardrailsV2Active,
} from "@/services/guardrails-deployment";
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
          breakTheGlassEnabled: true,
          newSessionPolicy: "live",
          annotatorModelId: null,
          annotatorLlmApiKeyId: null,
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

  test("administrators can turn break the glass off without changing enforcement", async () => {
    await set(true);
    const response = await app.inject({
      method: "PUT",
      url: "/api/guardrails-deployment",
      payload: { breakTheGlassEnabled: false },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      active: true,
      breakTheGlassEnabled: false,
    });
    expect(breakTheGlassActiveIn(await getGuardrailsDeployment())).toBe(false);
    await GuardrailsDeploymentModel.set({ breakTheGlassEnabled: true });
    expect(breakTheGlassActiveIn(await getGuardrailsDeployment())).toBe(true);
    await set(false);
    expect(breakTheGlassActiveIn(await getGuardrailsDeployment())).toBe(false);
  });

  test("administrators can give new sessions a policy snapshot without changing enforcement, and the change is audited", async () => {
    await set(true);
    const choose = (newSessionPolicy: string) =>
      app.inject({
        method: "PUT",
        url: "/api/guardrails-deployment",
        payload: { newSessionPolicy },
      });

    const snapshot = await choose("snapshot");
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json()).toMatchObject({
      enabled: true,
      active: true,
      newSessionPolicy: "snapshot",
    });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/guardrails-deployment" })
      ).json(),
    ).toMatchObject({ newSessionPolicy: "snapshot" });
    expect(await GuardrailsDeploymentModel.getNewSessionPolicy()).toBe(
      "snapshot",
    );
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, organizationId));
      expect(rows).toContainEqual(
        expect.objectContaining({
          action: "organization.updated",
          before: expect.objectContaining({ newSessionPolicy: "live" }),
          after: expect.objectContaining({ newSessionPolicy: "snapshot" }),
        }),
      );
    });

    // Turning enforcement off and on again keeps the setting.
    await set(false);
    expect((await set(true)).json()).toMatchObject({
      newSessionPolicy: "snapshot",
    });
    expect((await choose("live")).json()).toMatchObject({
      enabled: true,
      newSessionPolicy: "live",
    });
    expect((await choose("frozen")).statusCode).toBe(400);
    expect(await GuardrailsDeploymentModel.getNewSessionPolicy()).toBe("live");
  });

  test("administrators can pick the annotator model, only as a linked pair of the organization's own, and the change is audited", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const makeKeyWithModel = async (orgId: string, modelId: string) => {
      const secret = await makeSecret({ secret: { apiKey: "provider-key" } });
      const key = await makeLlmProviderApiKey(orgId, secret.id, {
        provider: "openrouter",
      });
      const model = await ModelModel.create({
        externalId: `openrouter/${modelId}`,
        provider: "openrouter",
        modelId,
        contextLength: 128_000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
        model.id,
      ]);
      return { keyId: key.id, modelId: model.id };
    };
    const pick = (
      annotatorModelId: string | null,
      annotatorLlmApiKeyId: string | null,
    ) =>
      app.inject({
        method: "PUT",
        url: "/api/guardrails-deployment",
        payload: { annotatorModelId, annotatorLlmApiKeyId },
      });
    const own = await makeKeyWithModel(
      organizationId,
      "anthropic/claude-sonnet-5",
    );
    const other = await makeKeyWithModel(organizationId, "openai/gpt-5");
    const foreign = await makeKeyWithModel(
      (await makeOrganization()).id,
      "openai/gpt-5-mini",
    );

    expect((await pick(own.modelId, null)).statusCode).toBe(400);
    expect((await pick(own.modelId, other.keyId)).statusCode).toBe(400);
    expect((await pick(foreign.modelId, foreign.keyId)).statusCode).toBe(404);
    expect(await GuardrailsDeploymentModel.get()).toMatchObject({
      annotatorModelId: null,
      annotatorLlmApiKeyId: null,
    });

    const saved = await pick(own.modelId, own.keyId);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      annotatorModelId: own.modelId,
      annotatorLlmApiKeyId: own.keyId,
    });
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, organizationId));
      expect(rows).toContainEqual(
        expect.objectContaining({
          action: "organization.updated",
          before: expect.objectContaining({ annotatorModelId: null }),
          after: expect.objectContaining({ annotatorModelId: own.modelId }),
        }),
      );
    });

    // Both null goes back to the organization's default model.
    expect((await pick(null, null)).json()).toMatchObject({
      annotatorModelId: null,
      annotatorLlmApiKeyId: null,
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
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/guardrails-deployment",
          payload: { newSessionPolicy: "snapshot" },
        })
      ).statusCode,
    ).toBe(403);
    expect(await GuardrailsDeploymentModel.get()).toMatchObject({
      enabled: false,
      newSessionPolicy: "live",
    });
  });

  test("members can read the status but not change it", async () => {
    await db
      .update(schema.membersTable)
      .set({ role: MEMBER_ROLE_NAME })
      .where(eq(schema.membersTable.userId, userId));
    const read = await app.inject({
      method: "GET",
      url: "/api/guardrails-deployment",
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      unsupportedClientAction: "bypass",
      newSessionPolicy: "live",
    });
    expect((await set(true)).statusCode).toBe(403);
  });
});
