import { vi } from "vitest";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { customYamlToDeployment } from "@/k8s/mcp-server-runtime/k8s-yaml-generator";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import SecretModel from "@/models/secret";
import ServiceAccountModel from "@/models/service-account";
import { secretManager } from "@/secrets-manager";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { InternalMcpCatalog, User } from "@/types";
import routes from "./internal-mcp-catalog";

const ordinaryConfig = { command: "node", arguments: ["server.js"] };
const staticYaml =
  "apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      serviceAccount: approved-runtime\n      containers:\n        - name: server\n          image: example/server:1\n";
const customYaml = `# Approved runtime configuration
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      serviceAccount: approved-runtime
      volumes:
        - name: custom-config
          configMap:
            name: approved-config
      containers:
        - name: server
          image: example/server:1
          env:
            - name: MODE
              value: pinned-mode
          volumeMounts:
            - name: custom-config
              mountPath: /etc/runtime
              readOnly: true
`;
const customYamlConfig = {
  ...ordinaryConfig,
  environment: [
    {
      key: "MODE",
      type: "plain_text" as const,
      promptOnInstallation: false,
      value: "catalog-mode",
      description: "Runtime mode",
    },
  ],
};
const userConfig = {
  mode: {
    type: "string" as const,
    title: "Mode",
    description: "Select a runtime mode",
    default: "standard",
    required: true,
    promptOnInstallation: true,
  },
};

