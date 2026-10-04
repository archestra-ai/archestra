import { RouteId, resourcePermissionPresets } from "@archestra/shared";
import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { InternalMcpCatalogModel, ServiceAccountModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
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
 * Deployment YAML requires the existing scoped MCP Registry Full access preset.
 * Session identity is stubbed; middleware and database-backed policies are real.
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
    const policy = {
      organizationId,
      resource: "mcpRegistry" as const,
      scope: "*",
    };
    const previous = await ResourcePermissionPolicyModel.find(policy);
    await ResourcePermissionPolicyModel.replace({
      ...policy,
      revision: previous?.revision ?? 0,
      grants: [
        ...(previous?.grants ?? []),
        {
          subject: { type: "role", id: "editor" },
          actions: [...resourcePermissionPresets.edit.actions],
        },
      ],
    });

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
    expect(response.json().error.message).toContain("Full access");
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
      authorId: admin.id,
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
    expect(response.json().error.message).toContain("Full access");
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
      authorId: admin.id,
    });
    currentUser = editor;

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { deploymentSpecYaml: null },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("Full access");
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
      authorId: admin.id,
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

  test("an editor cannot add, replace or remove Kubernetes Secret references", async ({
    makeInternalMcpCatalog,
  }) => {
    const original = [
      { type: "secret" as const, name: "trusted-runtime", prefix: "" },
    ];
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
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
      authorId: admin.id,
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
  test.for([
    "read",
    "edit",
    "full",
    "wildcard",
  ] as const)("%s grants apply to exactly their YAML scope", async (level, {
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
      serverType: "local",
      localConfig: { command: "node", arguments: [] },
      deploymentSpecYaml: DEPLOYMENT_YAML,
    });
    const other = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
      serverType: "local",
      localConfig: { command: "node", arguments: [] },
      deploymentSpecYaml: DEPLOYMENT_YAML,
    });
    const context = {
      organizationId,
      resource: "mcpRegistry" as const,
      scope: level === "wildcard" ? "*" : catalog.id,
    };
    const previous = await ResourcePermissionPolicyModel.find(context);
    const actions =
      level === "read"
        ? resourcePermissionPresets.view.actions
        : level === "edit"
          ? resourcePermissionPresets.edit.actions
          : resourcePermissionPresets.manage.actions;
    await ResourcePermissionPolicyModel.replace({
      ...context,
      revision: previous?.revision ?? 0,
      grants: [
        ...(previous?.grants ?? []).filter(
          (g) => !(g.subject.type === "user" && g.subject.id === editor.id),
        ),
        { subject: { type: "user", id: editor.id }, actions: [...actions] },
      ],
    });
    currentUser = editor;
    const allowed = level === "full" || level === "wildcard";
    for (const target of [catalog, other]) {
      const expected =
        allowed && (target.id === catalog.id || level === "wildcard");
      const preview = await app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${target.id}/deployment-yaml-preview`,
      });
      expect(preview.statusCode, preview.body).toBe(expected ? 200 : 403);
      const validate = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/validate-deployment-yaml",
        payload: { yaml: DEPLOYMENT_YAML, catalogId: target.id },
      });
      expect(validate.statusCode, validate.body).toBe(expected ? 200 : 403);
      const update = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${target.id}`,
        payload: { deploymentSpecYaml: `${DEPLOYMENT_YAML}# scoped edit\n` },
      });
      expect(update.statusCode, update.body).toBe(expected ? 200 : 403);
      const get = await app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${target.id}`,
      });
      if (get.statusCode === 200)
        expect(get.json().deploymentSpecYaml).toBe(
          expected ? `${DEPLOYMENT_YAML}# scoped edit\n` : null,
        );
      {
        const reset = await app.inject({
          method: "POST",
          url: `/api/internal_mcp_catalog/${target.id}/reset-deployment-yaml`,
        });
        expect(reset.statusCode, reset.body).toBe(expected ? 200 : 403);
      }
    }
    const unscoped = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog/validate-deployment-yaml",
      payload: { yaml: DEPLOYMENT_YAML },
    });
    expect(unscoped.statusCode).toBe(level === "wildcard" ? 200 : 403);
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
  test("custom role composition combines scoped actions into Full access", async ({
    makeUser,
    makeMember,
    makeCustomRole,
    makeInternalMcpCatalog,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { mcpRegistry: ["read", "update"] },
    });
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: `editor,${role.role}` });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
      serverType: "local",
      localConfig: { command: "node", arguments: [] },
    });
    const previous = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "mcpRegistry",
      scope: catalog.id,
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId,
      resource: "mcpRegistry",
      scope: catalog.id,
      revision: previous?.revision ?? 0,
      grants: [
        {
          subject: { type: "role", id: "editor" },
          actions: ["read", "use", "update"],
        },
        {
          subject: { type: "role", id: role.id },
          actions: ["delete", "manage-permissions"],
        },
      ],
    });
    currentUser = user;
    const update = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { deploymentSpecYaml: DEPLOYMENT_YAML },
    });
    expect(update.statusCode, update.body).toBe(200);
  });
  test("a scoped service-account Full access grant does not reach another entry", async ({
    makeServiceAccount,
    makeInternalMcpCatalog,
  }) => {
    const account = await makeServiceAccount(organizationId, {
      role: "editor",
    });
    const token = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId,
      name: "scoped-check",
    });
    vi.mocked(betterAuth.api.getSession).mockResolvedValue({
      response: null,
      headers: new Headers(),
    } as never);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
      serverType: "local",
      localConfig: { command: "node", arguments: [] },
    });
    const other = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
      serverType: "local",
      localConfig: { command: "node", arguments: [] },
    });
    const previous = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "mcpRegistry",
      scope: catalog.id,
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId,
      resource: "mcpRegistry",
      scope: catalog.id,
      revision: previous?.revision ?? 0,
      grants: [
        ...(previous?.grants ?? []),
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: [...resourcePermissionPresets.manage.actions],
        },
      ],
    });
    for (const target of [catalog, other]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${target.id}`,
        headers: { authorization: token.token },
        payload: { deploymentSpecYaml: DEPLOYMENT_YAML },
      });
      expect(response.statusCode, response.body).toBe(
        target.id === catalog.id ? 200 : 403,
      );
    }
  });
  test("nested responses check each catalog id rather than treating one grant as global", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
      serverType: "local",
    });
    const other = await makeInternalMcpCatalog({
      organizationId,
      authorId: admin.id,
      serverType: "local",
    });
    const previous = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "mcpRegistry",
      scope: catalog.id,
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId,
      resource: "mcpRegistry",
      scope: catalog.id,
      revision: previous?.revision ?? 0,
      grants: [
        ...(previous?.grants ?? []),
        {
          subject: { type: "user", id: editor.id },
          actions: [...resourcePermissionPresets.manage.actions],
        },
      ],
    });
    app.get(
      "/api/scoped-response-fixture",
      { schema: { operationId: RouteId.GetInternalMcpCatalog } },
      async () => ({
        installations: [
          { catalog: { id: catalog.id, deploymentSpecYaml: DEPLOYMENT_YAML } },
          { catalog: { id: other.id, deploymentSpecYaml: DEPLOYMENT_YAML } },
        ],
      }),
    );
    currentUser = editor;
    const response = await app.inject("/api/scoped-response-fixture");
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .installations.map(
          (install: { catalog: { deploymentSpecYaml: string | null } }) =>
            install.catalog.deploymentSpecYaml,
        ),
    ).toEqual([DEPLOYMENT_YAML, null]);
  });
});
