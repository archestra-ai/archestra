import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AgentModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import AgentSuggestedPromptModel from "@/models/agent-suggested-prompt";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { seedDocsMcpServers } from "./seed-docs-mcp-servers";

const ARCHESTRA_DOCS_ID = "00000000-0000-4000-8000-000000000003";
const OPENAPPA_DOCS_ID = "00000000-0000-4000-8000-000000000004";

const DOCS_TOOLS = ["list_docs", "read_doc", "search_docs"].map((name) => ({
  name,
  description: `Docs tool ${name}`,
  inputSchema: { type: "object", properties: {} },
}));

describe("seedDocsMcpServers", () => {
  beforeEach(() => {
    config.enterpriseFeatures.core = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("installs both docs servers org-wide on a fresh community instance", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { admin, agentId } = await seedAdmin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const discover = vi
      .spyOn(mcpClient, "connectAndGetTools")
      .mockResolvedValue(DOCS_TOOLS);

    await seedDocsMcpServers();
    await drainBackgroundWork();

    const catalogs = await catalogRows();
    expect(
      catalogs.map((row) => [row.name, row.serverUrl, row.serverType]),
    ).toEqual([
      ["Archestra Docs", "https://archestra.ai/mcp", "remote"],
      ["OpenAPPA Docs", "https://www.openappa.com/mcp", "remote"],
    ]);
    for (const catalog of catalogs) {
      expect(catalog).toMatchObject({
        requiresAuth: false,
        authorId: admin.id,
      });
      expect(catalog.icon).toMatch(/^data:image\/svg\+xml;base64,/);
      const [install] = await liveInstalls(catalog.id);
      expect(install).toMatchObject({
        scope: "org",
        ownerId: admin.id,
        localInstallationStatus: "success",
      });
      expect(await rawToolNames(catalog.id)).toEqual([
        "list_docs",
        "read_doc",
        "search_docs",
      ]);
    }
    expect(discover).toHaveBeenCalledTimes(2);
    // The prompts are shown at read time, never stored on the assistant.
    expect(await AgentSuggestedPromptModel.getForAgent(agentId)).toEqual([]);
  });

  test("lets every member reach the docs tools, not only the admin", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { org } = await seedAdmin({ makeOrganization, makeUser, makeMember });
    vi.spyOn(mcpClient, "connectAndGetTools").mockResolvedValue(DOCS_TOOLS);
    await seedDocsMcpServers();
    await drainBackgroundWork();

    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const tools = await ToolModel.getMcpToolsAccessibleToUser({
      userId: member.id,
      organizationId: org.id,
      environmentId: null,
      isAdmin: false,
    });

    expect(
      tools
        .filter((tool) => tool.catalogId === ARCHESTRA_DOCS_ID)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "archestra_docs__list_docs",
      "archestra_docs__read_doc",
      "archestra_docs__search_docs",
    ]);
    expect(
      tools.filter((tool) => tool.catalogId === OPENAPPA_DOCS_ID),
    ).toHaveLength(3);
  });

  test("skips instances with an enterprise license", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedAdmin({ makeOrganization, makeUser, makeMember });
    config.enterpriseFeatures.core = true;
    const discover = vi.spyOn(mcpClient, "connectAndGetTools");

    await seedDocsMcpServers();
    await drainBackgroundWork();

    expect(await catalogRows()).toHaveLength(0);
    expect(discover).not.toHaveBeenCalled();
  });

  test("skips a registry that already has an MCP server", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    await seedAdmin({ makeOrganization, makeUser, makeMember });
    await makeInternalMcpCatalog({ serverType: "remote" });

    await seedDocsMcpServers();

    expect(await catalogRows()).toHaveLength(0);
  });

  test("does not bring back a deleted server", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedAdmin({ makeOrganization, makeUser, makeMember });
    vi.spyOn(mcpClient, "connectAndGetTools").mockResolvedValue(DOCS_TOOLS);
    await seedDocsMcpServers();
    await drainBackgroundWork();

    await InternalMcpCatalogModel.delete(ARCHESTRA_DOCS_ID);
    await seedDocsMcpServers();
    await drainBackgroundWork();

    const [archestra, openappa] = await catalogRows();
    expect(archestra.deletedAt).not.toBeNull();
    expect(await liveInstalls(ARCHESTRA_DOCS_ID)).toHaveLength(0);
    expect(openappa.deletedAt).toBeNull();
  });

  test("does not reinstall an uninstalled server", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedAdmin({ makeOrganization, makeUser, makeMember });
    vi.spyOn(mcpClient, "connectAndGetTools").mockRejectedValue(
      new Error("offline"),
    );
    await seedDocsMcpServers();
    await drainBackgroundWork();
    const [install] = await liveInstalls(ARCHESTRA_DOCS_ID);

    await McpServerModel.delete(install.id);
    await seedDocsMcpServers();
    await drainBackgroundWork();

    expect(await liveInstalls(ARCHESTRA_DOCS_ID)).toHaveLength(0);
  });

  test("starts offline and discovers the tools on a later start", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    await seedAdmin({ makeOrganization, makeUser, makeMember });
    const discover = vi
      .spyOn(mcpClient, "connectAndGetTools")
      .mockRejectedValue(new Error("getaddrinfo ENOTFOUND archestra.ai"));

    await seedDocsMcpServers();
    await drainBackgroundWork();
    expect((await liveInstalls(ARCHESTRA_DOCS_ID))[0]).toMatchObject({
      localInstallationStatus: "error",
    });
    expect(await rawToolNames(ARCHESTRA_DOCS_ID)).toEqual([]);

    discover.mockResolvedValue(DOCS_TOOLS);
    await seedDocsMcpServers();
    await drainBackgroundWork();

    expect(discover).toHaveBeenCalledTimes(4);
    expect(await rawToolNames(ARCHESTRA_DOCS_ID)).toHaveLength(3);
    expect(await rawToolNames(OPENAPPA_DOCS_ID)).toHaveLength(3);

    // Tools exist now, so later starts make no network call.
    await seedDocsMcpServers();
    await drainBackgroundWork();
    expect(discover).toHaveBeenCalledTimes(4);
  });
});

async function seedAdmin(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    options: { role: string },
  ) => Promise<unknown>;
}) {
  const org = await fixtures.makeOrganization();
  const admin = await fixtures.makeUser();
  await fixtures.makeMember(admin.id, org.id, { role: ADMIN_ROLE_NAME });
  const agentId = await AgentModel.ensurePersonalChatAgent({
    userId: admin.id,
    organizationId: org.id,
  });
  return { org, admin, agentId: agentId as string };
}

async function catalogRows() {
  return db
    .select()
    .from(schema.internalMcpCatalogTable)
    .where(
      inArray(schema.internalMcpCatalogTable.id, [
        ARCHESTRA_DOCS_ID,
        OPENAPPA_DOCS_ID,
      ]),
    )
    .orderBy(schema.internalMcpCatalogTable.id);
}

async function liveInstalls(catalogId: string) {
  return db
    .select()
    .from(schema.mcpServersTable)
    .where(
      and(
        eq(schema.mcpServersTable.catalogId, catalogId),
        isNull(schema.mcpServersTable.deletedAt),
      ),
    );
}

async function rawToolNames(catalogId: string) {
  const tools = await db
    .select({ name: schema.toolsTable.rawName })
    .from(schema.toolsTable)
    .where(eq(schema.toolsTable.catalogId, catalogId));
  return tools.map((tool) => tool.name).sort();
}
