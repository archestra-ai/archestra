import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { ToolModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Controllable stand-in for the runtime-manager singleton: the rename branch
// awaits `deploymentNamesAdopted` when K8s is configured, and the cascade
// paths must never touch the runtime for a pure rename.
const { managerMock } = vi.hoisted(() => ({
  managerMock: {
    isEnabled: false,
    deploymentNamesAdopted: Promise.resolve() as Promise<void>,
    tearDownOldNamespaceDeployments: vi.fn(),
    reinstallSharedDeployment: vi.fn(),
    restartServer: vi.fn(),
    getOrLoadDeployment: vi.fn(),
  },
}));
vi.mock("@/k8s/mcp-server-runtime/manager", () => ({ default: managerMock }));

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * Renames flow through the PUT route's rename branch: an org-level 409 gate,
 * an adopt-pass gate when K8s is configured, then
 * `InternalMcpCatalogModel.renameCascade` — one transaction renaming the
 * catalog, every install's derived name, tool slugs (ids stable), and
 * name-keyed limits, with zero K8s interaction.
 */
describe("PUT /api/internal_mcp_catalog/:id — rename", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    // Default: K8s runtime not configured (the common CI/local-test state).
    config.orchestrator.kubernetes.kubeconfig = undefined;
    config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster = false;
    managerMock.deploymentNamesAdopted = Promise.resolve();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("pure rename cascades catalog, install, tools, and limits atomically — stable tool ids, no reinstall, no K8s interaction", async ({
    makeAgent,
    makeAgentTool,
    makeMcpServer,
    makeToolPolicy,
  }) => {
    const catalog = await createCatalog({
      name: "rename-source",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const installedServer = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });
    const { created } = await ToolModel.syncToolsForCatalog([
      {
        name: "rename-source__do_thing",
        description: "d",
        parameters: {},
        catalogId: catalog.id,
        rawToolName: "do_thing",
      },
      {
        name: "rename-source__other_thing",
        description: "d",
        parameters: {},
        catalogId: catalog.id,
        rawToolName: "other_thing",
      },
    ]);
    const [toolA, toolB] = created;
    const agent = await makeAgent({ organizationId });
    await makeAgentTool(agent.id, toolA.id);
    const policy = await makeToolPolicy(toolA.id);
    await db.insert(schema.limitsTable).values([
      {
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 100,
        mcpServerName: installedServer.name,
        toolName: null,
      },
      {
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 100,
        mcpServerName: null,
        toolName: "rename-source__do_thing",
      },
    ]);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { name: "renamed-target" },
    });

    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json().name).toBe("renamed-target");

    // Catalog + install renamed (org-scope install name == base name).
    const [catalogRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(catalogRow.name).toBe("renamed-target");
    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.name).toBe("renamed-target");

    // Tools renamed IN PLACE: same ids, new slugs, raw names untouched.
    const [toolARow] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, toolA.id));
    expect(toolARow.name).toBe("renamed-target__do_thing");
    expect(toolARow.rawName).toBe("do_thing");
    const [toolBRow] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, toolB.id));
    expect(toolBRow.name).toBe("renamed-target__other_thing");

    // Policies and agent assignments survive (they hang off the stable id).
    const [policyRow] = await db
      .select()
      .from(schema.toolInvocationPoliciesTable)
      .where(eq(schema.toolInvocationPoliciesTable.id, policy.id));
    expect(policyRow.toolId).toBe(toolA.id);
    const agentToolRows = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.toolId, toolA.id));
    expect(agentToolRows).toHaveLength(1);

    // Name-keyed limits swapped to the new names.
    const limitRows = await db
      .select()
      .from(schema.limitsTable)
      .where(eq(schema.limitsTable.entityId, user.id));
    expect(limitRows).toHaveLength(2);
    expect(
      limitRows.map((l) => ({ server: l.mcpServerName, tool: l.toolName })),
    ).toEqual(
      expect.arrayContaining([
        { server: "renamed-target", tool: null },
        { server: null, tool: "renamed-target__do_thing" },
      ]),
    );

    // Pure DB cascade: no reinstall, no pod churn, no runtime calls.
    expect(serverRow.reinstallRequired).toBe(false);
    expect(serverRow.localInstallationStatus).toBe("idle");
    expect(managerMock.restartServer).not.toHaveBeenCalled();
    expect(managerMock.reinstallSharedDeployment).not.toHaveBeenCalled();
    expect(managerMock.tearDownOldNamespaceDeployments).not.toHaveBeenCalled();
  });

  test("renaming to another root catalog's name 409s with zero rows modified", async ({
    makeMcpServer,
  }) => {
    await createCatalog({ name: "alpha", serverType: "remote" });
    const beta = await createCatalog({ name: "beta", serverType: "local" });
    const installedServer = await makeMcpServer({
      catalogId: beta.id,
      scope: "org",
    });
    await ToolModel.syncToolsForCatalog([
      {
        name: "beta__do_thing",
        description: "d",
        parameters: {},
        catalogId: beta.id,
        rawToolName: "do_thing",
      },
    ]);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${beta.id}`,
      payload: { name: "alpha" },
    });

    expect(putResponse.statusCode).toBe(409);
    expect(putResponse.json().error.internal_code).toBe(
      "catalog_name_conflict",
    );

    const [catalogRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, beta.id));
    expect(catalogRow.name).toBe("beta");
    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.name).toBe(installedServer.name);
    const toolRows = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, beta.id));
    expect(toolRows.map((t) => t.name)).toEqual(["beta__do_thing"]);
  });

  test("the 409 gate is case-insensitive (tool slugs lowercase the name)", async () => {
    await createCatalog({ name: "alpha", serverType: "remote" });
    const beta = await createCatalog({ name: "beta", serverType: "remote" });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${beta.id}`,
      payload: { name: "ALPHA" },
    });

    expect(putResponse.statusCode).toBe(409);
  });

  test("the 409 gate rejects slug-equivalent names (whitespace vs underscores)", async () => {
    await createCatalog({ name: "My Server", serverType: "remote" });
    const beta = await createCatalog({ name: "beta", serverType: "remote" });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${beta.id}`,
      payload: { name: "my_server" },
    });

    expect(putResponse.statusCode).toBe(409);
    expect(putResponse.json().error.internal_code).toBe(
      "catalog_name_conflict",
    );

    const [catalogRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, beta.id));
    expect(catalogRow.name).toBe("beta");
  });

  test("a case-only self-rename is allowed (self excluded from the 409 gate)", async () => {
    const beta = await createCatalog({ name: "beta", serverType: "remote" });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${beta.id}`,
      payload: { name: "Beta" },
    });

    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json().name).toBe("Beta");
  });

  test("a catalog whose deploymentSpecYaml references the serverName placeholder flags installs reinstallRequired", async ({
    makeMcpServer,
  }) => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder
    const placeholder = "${archestra.server_name}";
    const catalog = await createCatalog({
      name: "yaml-placeholder",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
      deploymentSpecYaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: whatever
  labels:
    mcp-server-name: ${placeholder}
spec:
  replicas: 1
`,
    });
    const installedServer = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { name: "yaml-placeholder-renamed" },
    });

    expect(putResponse.statusCode).toBe(200);

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.name).toBe("yaml-placeholder-renamed");
    // The placeholder is the one way the display name reaches the pod spec —
    // these installs genuinely need a reinstall.
    expect(serverRow.reinstallRequired).toBe(true);
  });

  test("rename combined with a breaking change composes: renamed AND flagged for manual reinstall", async ({
    makeMcpServer,
  }) => {
    const catalog = await createCatalog({
      name: "combo-source",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const installedServer = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: "combo-renamed",
        serverType: "local",
        localConfig: { command: "bun", arguments: ["server.js"] },
      },
    });

    expect(putResponse.statusCode).toBe(200);

    const [catalogRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(catalogRow.name).toBe("combo-renamed");
    expect(catalogRow.localConfig?.command).toBe("bun");
    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.name).toBe("combo-renamed");
    // The command change (not the rename) drives the manual-reinstall flag.
    expect(serverRow.reinstallRequired).toBe(true);
  });

  test("a rename issued while K8s is configured waits for the adopt pass, then freezes NULL deployment names from the OLD name", async ({
    makeMcpServer,
  }) => {
    config.orchestrator.kubernetes.kubeconfig = "/fake/kubeconfig";
    let resolveAdopt!: () => void;
    managerMock.deploymentNamesAdopted = new Promise<void>((resolve) => {
      resolveAdopt = resolve;
    });

    const catalog = await createCatalog({
      name: "adopt-gated",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const installedServer = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });
    expect(installedServer.deploymentName).toBeNull();

    const injectPromise = app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { name: "adopt-gated-renamed" },
    });

    // While the adopt pass is pending, the rename must not have happened.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const [beforeRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(beforeRow.name).toBe("adopt-gated");

    resolveAdopt();
    const putResponse = await injectPromise;
    expect(putResponse.statusCode).toBe(200);

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.name).toBe("adopt-gated-renamed");
    // Freeze-fallback: post-adopt a NULL row provably has no live
    // deployment, so it freezes the legacy recompute of its OLD name.
    expect(serverRow.deploymentName).toBe(`mcp-${installedServer.name}`);
  });

  test("a failed adopt pass fails the rename with zero rows modified (churn-prevention outranks availability)", async ({
    makeMcpServer,
  }) => {
    config.orchestrator.kubernetes.kubeconfig = "/fake/kubeconfig";
    const rejected = Promise.reject(new Error("adopt pass failed"));
    rejected.catch(() => {}); // pre-observe; the route's await still rejects
    managerMock.deploymentNamesAdopted = rejected;

    const catalog = await createCatalog({
      name: "adopt-failed",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const installedServer = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { name: "adopt-failed-renamed" },
    });

    expect(putResponse.statusCode).toBe(500);

    const [catalogRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(catalogRow.name).toBe("adopt-failed");
    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.name).toBe(installedServer.name);
    expect(serverRow.deploymentName).toBeNull();
  });

  async function createCatalog(payload: Record<string, unknown>): Promise<{
    id: string;
  }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload,
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `createCatalog failed: ${response.statusCode} ${response.body}`,
      );
    }
    return response.json();
  }
});
