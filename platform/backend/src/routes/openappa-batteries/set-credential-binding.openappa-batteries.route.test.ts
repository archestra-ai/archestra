import { ADMIN_ROLE_NAME, ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaCredentialBindingModel from "@/models/openappa-credential-binding";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import ToolModel from "@/models/tool";
import { openappaDeclarations } from "@/openappa/declarations";
import helperRoutes from "@/routes/openappa-helpers/openappa-helpers.routes";
import { OPENAPPA_HELPERS_PREFIX } from "@/routes/route-paths";
import { sandboxRuntimeService } from "@/sandbox-runtime/sandbox-runtime-service";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import type { User } from "@/types";
import routes from "./openappa-batteries.routes";

const GITHUB_TOKEN = "APPA_PROVIDER_GITHUB_TOKEN";
const TOKEN_VALUE = "ghp_bound_under_test";

describe("binding a battery credential", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let actor: User;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    actor = admin;
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: actor, organizationId });
    });
    registerAuditLogHook(app);
    registerRoutePermissions(app);
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  /** An organization credential with a value, which a binding may name. */
  const connectGithubToken = async () => {
    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: admin.id,
      definition: {
        key: "github-token",
        name: "GitHub token",
        kind: "secret",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "organization",
      userId: null,
      credentialId: "github-token",
      value: TOKEN_VALUE,
    });
  };

  const bind = (key: string | null, variable = GITHUB_TOKEN) =>
    app.inject({
      method: "PUT",
      url: `/api/openappa/credential-bindings/${variable}`,
      payload: { key },
    });

  const githubView = (body: {
    batteries: Array<{ name: string; [field: string]: unknown }>;
  }) => body.batteries.find((battery) => battery.name === "github");

  const includeGithub = async (
    makeInternalMcpCatalog: (params: {
      organizationId: string;
      name: string;
    }) => Promise<{ id: string }>,
    makeTool: (params: {
      catalogId: string;
      name: string;
      rawName: string;
    }) => Promise<unknown>,
  ) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub Prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github_prod__get_me",
      rawName: "get_me",
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "github", catalogId: catalog.id },
    });
    expect(created.statusCode, created.body).toBe(200);
    return created;
  };

  test("takes both policy update and credential update", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    await connectGithubToken();
    const policyOnly = await makeCustomRole(organizationId, {
      permission: { openappaPolicy: ["read", "update"] },
    });
    const policyAndCredential = await makeCustomRole(organizationId, {
      permission: {
        openappaPolicy: ["read", "update"],
        credential: ["update"],
      },
    });
    actor = await makeUser();
    await makeMember(actor.id, organizationId, { role: policyOnly.role });
    expect((await bind("github-token")).statusCode).toBe(403);
    expect(
      await OpenAppaCredentialBindingModel.find({
        organizationId,
        variable: GITHUB_TOKEN,
      }),
    ).toBeNull();

    actor = await makeUser();
    await makeMember(actor.id, organizationId, {
      role: policyAndCredential.role,
    });
    const bound = await bind("github-token");
    expect(bound.statusCode, bound.body).toBe(200);
  });

  test("a binding serves every reader without a policy revision, reaches the helper and moves the composed policy", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const created = await includeGithub(makeInternalMcpCatalog, makeTool);
    expect(created.json()).toMatchObject({ status: "missing_credentials" });
    await connectGithubToken();
    const root = await guardrailsPolicyService.get(organizationId);
    const unbound = await OpenAppaEffectivePolicyModel.find(organizationId);

    const bound = await bind("github-token");
    expect(bound.statusCode, bound.body).toBe(200);
    expect(githubView(bound.json())).toMatchObject({
      status: "active",
      credentials: [
        {
          variable: GITHUB_TOKEN,
          key: "github-token",
          source: "binding",
          readers: ["github"],
        },
      ],
    });
    // The stored text is the repository's; the binding lives beside it.
    expect(await guardrailsPolicyService.get(organizationId)).toMatchObject({
      revision: root.revision,
      content: root.content,
    });
    const composed = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(composed?.lastError).toBeNull();
    expect(composed?.installFingerprint).not.toBe(unbound?.installFingerprint);
    expect(composed?.content).toContain(`${GITHUB_TOKEN} = "github-token"`);

    // The helper of the derived row runs with the bound credential's value.
    const [row] = (
      await OpenAppaBatteryInstallModel.list(organizationId)
    ).filter((install) => install.batteryName === "github");
    vi.spyOn(sandboxRuntimeService, "attach").mockResolvedValue(undefined);
    const run = vi
      .spyOn(sandboxRuntimeService, "runCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({ version: 1, answer: {} }),
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      });
    const helpers = createFastifyInstance();
    await helpers.register(helperRoutes);
    try {
      const consulted = await helpers.inject({
        method: "POST",
        url: `${OPENAPPA_HELPERS_PREFIX}/${row.id}/github.repository-visibility`,
        headers: {
          authorization: `Bearer ${openappaDeclarations.bridgeToken}`,
        },
        remoteAddress: "127.0.0.1",
        payload: {
          version: 1,
          kind: "annotation",
          annotator: "github.repository-visibility",
          arguments: { owner: "example", repo: "widgets" },
        },
      });
      expect(consulted.statusCode, consulted.body).toBe(200);
    } finally {
      await helpers.close();
    }
    expect(run.mock.calls[0]?.[0]?.secretEnv).toEqual([
      { name: GITHUB_TOKEN, value: TOKEN_VALUE },
    ]);

    const [record] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.organizationId, organizationId),
          eq(schema.auditLogsTable.action, "openappaCredentialBinding.updated"),
        ),
      );
    expect(record).toMatchObject({
      resourceId: GITHUB_TOKEN,
      before: null,
      after: { variable: GITHUB_TOKEN, key: "github-token" },
    });

    const released = await bind(null);
    expect(released.statusCode, released.body).toBe(200);
    expect(githubView(released.json())).toMatchObject({
      status: "missing_credentials",
      credentials: [{ variable: GITHUB_TOKEN, key: null, source: null }],
    });
    expect(
      (await OpenAppaEffectivePolicyModel.find(organizationId))
        ?.installFingerprint,
    ).not.toBe(composed?.installFingerprint);
  });

  test("a battery not yet included under GitHub sync can bind its credential, and its inclusion picks the binding up", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    await connectGithubToken();
    await OpenAppaGithubSyncModel.save(organizationId, {
      repo: "example/policies",
      ref: "main",
      path: "appa.toml",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
    });
    const root = await guardrailsPolicyService.get(organizationId);

    const bound = await bind("github-token");
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json()).toMatchObject({
      managedInGithub: true,
      credentialBindings: [{ variable: GITHUB_TOKEN, key: "github-token" }],
    });
    expect(githubView(bound.json())).toBeUndefined();
    expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(
      root.revision,
    );

    // Once the text includes the battery, it is active from the stored binding.
    await OpenAppaGithubSyncModel.setInterval(organizationId, null);
    const created = await includeGithub(makeInternalMcpCatalog, makeTool);
    expect(created.json()).toMatchObject({
      status: "active",
      credentials: [
        { variable: GITHUB_TOKEN, key: "github-token", source: "binding" },
      ],
    });
  });

  test("a variable the policy text binds is the text's to change", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    await includeGithub(makeInternalMcpCatalog, makeTool);
    await connectGithubToken();
    const latest = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId: admin.id,
      content: `${latest.content}\n[credentials]\n${GITHUB_TOKEN} = "github-token"\n`,
      expectedRevision: latest.revision,
    });

    const refused = await bind("github-token");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain(
      "Remove its line there to manage it here",
    );
    expect(
      await OpenAppaCredentialBindingModel.find({
        organizationId,
        variable: GITHUB_TOKEN,
      }),
    ).toBeNull();
    const view = await app.inject({
      method: "GET",
      url: "/api/openappa/policy-declarations",
    });
    expect(githubView(view.json())).toMatchObject({
      credentials: [
        { variable: GITHUB_TOKEN, key: "github-token", source: "policy" },
      ],
    });
  });

  test("a key with no organization value and a variable outside the provider namespace are refused", async () => {
    expect((await bind("github-token")).statusCode).toBe(400);
    expect((await bind("github-token", "HOME")).statusCode).toBe(400);
    expect(await OpenAppaCredentialBindingModel.list(organizationId)).toEqual(
      [],
    );
  });
});
