import { createHash, randomUUID } from "node:crypto";
import type { GuardrailsSettings } from "@archestra/openappa-rs";
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
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  captureGuardrailsDispatchSettings,
  getGuardrailsDeployment,
  guardrailsDispatchSettings,
  isGuardrailsV2Active,
  LINE_CHECK_ELSEWHERE,
  LINE_CHECK_INCOMPLETE,
  lineWarnings,
  withGuardrailsRequest,
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
          mode: enabled ? "enforce" : "off",
          personApproval: "ask",
          enforcedMarks: [],
          enabled,
          unsupportedClientAction: "bypass",
          breakTheGlassEnabled: true,
          humanApprovalMode: "block",
          unapprovableBlockMode: "refuse",
          environmentOverrides: [],
          annotatorModelId: null,
          annotatorLlmApiKeyId: null,
          featureEnabled,
          active: enabled && featureEnabled,
          warnings: [],
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
  });

  test("administrators can let approvals through with a yell, and the change is audited", async () => {
    await set(true);
    const response = await app.inject({
      method: "PUT",
      url: "/api/guardrails-deployment",
      payload: { humanApprovalMode: "everywhere" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      personApproval: "auto_everywhere",
      humanApprovalMode: "everywhere",
      unapprovableBlockMode: "refuse",
    });
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, organizationId));
      expect(rows).toContainEqual(
        expect.objectContaining({
          action: "organization.updated",
          before: expect.objectContaining({ humanApprovalMode: "block" }),
          after: expect.objectContaining({
            personApproval: "auto_everywhere",
            humanApprovalMode: "everywhere",
          }),
        }),
      );
    });
    const refused = await app.inject({
      method: "PUT",
      url: "/api/guardrails-deployment",
      payload: { humanApprovalMode: "always" },
    });
    expect(refused.statusCode).toBe(400);
  });

  test("an environment variable overrides the stored Break the glass setting, and the API refuses to change it", async () => {
    await set(true);
    await GuardrailsDeploymentModel.set({ humanApprovalMode: "everywhere" });
    const previous = config.openappa.breakTheGlassOverrides;
    config.openappa.breakTheGlassOverrides = { humanApprovalMode: "block" };
    try {
      const read = await app.inject({
        method: "GET",
        url: "/api/guardrails-deployment",
      });
      expect(read.json()).toMatchObject({
        humanApprovalMode: "block",
        unapprovableBlockMode: "refuse",
        environmentOverrides: [
          {
            setting: "humanApprovalMode",
            variable: "ARCHESTRA_OPENAPPA_HUMAN_APPROVAL_MODE",
          },
          {
            setting: "personApproval",
            variable: "ARCHESTRA_OPENAPPA_HUMAN_APPROVAL_MODE",
          },
        ],
      });
      const refused = await app.inject({
        method: "PUT",
        url: "/api/guardrails-deployment",
        payload: { humanApprovalMode: "unattended" },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.body).toContain("Unset it to edit this setting");
      // A setting no variable sets stays editable.
      const other = await app.inject({
        method: "PUT",
        url: "/api/guardrails-deployment",
        payload: { mode: "observe" },
      });
      expect(other.statusCode, other.body).toBe(200);
      expect(other.json()).toMatchObject({
        mode: "observe",
        humanApprovalMode: "block",
        unapprovableBlockMode: "allow",
      });
      expect(await GuardrailsDeploymentModel.get()).toMatchObject({
        humanApprovalMode: "everywhere",
        unapprovableBlockMode: "allow",
      });
    } finally {
      config.openappa.breakTheGlassOverrides = previous;
    }
    // Unset, the stored setting applies again.
    const stored = await app.inject({
      method: "GET",
      url: "/api/guardrails-deployment",
    });
    expect(stored.json()).toMatchObject({
      humanApprovalMode: "everywhere",
      environmentOverrides: [],
    });
  });

  test("with no mode saved, the settings derive from the legacy columns", async () => {
    await GuardrailsDeploymentModel.set({
      enabled: true,
      humanApprovalMode: "unattended",
      unapprovableBlockMode: "allow",
    });
    const read = await app.inject({
      method: "GET",
      url: "/api/guardrails-deployment",
    });
    expect(read.json()).toMatchObject({
      mode: "enforce",
      personApproval: "auto_unattended",
      enforcedMarks: [],
      enabled: true,
    });
  });

  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: "/api/guardrails-deployment", payload });
  const saved = async (payload: Record<string, unknown>) => {
    const response = await put(payload);
    expect(response.statusCode, response.body).toBe(200);
  };
  const stored = async () => {
    const row = await GuardrailsDeploymentModel.get();
    return {
      mode: row.mode,
      personApproval: row.personApproval,
      enforcedMarks: row.enforcedMarks,
      enabled: row.enabled,
      humanApprovalMode: row.humanApprovalMode,
      unapprovableBlockMode: row.unapprovableBlockMode,
    };
  };
  const read = async () =>
    (
      await app.inject({ method: "GET", url: "/api/guardrails-deployment" })
    ).json();

  test("a legacy switch-on from Off rebuilds the legacy columns from the saved settings", async () => {
    await saved({ mode: "observe", personApproval: "ask" });
    await saved({ mode: "off" });
    expect(await stored()).toEqual({
      mode: "off",
      personApproval: "ask",
      enforcedMarks: [],
      enabled: false,
      humanApprovalMode: "block",
      unapprovableBlockMode: "refuse",
    });
    await saved({ enabled: true });
    expect(await stored()).toEqual({
      mode: "enforce",
      personApproval: "ask",
      enforcedMarks: [],
      enabled: true,
      humanApprovalMode: "block",
      unapprovableBlockMode: "refuse",
    });
    expect(await read()).toMatchObject({
      mode: "enforce",
      personApproval: "ask",
      active: true,
    });
  });

  test("Ask a legacy row derives survives Observe and back to Enforce", async () => {
    await GuardrailsDeploymentModel.set({
      enabled: true,
      humanApprovalMode: "block",
    });
    await saved({ mode: "observe", enforcedMarks: ["payments"] });
    expect(await stored()).toEqual({
      mode: "observe",
      personApproval: "ask",
      enforcedMarks: ["payments"],
      enabled: true,
      humanApprovalMode: "everywhere",
      unapprovableBlockMode: "allow",
    });
    await saved({ mode: "enforce" });
    expect(await stored()).toEqual({
      mode: "enforce",
      personApproval: "ask",
      enforcedMarks: ["payments"],
      enabled: true,
      humanApprovalMode: "block",
      unapprovableBlockMode: "refuse",
    });
    // The legacy switch turns Observe off; turned back on, it is Enforce.
    await saved({ mode: "observe" });
    await saved({ enabled: false });
    expect(await stored()).toEqual({
      mode: "off",
      personApproval: "ask",
      enforcedMarks: ["payments"],
      enabled: false,
      humanApprovalMode: "block",
      unapprovableBlockMode: "refuse",
    });
    await saved({ enabled: true });
    expect(await stored()).toEqual({
      mode: "enforce",
      personApproval: "ask",
      enforcedMarks: ["payments"],
      enabled: true,
      humanApprovalMode: "block",
      unapprovableBlockMode: "refuse",
    });
  });

  test("person approval saved while Off is written to the legacy approval column", async () => {
    await saved({ mode: "enforce", personApproval: "auto_everywhere" });
    await saved({ mode: "off" });
    expect((await stored()).humanApprovalMode).toBe("everywhere");
    await saved({ personApproval: "ask" });
    expect(await stored()).toMatchObject({
      mode: "off",
      personApproval: "ask",
      enabled: false,
      humanApprovalMode: "block",
    });
  });

  test("concurrent saves leave the switch and the mode in step", async () => {
    await saved({ mode: "off" });
    const responses = await Promise.all([
      put({ personApproval: "ask" }),
      put({ mode: "enforce" }),
      put({ enabled: false }),
    ]);
    for (const response of responses)
      expect(response.statusCode, response.body).toBe(200);
    const row = await stored();
    expect(row.enabled).toBe(row.mode !== "off");
    expect(row.unapprovableBlockMode).toBe("refuse");
  });

  test("a switch an older replica writes alone is honoured on read", async () => {
    await saved({ mode: "observe" });
    await GuardrailsDeploymentModel.set({ enabled: false });
    expect(await read()).toMatchObject({ mode: "off", active: false });
    await GuardrailsDeploymentModel.set({ enabled: true });
    expect(await read()).toMatchObject({ mode: "observe", active: true });
    await saved({ mode: "off" });
    await GuardrailsDeploymentModel.set({ enabled: true });
    expect(await read()).toMatchObject({ mode: "enforce", active: true });
  });

  test("contradicting fields in one request are refused and change nothing", async () => {
    await saved({ mode: "enforce" });
    const before = await stored();
    for (const payload of [
      { enabled: false, mode: "enforce" },
      { enabled: true, mode: "off" },
      { humanApprovalMode: "block", personApproval: "auto_everywhere" },
      { unapprovableBlockMode: "allow" },
      { mode: "observe", unapprovableBlockMode: "refuse" },
    ])
      expect((await put(payload)).statusCode, JSON.stringify(payload)).toBe(
        400,
      );
    expect(await stored()).toEqual(before);
  });

  test("enforced marks are refused when duplicated or holding NUL", async () => {
    for (const enforcedMarks of [
      ["payments", "payments"],
      ["pay\u0000ments"],
      [""],
    ])
      expect((await put({ enforcedMarks })).statusCode).toBe(400);
    expect((await put({ mode: "audit" })).statusCode).toBe(400);
    expect((await stored()).enforcedMarks).toBeNull();
  });

  test("the variables win at read and pin their settings, while a save stores what was chosen", async () => {
    await saved({ mode: "observe", personApproval: "ask" });
    config.openappa.breakTheGlassOverrides = {
      humanApprovalMode: "block",
      unapprovableBlockMode: "refuse",
    };
    expect(await read()).toMatchObject({
      mode: "observe",
      personApproval: "ask",
      humanApprovalMode: "block",
      unapprovableBlockMode: "refuse",
      environmentOverrides: [
        {
          setting: "humanApprovalMode",
          variable: "ARCHESTRA_OPENAPPA_HUMAN_APPROVAL_MODE",
        },
        {
          setting: "personApproval",
          variable: "ARCHESTRA_OPENAPPA_HUMAN_APPROVAL_MODE",
        },
        {
          setting: "unapprovableBlockMode",
          variable: "ARCHESTRA_OPENAPPA_SOFT_BLOCK_MODE",
        },
      ],
    });
    for (const payload of [
      { personApproval: "auto_unattended" },
      { humanApprovalMode: "everywhere" },
      { unapprovableBlockMode: "allow" },
    ])
      expect((await put(payload)).statusCode, JSON.stringify(payload)).toBe(
        400,
      );
    // An unrelated save keeps Observe's columns, which differ from the pins.
    await saved({ unsupportedClientAction: "block" });
    expect(await stored()).toEqual({
      mode: "observe",
      personApproval: "ask",
      enforcedMarks: [],
      enabled: true,
      humanApprovalMode: "everywhere",
      unapprovableBlockMode: "allow",
    });
    // Enforce is written whole, so unsetting the pins surfaces Enforce/Ask.
    await saved({ mode: "enforce" });
    expect(await stored()).toEqual({
      mode: "enforce",
      personApproval: "ask",
      enforcedMarks: [],
      enabled: true,
      humanApprovalMode: "block",
      unapprovableBlockMode: "refuse",
    });
  });

  test("an older replica's stricter approval wins over the saved one, and a later save keeps it", async () => {
    await saved({ mode: "enforce", personApproval: "auto_everywhere" });
    await GuardrailsDeploymentModel.set({ humanApprovalMode: "block" });
    expect(await read()).toMatchObject({
      mode: "enforce",
      personApproval: "ask",
    });
    await saved({ unsupportedClientAction: "block" });
    expect(await stored()).toEqual({
      mode: "enforce",
      personApproval: "ask",
      enforcedMarks: [],
      enabled: true,
      humanApprovalMode: "block",
      unapprovableBlockMode: "refuse",
    });
    expect(await read()).toMatchObject({
      personApproval: "ask",
      humanApprovalMode: "block",
    });
  });

  test("the switch turns Guardrails back on in Enforce after an older replica turned them off", async () => {
    await saved({ mode: "observe", personApproval: "ask" });
    await GuardrailsDeploymentModel.set({ enabled: false });
    expect(await read()).toMatchObject({ mode: "off" });
    await saved({ enabled: true });
    expect(await read()).toMatchObject({ mode: "enforce", active: true });
  });

  test("an older replica's soft-block refusal under Observe reads as Enforce", async () => {
    await saved({ mode: "observe", personApproval: "auto_unattended" });
    await GuardrailsDeploymentModel.set({ unapprovableBlockMode: "refuse" });
    expect(await read()).toMatchObject({
      mode: "enforce",
      personApproval: "auto_unattended",
      active: true,
    });
  });

  test("under Observe the legacy approval only restates Observe's own value", async () => {
    await saved({ mode: "observe", personApproval: "ask" });
    expect((await put({ humanApprovalMode: "block" })).statusCode).toBe(400);
    await saved({ humanApprovalMode: "everywhere" });
    expect(await stored()).toEqual({
      mode: "observe",
      personApproval: "ask",
      enforcedMarks: [],
      enabled: true,
      humanApprovalMode: "everywhere",
      unapprovableBlockMode: "allow",
    });
  });

  test("a write that names the removed setting for new sessions is refused and changes nothing", async () => {
    await set(true);
    for (const payload of [
      { newSessionPolicy: "snapshot" },
      { enabled: false, newSessionPolicy: "live" },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/guardrails-deployment",
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(await GuardrailsDeploymentModel.get()).toMatchObject({
      enabled: true,
    });
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
      'Revision 1: unsupported policy: A full tool name has three parts: where the tool comes from, the server, and the tool, like "mcp/github/list_issues". "grain__*" is not a full name or the exact name of a tool. Use one of them.',
    );
    expect(await GuardrailsDeploymentModel.isEnabled()).toBe(false);
    // Turning it off is never refused.
    expect((await set(false)).statusCode).toBe(200);
  });

  test("a settings save warns when a line it routes sessions to can't carry its approvers", async () => {
    const capped = `[policy]\nversion = 2\n[policy.limits]\nplanner_cap = 1\n[[policy.tool]]\nname = "read"\ndelta = {}\nrequires = { attention = ["review"] }\n[[policy.authority]]\nname = "human-approval"\n[policy.authority.permits]\nattention = ["*"]\n[externals.authorities.human-approval]\nbuiltin = "hitl"\n`;
    await GuardrailsPolicyModel.saveDeclarationMigration({
      organizationId,
      content: capped,
      contentHash: createHash("sha256").update(capped).digest("hex"),
      expectedRevision: 0,
    });
    await openappaBatteriesService.recompile(organizationId);
    const save = async (payload: Record<string, unknown>) => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/guardrails-deployment",
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().warnings as string[];
    };

    expect(await save({ mode: "enforce", personApproval: "ask" })).toEqual([]);
    expect(await save({ personApproval: "auto_unattended" })).toHaveLength(1);
    expect(await save({ mode: "observe" })).toHaveLength(1);
    expect(
      await save({ unsupportedClientAction: "block" }),
      "a save that routes no session checks nothing",
    ).toEqual([]);
    expect(
      await save({ mode: "off", personApproval: "auto_unattended" }),
      "Off opens no family on a line with approvers",
    ).toEqual([]);
    const observe: GuardrailsSettings = {
      mode: "observe",
      personApproval: "ask",
      enforcedMarks: [],
    };
    expect(
      await lineWarnings(observe, { deadlineMs: 0 }),
      "a scan past its deadline answers that it is incomplete",
    ).toEqual([LINE_CHECK_INCOMPLETE]);
    expect(await lineWarnings(observe)).toHaveLength(1);
    expect(
      await lineWarnings(observe, { viewer: randomUUID() }),
      "another organization's reasons stay in the log",
    ).toEqual([LINE_CHECK_ELSEWHERE]);
    const uncapped = capped.replace("planner_cap = 1", "planner_cap = 8");
    await GuardrailsPolicyModel.saveDeclarationMigration({
      organizationId,
      content: uncapped,
      contentHash: createHash("sha256").update(uncapped).digest("hex"),
      expectedRevision: 1,
    });
    expect(
      await lineWarnings(observe),
      "a composition the saved root moved past is not checked as current",
    ).toContain(LINE_CHECK_INCOMPLETE);
    await openappaBatteriesService.recompile(organizationId);
    expect(await lineWarnings(observe)).toEqual([]);
    await save({ personApproval: "auto_everywhere" });
    expect(await guardrailsDispatchSettings()).toEqual({
      mode: "enforce",
      personApproval: "ask",
      enforcedMarks: [],
    });
  });

  test("a composition of a shipped root the release has since changed is not checked as current", async () => {
    await openappaBatteriesService.recompile(organizationId);
    const observe: GuardrailsSettings = {
      mode: "observe",
      personApproval: "ask",
      enforcedMarks: [],
    };
    expect(await lineWarnings(observe)).not.toContain(LINE_CHECK_INCOMPLETE);
    const [stored] = await db
      .select({
        fingerprint: schema.openappaEffectivePoliciesTable.installFingerprint,
      })
      .from(schema.openappaEffectivePoliciesTable)
      .where(
        eq(
          schema.openappaEffectivePoliciesTable.organizationId,
          organizationId,
        ),
      );
    await db
      .update(schema.openappaEffectivePoliciesTable)
      .set({
        installFingerprint: stored.fingerprint.replace(
          /:[0-9a-f]+$/,
          ":shipped-before",
        ),
      })
      .where(
        eq(
          schema.openappaEffectivePoliciesTable.organizationId,
          organizationId,
        ),
      );
    expect(await lineWarnings(observe)).toContain(LINE_CHECK_INCOMPLETE);
  });

  test("a request dispatches on the settings it captured, rereading only the enforced marks on a retry", async () => {
    await GuardrailsDeploymentModel.set({
      enabled: true,
      mode: "observe",
      humanApprovalMode: "everywhere",
      unapprovableBlockMode: "allow",
      personApproval: "auto_unattended",
      enforcedMarks: [],
    });
    await withGuardrailsRequest(async () => {
      captureGuardrailsDispatchSettings(await getGuardrailsDeployment());
      await GuardrailsDeploymentModel.set({
        mode: "enforce",
        personApproval: "ask",
        enforcedMarks: ["review"],
      });
      expect(await guardrailsDispatchSettings()).toEqual({
        mode: "observe",
        personApproval: "auto_unattended",
        enforcedMarks: [],
      });
      const retried = {
        mode: "observe",
        personApproval: "auto_unattended",
        enforcedMarks: ["review"],
      };
      expect(await guardrailsDispatchSettings({ freshMarks: true })).toEqual(
        retried,
      );
      expect(await guardrailsDispatchSettings()).toEqual(retried);
    });
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
          payload: { breakTheGlassEnabled: false },
        })
      ).statusCode,
    ).toBe(403);
    expect(await GuardrailsDeploymentModel.get()).toMatchObject({
      enabled: false,
      breakTheGlassEnabled: true,
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
    });
    expect((await set(true)).statusCode).toBe(403);
  });
});
