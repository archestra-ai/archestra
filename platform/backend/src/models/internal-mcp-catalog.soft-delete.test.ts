import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpServerModel from "./mcp-server";
import ToolModel from "./tool";

async function rawServer(id: string) {
  const [row] = await db
    .select()
    .from(schema.mcpServersTable)
    .where(eq(schema.mcpServersTable.id, id));
  return row ?? null;
}

async function rawCatalog(id: string) {
  const [row] = await db
    .select()
    .from(schema.internalMcpCatalogTable)
    .where(eq(schema.internalMcpCatalogTable.id, id));
  return row ?? null;
}

async function rawTool(id: string) {
  const [row] = await db
    .select()
    .from(schema.toolsTable)
    .where(eq(schema.toolsTable.id, id));
  return row ?? null;
}

test("catalog delete soft-deletes the catalog, its installs, and its tools", async ({
  makeOrganization,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeTool,
}) => {
  const org = await makeOrganization();
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const server = await makeMcpServer({ catalogId: catalog.id });
  const tool = await makeTool({ catalogId: catalog.id });

  expect(await InternalMcpCatalogModel.findById(catalog.id)).not.toBeNull();

  expect(await InternalMcpCatalogModel.delete(catalog.id)).toBe(true);

  // Hidden from active reads, but the rows survive (soft-deleted).
  expect(await InternalMcpCatalogModel.findById(catalog.id)).toBeNull();
  expect((await rawCatalog(catalog.id))?.deletedAt).not.toBeNull();
  expect((await rawServer(server.id))?.deletedAt).not.toBeNull();
  expect((await rawTool(tool.id))?.deletedAt).not.toBeNull();

  // The whole cascade shares ONE deletedAt timestamp (the restore correlation key).
  const catAt = (await rawCatalog(catalog.id))?.deletedAt?.getTime();
  expect((await rawServer(server.id))?.deletedAt?.getTime()).toBe(catAt);
  expect((await rawTool(tool.id))?.deletedAt?.getTime()).toBe(catAt);
});

test("catalog restore revives the cascaded installs + tools and flags reinstall", async ({
  makeOrganization,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeTool,
}) => {
  const org = await makeOrganization();
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const server = await makeMcpServer({ catalogId: catalog.id });
  const tool = await makeTool({ catalogId: catalog.id });

  await InternalMcpCatalogModel.delete(catalog.id);
  expect(await InternalMcpCatalogModel.restore(catalog.id)).toBe(true);

  expect(await InternalMcpCatalogModel.findById(catalog.id)).not.toBeNull();
  expect((await rawServer(server.id))?.deletedAt).toBeNull();
  expect((await rawTool(tool.id))?.deletedAt).toBeNull();
  // Flag-only restore: the install is marked for a manual reinstall.
  expect((await rawServer(server.id))?.reinstallRequired).toBe(true);
});

test("catalog restore does NOT revive an install deleted before the catalog", async ({
  makeOrganization,
  makeInternalMcpCatalog,
  makeMcpServer,
}) => {
  const org = await makeOrganization();
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const cascaded = await makeMcpServer({ catalogId: catalog.id });
  const priorlyDeleted = await makeMcpServer({ catalogId: catalog.id });

  // Delete one install individually first with an explicit earlier timestamp,
  // so it can never collide (same millisecond) with the catalog cascade's own
  // `new Date()` — the boundary this test asserts is the distinct timestamp.
  await McpServerModel.delete(priorlyDeleted.id, {
    at: new Date(Date.now() - 60_000),
  });
  // Then delete the catalog — cascades the OTHER install with a shared timestamp.
  await InternalMcpCatalogModel.delete(catalog.id);

  await InternalMcpCatalogModel.restore(catalog.id);

  // Only the cascaded install returns; the individually-deleted one stays deleted.
  expect((await rawServer(cascaded.id))?.deletedAt).toBeNull();
  expect((await rawServer(priorlyDeleted.id))?.deletedAt).not.toBeNull();
});

test("standalone server soft-delete hides it but retains the row", async ({
  makeMcpServer,
}) => {
  const server = await makeMcpServer({});

  expect(await McpServerModel.delete(server.id)).toBe(true);
  expect(await McpServerModel.findById(server.id)).toBeNull();
  expect((await rawServer(server.id))?.deletedAt).not.toBeNull();

  expect(await McpServerModel.restore(server.id)).toBe(true);
  expect((await rawServer(server.id))?.deletedAt).toBeNull();
  expect((await rawServer(server.id))?.reinstallRequired).toBe(true);
});

