import { RouteId } from "@archestra/shared";
import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { InternalMcpCatalogModel, ServiceAccountModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { betterAuth, hasPermission } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin/plugin";
import { hasPermission as checkPermissions } from "@/auth/utils";

const mockHasPermission = hasPermission as Mock;

const DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom
spec:
  template:
    spec:
      containers:
        - name: mcp-server
          image: example.invalid/mcp-server:1.0
`;

/**
 * The custom deployment YAML of a self-hosted MCP server is gated by
 * `mcpAdvancedSettings:update` on top of the registry permissions. Roles are
 * resolved from the database, so these exercise the real predefined and
 * custom role grants.
 */
describe("internal MCP catalog deployment YAML permission", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let editor: User;
  let currentUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    // Stub session identity only; exercise the real middleware, DB role
    // composition, endpoint map and field-level checks.
    mockHasPermission.mockImplementation(checkPermissions);
    vi.mocked(betterAuth.api.getSession).mockImplementation(
      async () =>
        ({
          response: {
            user: currentUser,
            session: { activeOrganizationId: organizationId },
          },
          headers: new Headers(),
        }) as never,
    );

    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: "admin" });
    editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: "editor" });
    currentUser = admin;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.headers.cookie = "test-session";
    });
    await app.register(authPlugin);
    registerAuditLogHook(app);
    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("an editor cannot create a server with custom deployment YAML", async () => {
    currentUser = editor;

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "Editor Custom Yaml",
        serverType: "local",
        localConfig: { command: "node", arguments: ["server.js"] },
        deploymentSpecYaml: DEPLOYMENT_YAML,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "mcpAdvancedSettings:update",
    );
    expect(
      await InternalMcpCatalogModel.findRootByNameInOrg({
        name: "Editor Custom Yaml",
        organizationId,
      }),
    ).toBeFalsy();
  });

  test("an editor can still create a server without custom deployment YAML", async () => {
    currentUser = editor;

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "Editor Default Yaml",
        serverType: "local",
        localConfig: { command: "node", arguments: ["server.js"] },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  test("an editor cannot change stored YAML, and the rejected update writes nothing", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Stored Yaml",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
      deploymentSpecYaml: DEPLOYMENT_YAML,
      authorId: editor.id,
    });
    currentUser = editor;

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: "Renamed Stored Yaml",
        deploymentSpecYaml: DEPLOYMENT_YAML.replace("custom", "changed"),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "mcpAdvancedSettings:update",
    );
    const persisted = await InternalMcpCatalogModel.findById(catalog.id);
    expect(persisted?.name).toBe("Stored Yaml");
    expect(persisted?.deploymentSpecYaml).toBe(DEPLOYMENT_YAML);
  });

  test("a disallowed runtime service account cannot persist a catalog rename", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Unchanged Runtime Identity",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
      authorId: admin.id,
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: "Rejected Runtime Rename",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          serviceAccount: "unapproved-runtime-identity",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("not allowed");
    const persisted = await InternalMcpCatalogModel.findById(catalog.id);
    expect(persisted?.name).toBe("Unchanged Runtime Identity");
    expect(persisted?.localConfig?.serviceAccount).toBeUndefined();
  });

  test("an editor cannot clear stored YAML", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
      deploymentSpecYaml: DEPLOYMENT_YAML,
      authorId: editor.id,
    });
    currentUser = editor;

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { deploymentSpecYaml: null },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "mcpAdvancedSettings:update",
    );
    const persisted = await InternalMcpCatalogModel.findById(catalog.id);
    expect(persisted?.deploymentSpecYaml).toBeTruthy();
  });

  test("an editor can edit other fields of a server whose YAML they cannot change", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
      deploymentSpecYaml: DEPLOYMENT_YAML,
      authorId: editor.id,
    });
    currentUser = editor;

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        description: "Edited by an editor",
        // An unchanged value echoed back is not a change.
        deploymentSpecYaml: DEPLOYMENT_YAML,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const persisted = await InternalMcpCatalogModel.findById(catalog.id);
    expect(persisted?.description).toBe("Edited by an editor");
    expect(persisted?.deploymentSpecYaml).toBe(DEPLOYMENT_YAML);
  });

  test("an admin can set custom deployment YAML", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { deploymentSpecYaml: DEPLOYMENT_YAML },
    });

    expect(response.statusCode, response.body).toBe(200);
    const persisted = await InternalMcpCatalogModel.findById(catalog.id);
    expect(persisted?.deploymentSpecYaml).toBe(DEPLOYMENT_YAML);
  });

  test.for([
    { label: "without", advancedActions: [] as string[], expectedStatus: 403 },
    { label: "with", advancedActions: ["read", "update"], expectedStatus: 200 },
  ])("a custom role $label mcpAdvancedSettings:update gets $expectedStatus", async ({
    advancedActions,
    expectedStatus,
  }, { makeCustomRole, makeInternalMcpCatalog, makeMember, makeUser }) => {
    const role = await makeCustomRole(organizationId, {
      permission: {
        mcpRegistry: ["read", "create", "update", "delete"],
        ...(advancedActions.length > 0
          ? { mcpAdvancedSettings: advancedActions }
          : {}),
      },
    });
    const customUser = await makeUser();
    await makeMember(customUser.id, organizationId, { role: role.role });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
      authorId: customUser.id,
    });
    currentUser = customUser;

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { deploymentSpecYaml: DEPLOYMENT_YAML },
    });

    expect(response.statusCode).toBe(expectedStatus);
    const persisted = await InternalMcpCatalogModel.findById(catalog.id);
    expect(persisted?.deploymentSpecYaml ?? null).toBe(
      expectedStatus === 200 ? DEPLOYMENT_YAML : null,
    );
  });
  test.for([
    { role: "admin", read: true, update: true },
    { role: "platform_admin", read: true, update: true },
    { role: "editor", read: false, update: false },
    { role: "member", read: false, update: false },
    { role: "custom-read", read: true, update: false },
    { role: "custom-update", read: false, update: true },
  ])("$role has the expected YAML endpoint access", async ({
    role,
    read,
    update,
  }, { makeUser, makeMember, makeCustomRole, makeInternalMcpCatalog }) => {
    const user = await makeUser();
    const roleName = role.startsWith("custom-")
      ? (
          await makeCustomRole(organizationId, {
            permission: {
              mcpRegistry: ["read", "create", "update"],
              mcpAdvancedSettings: [read ? "read" : "update"],
            },
          })
        ).role
      : role;
    await makeMember(user.id, organizationId, { role: roleName });
    currentUser = user;
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
      deploymentSpecYaml: DEPLOYMENT_YAML,
    });
    const get = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
    });
    expect(get.statusCode, get.body).toBe(200);
    expect(get.json().deploymentSpecYaml).toBe(read ? DEPLOYMENT_YAML : null);
    const list = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog",
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json().find((item: { id: string }) => item.id === catalog.id)
        .deploymentSpecYaml,
    ).toBe(read ? DEPLOYMENT_YAML : null);
    const preview = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${catalog.id}/deployment-yaml-preview`,
    });
    expect(preview.statusCode).toBe(read ? 200 : 403);
    const validate = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog/validate-deployment-yaml",
      payload: { yaml: DEPLOYMENT_YAML },
    });
    expect(validate.statusCode).toBe(read ? 200 : 403);
    const reset = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/reset-deployment-yaml`,
    });
    expect(reset.statusCode).toBe(read && update ? 200 : 403);
  });

  test("an editor cannot add, replace or remove Kubernetes Secret references", async ({
    makeInternalMcpCatalog,
  }) => {
    const original = [
      { type: "secret" as const, name: "trusted-runtime", prefix: "" },
    ];
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: editor.id,
      serverType: "local",
      localConfig: { command: "node", arguments: [], envFrom: original },
    });
    currentUser = editor;
    for (const envFrom of [
      [],
      [{ type: "secret", name: "platform-secret", prefix: "" }],
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${catalog.id}`,
        payload: { localConfig: { command: "node", arguments: [], envFrom } },
      });
      expect(response.statusCode).toBe(403);
      expect(
        (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
          ?.envFrom,
      ).toEqual(original);
    }
    const unchanged = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        description: "ordinary edit",
        localConfig: { command: "node", arguments: [], envFrom: original },
      },
    });
    expect(unchanged.statusCode).toBe(200);
  });
  test("combining editor and a custom advanced role grants both capabilities", async ({
    makeUser,
    makeMember,
    makeCustomRole,
    makeInternalMcpCatalog,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { mcpAdvancedSettings: ["read", "update"] },
    });
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: `editor,${role.role}` });
    currentUser = user;
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      serverType: "local",
      localConfig: { command: "node", arguments: [] },
    });
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { deploymentSpecYaml: DEPLOYMENT_YAML },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().deploymentSpecYaml).toBe(DEPLOYMENT_YAML);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      limit: 20,
      offset: 0,
    });
    const write = audit.data.find(
      (row) => row.resourceId === catalog.id && row.outcome === "success",
    );
    expect(write?.before?.hasDeploymentSpecYaml).toBe(false);
    expect(write?.after?.hasDeploymentSpecYaml).toBe(true);
    expect(write?.after?.deploymentSpecYamlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(write)).not.toContain(DEPLOYMENT_YAML);
  });

  test.for([
    "editor",
    "admin",
  ])("a %s service-account token gets its actual YAML permissions", async (role, {
    makeServiceAccount,
    makeInternalMcpCatalog,
  }) => {
    const account = await makeServiceAccount(organizationId, { role });
    const token = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId,
      name: "rbac-check",
    });
    vi.mocked(betterAuth.api.getSession).mockResolvedValue({
      response: null,
      headers: new Headers(),
    } as never);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
      serverType: "local",
      deploymentSpecYaml: DEPLOYMENT_YAML,
      localConfig: { command: "node", arguments: [] },
    });
    const headers = { authorization: token.token };
    const preview = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${catalog.id}/deployment-yaml-preview`,
      headers,
    });
    expect(preview.statusCode, preview.body).toBe(role === "admin" ? 200 : 403);
    const write = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      headers,
      payload: { deploymentSpecYaml: `${DEPLOYMENT_YAML}\n` },
    });
    expect(write.statusCode, write.body).toBe(role === "admin" ? 200 : 403);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.deploymentSpecYaml,
    ).toBe(role === "admin" ? `${DEPLOYMENT_YAML}\n` : DEPLOYMENT_YAML);
  });
  test("nested YAML responses are redacted without corrupting dates or shared payloads", async () => {
    const payload = {
      createdAt: new Date("2026-01-01T00:00:00Z"),
      installations: [{ catalog: { deploymentSpecYaml: DEPLOYMENT_YAML } }],
      audit: { before: { deploymentSpecYaml: DEPLOYMENT_YAML } },
    };
    app.get(
      "/api/rbac-response-fixture",
      { schema: { operationId: RouteId.GetInternalMcpCatalog } },
      async () => payload,
    );
    currentUser = editor;
    const denied = await app.inject("/api/rbac-response-fixture");
    expect(denied.statusCode, denied.body).toBe(200);
    expect(denied.json()).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      installations: [{ catalog: { deploymentSpecYaml: null } }],
      audit: { before: { deploymentSpecYaml: null } },
    });
    currentUser = admin;
    const allowed = await app.inject("/api/rbac-response-fixture");
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().installations[0].catalog.deploymentSpecYaml).toBe(
      DEPLOYMENT_YAML,
    );
    expect(payload.audit.before.deploymentSpecYaml).toBe(DEPLOYMENT_YAML);
  });

  test("clearing or replacing localConfig cannot remove protected references without permission", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: editor.id,
      serverType: "local",
      localConfig: {
        command: "node",
        envFrom: [{ type: "secret", name: "trusted-runtime", prefix: "" }],
      },
    });
    currentUser = editor;
    for (const localConfig of [null, { command: "node" }]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${catalog.id}`,
        payload: { localConfig },
      });
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.envFrom?.[0].name,
    ).toBe("trusted-runtime");
  });
});