describe("catalog runtime authoring permissions", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let admin: User;
  let organizationId: string;
  let catalog: InternalMcpCatalog;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      organizationId = (await makeOrganization()).id;
      user = await makeUser();
      admin = await makeUser();
      await makeMember(user.id, organizationId, { role: "member" });
      await makeMember(admin.id, organizationId, { role: "admin" });
      catalog = await makeInternalMcpCatalog({
        organizationId,
        authorId: user.id,
        access: "personal",
        serverType: "local",
        localConfig: ordinaryConfig,
      });
      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        request.user = user;
        request.organizationId = organizationId;
      });
      registerAuditLogHook(app);
      await app.register(routes);
    },
  );

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  function update(payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload,
    });
  }

  test("a scoped author can still change ordinary generated execution", async () => {
    const response = await update({
      localConfig: { ...ordinaryConfig, arguments: ["updated.js"] },
      description: "Updated generated runtime",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.arguments,
    ).toEqual(["updated.js"]);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: catalog.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({
            description: "Updated generated runtime",
          }),
        }),
      ]),
    );
  });

  test.each([
    { serviceAccount: "approved-runtime" },
    { envFrom: [{ type: "secret", name: "shared-runtime-values" }] },
    { envFrom: [{ type: "configMap", name: "shared-runtime-values" }] },
    { imagePullSecrets: [{ source: "existing", name: "private-registry" }] },
  ])("a scoped author cannot add privileged configuration %j", async (addition) => {
    const response = await update({
      localConfig: { ...ordinaryConfig, ...addition },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig,
    ).toEqual(ordinaryConfig);
  });

  test("unchanged privileged account does not authorize replacing executable code", async () => {
    const privileged = {
      ...ordinaryConfig,
      serviceAccount: "approved-runtime",
    };
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: privileged,
    });
    const response = await update({
      localConfig: { ...privileged, arguments: ["different.js"] },
    });
    expect(response.statusCode, response.body).toBe(403);
    const metadata = await update({
      description: "A clearer description",
      localConfig: privileged,
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig,
    ).toEqual(privileged);
  });

  test("a custom role needs a registry-wide grant to author privileged configuration", async ({
    makeCustomRole,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { mcpRegistry: ["read", "update"] },
    });
    await MemberModel.updateRole(user.id, organizationId, role.role);
    const payload = {
      localConfig: { ...ordinaryConfig, serviceAccount: "approved-runtime" },
    };
    expect((await update(payload)).statusCode).toBe(403);
    const key = {
      organizationId,
      resource: "mcpRegistry" as const,
      scope: "*" as const,
    };
    const current = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: current?.revision ?? 0,
      grants: [
        ...(current?.grants ?? []),
        { subject: { type: "role", id: role.id }, actions: ["update"] },
      ],
    });
    const allowed = await update(payload);
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  test("a service-account principal can use an explicit registry-wide authoring grant", async () => {
    const account = await ServiceAccountModel.create({
      organizationId,
      name: "Registry automation",
      role: "member",
      createdBy: admin.id,
    });
    const key = {
      organizationId,
      resource: "mcpRegistry" as const,
      scope: "*" as const,
    };
    const current = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: current?.revision ?? 0,
      grants: [
        ...(current?.grants ?? []),
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: ["update"],
        },
      ],
    });
    user = { ...user, id: `service-account:${account.id}` };
    const response = await update({
      localConfig: { ...ordinaryConfig, serviceAccount: "approved-runtime" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.serviceAccount,
    ).toBe("approved-runtime");
  });

  test("a registry administrator keeps custom accounts and static legacy YAML", async () => {
    user = admin;
    const response = await update({
      localConfig: { ...ordinaryConfig, serviceAccount: "approved-runtime" },
      deploymentSpecYaml: staticYaml,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.deploymentSpecYaml,
    ).toBe(staticYaml);
  });

  test.each([
    { actor: "scoped author", editDescription: false },
    { actor: "scoped author", editDescription: true },
    { actor: "registry administrator", editDescription: false },
    { actor: "registry administrator", editDescription: true },
  ])("$actor preserves approved YAML on a local config roundtrip (description edit: $editDescription)", async ({
    actor,
    editDescription,
  }) => {
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: customYamlConfig,
      deploymentSpecYaml: customYaml,
    });
    if (actor === "registry administrator") user = admin;
    const localConfig = {
      ...customYamlConfig,
      environment: customYamlConfig.environment.map((env) => ({
        ...env,
        description: editDescription
          ? "A clearer runtime mode"
          : env.description,
      })),
    };

    const response = await update({
      description: "Updated catalog description",
      localConfig,
    });

    expect(response.statusCode, response.body).toBe(200);
    const stored = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(stored?.description).toBe("Updated catalog description");
    expect(stored?.localConfig?.environment?.[0].description).toBe(
      localConfig.environment[0].description,
    );
    expect(stored?.deploymentSpecYaml).toBe(customYaml);
    const deployment = customYamlToDeployment(
      stored?.deploymentSpecYaml ?? "",
      {
        deploymentName: "catalog-roundtrip",
        serverId: catalog.id,
        serverName: catalog.name,
        labels: {},
        selectorLabels: {},
      },
    );
    expect(deployment?.spec?.template.spec?.containers[0]).toMatchObject({
      env: [{ name: "MODE", value: "pinned-mode" }],
      volumeMounts: [
        { name: "custom-config", mountPath: "/etc/runtime", readOnly: true },
      ],
    });
    expect(deployment?.spec?.template.spec?.volumes).toEqual([
      { name: "custom-config", configMap: { name: "approved-config" } },
    ]);
  });

  test("an actual local runtime change on approved YAML requires registry-wide access", async () => {
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: customYamlConfig,
      deploymentSpecYaml: customYaml,
    });
    const payload = {
      localConfig: {
        ...customYamlConfig,
        environment: customYamlConfig.environment.map((env) => ({
          ...env,
          value: "updated-mode",
        })),
      },
    };

    const denied = await update(payload);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.deploymentSpecYaml,
    ).toBe(customYaml);

    user = admin;
    const allowed = await update(payload);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.environment?.[0].value,
    ).toBe("updated-mode");
  });

  test("a scoped author can edit user config title and description while preserving approved YAML", async () => {
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: customYamlConfig,
      deploymentSpecYaml: customYaml,
      userConfig,
    });
    const metadataEdit = {
      mode: {
        ...userConfig.mode,
        title: "Runtime mode",
        description: "Choose the runtime mode for this installation",
      },
    };

    const response = await update({
      localConfig: customYamlConfig,
      userConfig: metadataEdit,
    });

    expect(response.statusCode, response.body).toBe(200);
    const stored = await InternalMcpCatalogModel.findById(catalog.id);
    expect(stored?.userConfig).toEqual(metadataEdit);
    expect(stored?.deploymentSpecYaml).toBe(customYaml);
  });

  test.each([
    { default: "different" },
    { required: false },
    { promptOnInstallation: false },
    { sensitive: true },
    { headerName: "X-Runtime-Mode" },
    { valuePrefix: "Mode " },
  ])("a user config behavioral change requires registry-wide access: %j", async (change) => {
    await InternalMcpCatalogModel.update(catalog.id, {
      deploymentSpecYaml: customYaml,
      userConfig,
    });
    const response = await update({
      userConfig: { mode: { ...userConfig.mode, ...change } },
    });
    expect(response.statusCode, response.body).toBe(403);
    const stored = await InternalMcpCatalogModel.findById(catalog.id);
    expect(stored?.userConfig).toEqual(userConfig);
    expect(stored?.deploymentSpecYaml).toBe(customYaml);
  });

  test("a scoped author can echo legacy inline static secrets without changing their stored representation", async () => {
    const legacyConfig = {
      ...ordinaryConfig,
      serviceAccount: "approved-runtime",
      environment: [
        {
          key: "TOKEN",
          type: "secret" as const,
          promptOnInstallation: false,
          value: "legacy-value",
        },
      ],
    };
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: legacyConfig,
    });
    const before = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    const secretCount = await SecretModel.count();

    const response = await update({
      description: "Legacy configuration description",
      localConfig: legacyConfig,
    });

    expect(response.statusCode, response.body).toBe(200);
    const stored = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(stored?.description).toBe("Legacy configuration description");
    expect(stored?.localConfig).toEqual(before?.localConfig);
    expect(stored?.localConfigSecretId).toBe(before?.localConfigSecretId);
    expect(await SecretModel.count()).toBe(secretCount);
  });

  test("a scoped author can echo a legacy inline OAuth secret without changing its stored representation", async () => {
    const oauthConfig = {
      name: "runtime-oauth",
      server_url: "https://example.com/mcp",
      client_id: "runtime-client",
      client_secret: "legacy-client-value",
      redirect_uris: [],
      scopes: [],
      default_scopes: [],
      supports_resource_metadata: false,
    };
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: { ...ordinaryConfig, serviceAccount: "approved-runtime" },
      oauthConfig,
    });
    const before = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    const secretCount = await SecretModel.count();

    const response = await update({
      description: "Legacy OAuth configuration description",
      oauthConfig,
    });

    expect(response.statusCode, response.body).toBe(200);
    const stored = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(stored?.description).toBe("Legacy OAuth configuration description");
    expect(stored?.oauthConfig).toEqual(before?.oauthConfig);
    expect(stored?.clientSecretId).toBe(before?.clientSecretId);
    expect(await SecretModel.count()).toBe(secretCount);
  });

  test("scoped authors cannot create or reset custom deployment YAML", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "custom-runtime",
        serverType: "local",
        localConfig: ordinaryConfig,
        deploymentSpecYaml: staticYaml,
      },
    });
    expect(create.statusCode, create.body).toBe(403);
    await InternalMcpCatalogModel.update(catalog.id, {
      deploymentSpecYaml: staticYaml,
    });
    const reset = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/reset-deployment-yaml`,
    });
    expect(reset.statusCode, reset.body).toBe(403);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.deploymentSpecYaml,
    ).toBe(staticYaml);
    user = admin;
    const approved = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/reset-deployment-yaml`,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.deploymentSpecYaml,
    ).toBeNull();
  });

  test("a denied privileged edit cannot rename the catalog or rotate its live bag", async () => {
    const bag = await secretManager().createSecret(
      { TOKEN: "original-value" },
      "runtime-values",
    );
    const privileged = {
      ...ordinaryConfig,
      serviceAccount: "approved-runtime",
      environment: [
        { key: "TOKEN", type: "secret" as const, promptOnInstallation: false },
      ],
    };
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: privileged,
      localConfigSecretId: bag.id,
    });
    const secretCount = await SecretModel.count();
    const response = await update({
      name: "changed-name",
      localConfig: {
        ...privileged,
        environment: [
          { ...privileged.environment[0], value: "replacement-value" },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect((await InternalMcpCatalogModel.findById(catalog.id))?.name).toBe(
      catalog.name,
    );
    expect((await SecretModel.findById(bag.id))?.secret).toEqual({
      TOKEN: "original-value",
    });
    expect(await SecretModel.count()).toBe(secretCount);
    const echo = await update({
      description: "Metadata only",
      localConfig: {
        ...privileged,
        environment: [
          { ...privileged.environment[0], value: "original-value" },
        ],
      },
    });
    expect(echo.statusCode, echo.body).toBe(200);
    expect(
      (
        await InternalMcpCatalogModel.findById(catalog.id, {
          expandSecrets: false,
        })
      )?.localConfigSecretId,
    ).toBe(bag.id);
    expect(await SecretModel.count()).toBe(secretCount);
  });

  test("a denied new static secret leaves no unpublished bag or catalog change", async () => {
    const privileged = {
      ...ordinaryConfig,
      serviceAccount: "approved-runtime",
    };
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: privileged,
    });
    const secretCount = await SecretModel.count();

    const response = await update({
      localConfig: {
        ...privileged,
        environment: [
          {
            key: "TOKEN",
            type: "secret",
            promptOnInstallation: false,
            value: "new-value",
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(403);
    const stored = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(stored?.localConfig).toEqual(privileged);
    expect(stored?.localConfigSecretId).toBeNull();
    expect(await SecretModel.count()).toBe(secretCount);
  });

  test("a PUT cannot restore an older secret bag when catalog state changes after its first read", async () => {
    const previous = await secretManager().createSecret(
      { TOKEN: "older-value" },
      "older-catalog-bag",
    );
    const replacement = await secretManager().createSecret(
      { TOKEN: "newer-value" },
      "newer-catalog-bag",
    );
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfigSecretId: previous.id,
      localConfig: {
        ...ordinaryConfig,
        environment: [
          { key: "TOKEN", type: "secret", promptOnInstallation: false },
        ],
      },
    });
    const reviewed = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    if (!reviewed) throw new Error("Missing catalog");
    const findById = InternalMcpCatalogModel.findById.bind(
      InternalMcpCatalogModel,
    );
    let interleaved = false;
    vi.spyOn(InternalMcpCatalogModel, "findById").mockImplementation(
      async (...args) => {
        const snapshot = await findById(...args);
        if (args[0] === catalog.id && !interleaved) {
          interleaved = true;
          await InternalMcpCatalogModel.publishReviewed({
            original: reviewed,
            updates: { localConfigSecretId: replacement.id },
          });
        }
        return snapshot;
      },
    );
    const response = await update({
      description: "An edit made against the older snapshot",
    });
    expect(interleaved).toBe(true);
    expect(response.statusCode, response.body).toBe(409);
    expect(
      (await findById(catalog.id, { expandSecrets: false }))
        ?.localConfigSecretId,
    ).toBe(replacement.id);
    expect((await SecretModel.findById(previous.id))?.secret).toEqual({
      TOKEN: "older-value",
    });
    expect((await SecretModel.findById(replacement.id))?.secret).toEqual({
      TOKEN: "newer-value",
    });
  });

  test("a concurrent privilege change prevents publishing staged editor secrets", async () => {
    const bag = await secretManager().createSecret(
      { TOKEN: "original-value" },
      "runtime-values",
    );
    const localConfig = {
      ...ordinaryConfig,
      environment: [
        { key: "TOKEN", type: "secret" as const, promptOnInstallation: false },
      ],
    };
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig,
      localConfigSecretId: bag.id,
    });
    const original = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    if (!original) throw new Error("Missing catalog");
    const createSecret = secretManager().createSecret.bind(secretManager());
    let stagedId: string | undefined;
    vi.spyOn(secretManager(), "createSecret").mockImplementationOnce(
      async (...args) => {
        const staged = await createSecret(...args);
        stagedId = staged.id;
        await InternalMcpCatalogModel.publishReviewed({
          original,
          updates: {
            localConfig: { ...localConfig, serviceAccount: "approved-runtime" },
          },
        });
        return staged;
      },
    );
    const response = await update({
      name: "stale-name",
      localConfig: {
        ...localConfig,
        environment: [
          { ...localConfig.environment[0], value: "replacement-value" },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    const stored = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(stored?.localConfig?.serviceAccount).toBe("approved-runtime");
    expect(stored?.name).toBe(catalog.name);
    expect(stored?.localConfigSecretId).toBe(bag.id);
    expect((await SecretModel.findById(bag.id))?.secret).toEqual({
      TOKEN: "original-value",
    });
    expect(stagedId).toBeDefined();
    if (!stagedId) throw new Error("Missing staged bag");
    expect(await SecretModel.findById(stagedId)).toBeNull();
  });
});