test("restore-conflict: a team already has an active install", async ({
  makeOrganization,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeUser,
  makeTeam,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const team = await makeTeam(org.id, user.id);
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });

  const deleted = await makeMcpServer({
    catalogId: catalog.id,
    scope: "team",
    teamId: team.id,
  });
  await McpServerModel.delete(deleted.id);

  // A replacement team install exists (active) for the same catalog + team.
  await makeMcpServer({
    catalogId: catalog.id,
    scope: "team",
    teamId: team.id,
  });

  const target = await McpServerModel.findDeletedByIdForOrganization(
    deleted.id,
    org.id,
  );
  expect(target).not.toBeNull();
  const conflict = target
    ? await McpServerModel.getRestoreConflictMessage(target)
    : null;
  expect(conflict).toContain("team already has an active installation");
});

test("a soft-deleted catalog's tools stop authorizing and listing for an agent", async ({
  makeOrganization,
  makeInternalMcpCatalog,
  makeAgent,
  makeTool,
  makeAgentTool,
}) => {
  const org = await makeOrganization();
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const agent = await makeAgent({ organizationId: org.id });
  const tool = await makeTool({ catalogId: catalog.id });
  await makeAgentTool(agent.id, tool.id);

  // Active: the tool authorizes and lists.
  expect(
    await ToolModel.findByNameForAgent(tool.name, agent.id),
  ).not.toBeNull();
  expect(await ToolModel.getMcpToolNamesByAgent(agent.id)).toContain(tool.name);

  await InternalMcpCatalogModel.delete(catalog.id);

  // The agent_tools binding is retained, but the tool no longer resolves — a
  // soft-deleted catalog's tools stop authorizing (Option B) and stop listing.
  expect(await ToolModel.findByNameForAgent(tool.name, agent.id)).toBeNull();
  expect(await ToolModel.getMcpToolNamesByAgent(agent.id)).not.toContain(
    tool.name,
  );
});

test("syncToolsForCatalog on reinstall restores the soft-deleted tool row instead of duplicating it", async ({
  makeOrganization,
  makeInternalMcpCatalog,
  makeTool,
}) => {
  const org = await makeOrganization();
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const rawName = "generate_text";
  const toolName = ToolModel.slugifyName(catalog.name, rawName);
  const tool = await makeTool({
    catalogId: catalog.id,
    name: toolName,
    rawName,
  });

  // Uninstall (catalog delete) soft-deletes the tool row.
  await InternalMcpCatalogModel.delete(catalog.id);
  expect((await rawTool(tool.id))?.deletedAt).not.toBeNull();

  // Reinstall re-advertises the same tool.
  await ToolModel.syncToolsForCatalog([
    {
      name: toolName,
      description: "regenerated",
      parameters: {},
      catalogId: catalog.id,
      rawToolName: rawName,
    },
  ]);

  // The dead row is revived in place — no duplicate live row alongside it.
  const rows = await db
    .select()
    .from(schema.toolsTable)
    .where(eq(schema.toolsTable.catalogId, catalog.id));
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(tool.id);
  expect(rows[0].deletedAt).toBeNull();
});

test("findDeletedForOrganization lists soft-deleted catalog roots and installs", async ({
  makeOrganization,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeUser,
  makeMember,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  await makeMember(owner.id, org.id, { role: "admin" });
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const server = await makeMcpServer({
    catalogId: catalog.id,
    scope: "personal",
    ownerId: owner.id,
  });

  // Nothing deleted yet.
  expect(
    await InternalMcpCatalogModel.findDeletedForOrganization(org.id),
  ).toHaveLength(0);
  expect(await McpServerModel.findDeletedForOrganization(org.id)).toHaveLength(
    0,
  );

  await InternalMcpCatalogModel.delete(catalog.id);

  const deletedCatalogs =
    await InternalMcpCatalogModel.findDeletedForOrganization(org.id);
  expect(deletedCatalogs.some((c) => c.id === catalog.id)).toBe(true);

  const deletedServers = await McpServerModel.findDeletedForOrganization(
    org.id,
  );
  expect(deletedServers.some((s) => s.id === server.id)).toBe(true);
});
