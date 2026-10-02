import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { InternalMcpCatalogModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

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
    // Route-level permissions are enforced by the auth plugin, which these
    // tests do not register; the in-handler YAML check is what is under test.
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: "admin" });
    editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: "editor" });
    currentUser = admin;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
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

    expect(response.statusCode).toBe(200);
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

    expect(response.statusCode).toBe(200);
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

    expect(response.statusCode).toBe(200);
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
});
