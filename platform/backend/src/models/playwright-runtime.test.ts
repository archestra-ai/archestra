import { PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import { and, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import { EnvironmentModel, McpServerModel } from "@/models";
import { describe, expect, mustExist, test } from "@/test";
import { agentOwner, appOwner } from "@/types";
import PlaywrightRuntimeModel from "./playwright-runtime";

describe("PlaywrightRuntimeModel", () => {
  test("reconciles one system runtime per Environment and retires legacy installs", async ({
    makeAgent,
    makeApp,
    makeInternalMcpCatalog,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const firstEnvironment = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "First",
      namespace: "first",
    });
    const secondEnvironment = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Second",
      namespace: "second",
    });
    const catalog = await makeInternalMcpCatalog({
      id: PLAYWRIGHT_MCP_CATALOG_ID,
      organizationId: null,
      name: "microsoft__playwright-mcp",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["cli.js", "--isolated"],
        transportType: "streamable-http",
        httpPort: 8080,
      },
    });
    const legacy = await McpServerModel.create({
      name: catalog.name,
      catalogId: catalog.id,
      serverType: "local",
      scope: "personal",
      ownerId: user.id,
      userId: user.id,
    });

    const firstPass = await PlaywrightRuntimeModel.reconcileAll();
    const secondPass = await PlaywrightRuntimeModel.reconcileAll();
    await PlaywrightRuntimeModel.retireLegacyInstallations();

    expect(firstPass).toHaveLength(3);
    expect(secondPass.map((server) => server.id).sort()).toEqual(
      firstPass.map((server) => server.id).sort(),
    );
    expect(await McpServerModel.findById(legacy.id)).toBeNull();
    expect(await PlaywrightRuntimeModel.findForEnvironment(null)).toMatchObject(
      { scope: "org", ownerId: null, teamId: null },
    );

    const firstRuntime = mustExist(
      await PlaywrightRuntimeModel.findForEnvironment(firstEnvironment.id),
    );
    const secondRuntime = mustExist(
      await PlaywrightRuntimeModel.findForEnvironment(secondEnvironment.id),
    );
    expect(firstRuntime.id).not.toBe(secondRuntime.id);
    expect(firstRuntime.catalogId).not.toBe(secondRuntime.catalogId);

    const runtimeCatalogs = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(
        eq(
          schema.internalMcpCatalogTable.parentCatalogItemId,
          PLAYWRIGHT_MCP_CATALOG_ID,
        ),
      );
    expect(runtimeCatalogs).toHaveLength(2);
    expect(runtimeCatalogs.map((row) => row.environmentId).sort()).toEqual(
      [firstEnvironment.id, secondEnvironment.id].sort(),
    );

    const firstAgent = await makeAgent({
      organizationId: organization.id,
      environmentId: firstEnvironment.id,
    });
    const secondAgent = await makeAgent({
      organizationId: organization.id,
      environmentId: secondEnvironment.id,
    });
    expect(
      (await PlaywrightRuntimeModel.findForOwner(agentOwner(firstAgent.id)))
        ?.id,
    ).toBe(firstRuntime.id);
    expect(
      (await PlaywrightRuntimeModel.findForOwner(agentOwner(secondAgent.id)))
        ?.id,
    ).toBe(secondRuntime.id);
    const listed = await EnvironmentModel.listForOrganization(organization.id);
    expect(
      listed.every((environment) => environment.assignedCatalogCount === 0),
    ).toBe(true);
    expect(
      await EnvironmentModel.countAssignedCatalogItems(firstEnvironment.id),
    ).toBe(0);

    const app = await makeApp({
      organizationId: organization.id,
      environmentId: firstEnvironment.id,
    });
    expect(
      (await PlaywrightRuntimeModel.findForOwner(appOwner(app.id)))?.id,
    ).toBe(firstRuntime.id);

    const [legacyUserLink] = await db
      .select()
      .from(schema.mcpServerUsersTable)
      .where(eq(schema.mcpServerUsersTable.mcpServerId, legacy.id));
    expect(legacyUserLink).toBeUndefined();
  });

  test("does not expose Environment runtime catalogs as top-level catalog entries", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const environment = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Isolated",
    });
    await makeInternalMcpCatalog({
      id: PLAYWRIGHT_MCP_CATALOG_ID,
      organizationId: null,
      name: "microsoft__playwright-mcp",
      serverType: "local",
      localConfig: {
        command: "node",
        transportType: "streamable-http",
        httpPort: 8080,
      },
    });

    await PlaywrightRuntimeModel.reconcileAll();

    const [child] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          eq(schema.internalMcpCatalogTable.environmentId, environment.id),
          eq(
            schema.internalMcpCatalogTable.parentCatalogItemId,
            PLAYWRIGHT_MCP_CATALOG_ID,
          ),
        ),
      );
    expect(child).toBeDefined();

    const topLevel = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(isNull(schema.internalMcpCatalogTable.parentCatalogItemId));
    expect(topLevel.map((row) => row.id)).toEqual([PLAYWRIGHT_MCP_CATALOG_ID]);
  });

  test("retires a managed runtime whose Environment no longer exists", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const environment = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Temporary",
    });
    await makeInternalMcpCatalog({
      id: PLAYWRIGHT_MCP_CATALOG_ID,
      organizationId: null,
      name: "microsoft__playwright-mcp",
      serverType: "local",
      localConfig: {
        command: "node",
        transportType: "streamable-http",
        httpPort: 8080,
      },
    });
    await PlaywrightRuntimeModel.reconcileAll();
    const runtime = mustExist(
      await PlaywrightRuntimeModel.findForEnvironment(environment.id),
    );

    await EnvironmentModel.delete(environment.id, organization.id);
    await PlaywrightRuntimeModel.retireLegacyInstallations();

    expect(await McpServerModel.findById(runtime.id)).toBeNull();
    expect(
      await PlaywrightRuntimeModel.findCatalogForEnvironment(environment.id),
    ).toBeNull();
  });
});
