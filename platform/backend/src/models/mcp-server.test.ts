import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, mustExist, test } from "@/test";
import AgentModel from "./agent";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpServerModel, {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
  // SPDX-SnippetEnd
} from "./mcp-server";
import McpServerUserModel from "./mcp-server-user";
import SecretModel from "./secret";

const uiMeta = (resourceUri: string) => ({ _meta: { ui: { resourceUri } } });

describe("McpServerModel", () => {
  describe("serverType field", () => {
    test("MCP servers store serverType correctly including builtin", async ({
      makeInternalMcpCatalog,
    }) => {
      // Create catalogs for each server type
      const localCatalog = await makeInternalMcpCatalog({
        name: "Local Test Catalog",
        serverType: "local",
        localConfig: { command: "node", arguments: ["server.js"] },
      });

      const remoteCatalog = await makeInternalMcpCatalog({
        name: "Remote Test Catalog",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
      });

      const builtinCatalog = await makeInternalMcpCatalog({
        name: "Builtin Test Catalog",
        serverType: "builtin",
      });

      // Create MCP server instances with different types
      const [localServer] = await db
        .insert(schema.mcpServersTable)
        .values({
          name: "Local Server",
          serverType: "local",
          catalogId: localCatalog.id,
        })
        .returning();

      const [remoteServer] = await db
        .insert(schema.mcpServersTable)
        .values({
          name: "Remote Server",
          serverType: "remote",
          catalogId: remoteCatalog.id,
        })
        .returning();

      const [builtinServer] = await db
        .insert(schema.mcpServersTable)
        .values({
          name: "Builtin Server",
          serverType: "builtin",
          catalogId: builtinCatalog.id,
        })
        .returning();

      // Verify serverTypes are stored correctly
      expect(localServer.serverType).toBe("local");
      expect(remoteServer.serverType).toBe("remote");
      expect(builtinServer.serverType).toBe("builtin");

      // Verify we can find them by ID
      const foundLocal = await McpServerModel.findById(localServer.id);
      const foundRemote = await McpServerModel.findById(remoteServer.id);
      const foundBuiltin = await McpServerModel.findById(builtinServer.id);

      expect(foundLocal?.serverType).toBe("local");
      expect(foundRemote?.serverType).toBe("remote");
      expect(foundBuiltin?.serverType).toBe("builtin");
    });
  });

  describe("findByIdsBasic", () => {
    test("returns basic MCP server records for given IDs", async ({
      makeMcpServer,
    }) => {
      const server1 = await makeMcpServer();
      const server2 = await makeMcpServer();
      await makeMcpServer(); // not requested

      const results = await McpServerModel.findByIdsBasic([
        server1.id,
        server2.id,
      ]);

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id).sort()).toEqual(
        [server1.id, server2.id].sort(),
      );
    });

    test("returns empty array for empty input", async () => {
      const results = await McpServerModel.findByIdsBasic([]);
      expect(results).toEqual([]);
    });

    test("returns empty array for non-existent IDs", async () => {
      const results = await McpServerModel.findByIdsBasic([
        crypto.randomUUID(),
      ]);
      expect(results).toEqual([]);
    });
  });

  describe("installation status batches", () => {
    test("finalizes only rows still carrying the expected operation marker", async ({
      makeMcpServer,
    }) => {
      const first = await makeMcpServer();
      const second = await makeMcpServer();
      const marker = "archestra:hard-reset:old-operation";
      await McpServerModel.updateInstallationStatuses({
        ids: [first.id, second.id],
        status: "pending",
        error: marker,
      });
      await McpServerModel.updateInstallationStatuses({
        ids: [first.id],
        status: "pending",
        error: "archestra:hard-reset:new-operation",
      });

      const updated = await McpServerModel.updateInstallationStatuses({
        ids: [first.id, second.id],
        status: "success",
        error: null,
        expected: { status: "pending", error: marker },
      });

      expect(updated).toEqual([second.id]);
      expect(
        (await McpServerModel.findById(first.id))?.localInstallationError,
      ).toBe("archestra:hard-reset:new-operation");
      expect(
        (await McpServerModel.findById(second.id))?.localInstallationStatus,
      ).toBe("success");
      expect(
        await McpServerModel.findPendingInstallationsByErrorPrefix(
          "archestra:hard-reset:",
        ),
      ).toEqual([
        {
          id: first.id,
          localInstallationError: "archestra:hard-reset:new-operation",
        },
      ]);
    });
  });

  describe("findAll personal connection visibility", () => {
    test("a non-admin does not see another user's personal connection", async ({
      makeMcpServer,
      makeUser,
    }) => {
      const me = await makeUser();
      const colleague = await makeUser();
      const theirs = await makeMcpServer({
        scope: "personal",
        ownerId: colleague.id,
      });
      await McpServerUserModel.assignUserToMcpServer(theirs.id, colleague.id);

      const visible = await McpServerModel.findAll(me.id, false);

      expect(visible.find((s) => s.id === theirs.id)).toBeUndefined();
    });

    test("installation admin does not see another user's personal connection", async ({
      makeMcpServer,
      makeUser,
    }) => {
      const me = await makeUser();
      const colleague = await makeUser();
      const theirs = await makeMcpServer({
        scope: "personal",
        ownerId: colleague.id,
      });
      await McpServerUserModel.assignUserToMcpServer(theirs.id, colleague.id);
      const visible = await McpServerModel.findAll(me.id, true);

      expect(visible.find((s) => s.id === theirs.id)).toBeUndefined();
    });

    test("predefined admin sees another user's personal connection in their organization only", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeOrganization,
      makeUser,
    }) => {
      const admin = await makeUser();
      const colleague = await makeUser();
      const otherOrgUser = await makeUser();
      const organization = await makeOrganization();
      const otherOrganization = await makeOrganization();
      const catalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
      });
      const otherCatalog = await makeInternalMcpCatalog({
        organizationId: otherOrganization.id,
      });
      const colleagueConnection = await makeMcpServer({
        catalogId: catalog.id,
        scope: "personal",
        ownerId: colleague.id,
      });
      const otherOrgConnection = await makeMcpServer({
        catalogId: otherCatalog.id,
        scope: "personal",
        ownerId: otherOrgUser.id,
      });

      const visible = await McpServerModel.findAll(
        admin.id,
        true,
        organization.id,
        undefined,
        true,
      );

      expect(visible.map((server) => server.id)).toContain(
        colleagueConnection.id,
      );
      expect(visible.map((server) => server.id)).not.toContain(
        otherOrgConnection.id,
      );
    });

    test("own personal connections are visible without the permission", async ({
      makeMcpServer,
      makeUser,
    }) => {
      const me = await makeUser();
      const mine = await makeMcpServer({ scope: "personal", ownerId: me.id });
      await McpServerUserModel.assignUserToMcpServer(mine.id, me.id);

      const visible = await McpServerModel.findAll(me.id, false);

      expect(visible.find((s) => s.id === mine.id)).toBeDefined();
    });
  });

  describe("findAll", () => {
    test("returns servers with user details from combined query", async ({
      makeMcpServer,
      makeUser,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const server = await makeMcpServer();

      // Assign users to the server
      await McpServerUserModel.assignUserToMcpServer(server.id, user1.id);
      await McpServerUserModel.assignUserToMcpServer(server.id, user2.id);

      // findAll as admin (no access control)
      const allServers = await McpServerModel.findAll(undefined, true);
      const found = allServers.find((s) => s.id === server.id);
      expect(found).toBeDefined();
      if (!found) return;
      expect(found.users).toHaveLength(2);
      expect(found.users).toContain(user1.id);
      expect(found.users).toContain(user2.id);
      expect(found.userDetails).toHaveLength(2);
      expect(found.userDetails?.map((u) => u.userId).sort()).toEqual(
        [user1.id, user2.id].sort(),
      );
    });

    test("auto-mode agents are served org-wide, not embedded per server", async ({
      makeOrganization,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const autoAgent = await makeAgent({
        organizationId: org.id,
        name: "Auto Agent",
        accessAllTools: true,
      });
      // A custom-tools agent (explicit assignments) is NOT an auto-mode agent.
      await makeAgent({
        organizationId: org.id,
        name: "Custom Agent",
        accessAllTools: false,
      });
      const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
      const server = await makeMcpServer({ catalogId: catalog.id });

      // The org-wide set comes from one place — the set is identical for
      // every server, so embedding it per row repeated the whole roster.
      const byOrg = await AgentModel.getAutoModeAgentDetailsByOrganizations([
        org.id,
      ]);
      expect(byOrg.get(org.id)).toEqual([
        expect.objectContaining({ id: autoAgent.id, name: "Auto Agent" }),
      ]);

      // Server rows no longer carry the roster.
      const withOrg = await McpServerModel.findAll(undefined, true, org.id);
      const found = mustExist(withOrg.find((s) => s.id === server.id));
      expect(found).not.toHaveProperty("autoModeAgents");
      const single = mustExist(
        await McpServerModel.findById(server.id, undefined, true),
      );
      expect(single).not.toHaveProperty("autoModeAgents");
    });

    test("attributes same-named personal agents to their owners", async ({
      makeOrganization,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
    }) => {
      // Every member gets an auto-seeded personal agent, and they all carry
      // the same name — the owner is the only thing that tells them apart.
      const org = await makeOrganization();
      const alice = await makeUser({ email: "alice@example.com" });
      const bob = await makeUser({ email: "bob@example.com" });
      await makeAgent({
        organizationId: org.id,
        name: "My Assistant",
        agentType: "agent",
        scope: "personal",
        accessAllTools: true,
        authorId: alice.id,
      });
      await makeAgent({
        organizationId: org.id,
        name: "My Assistant",
        agentType: "agent",
        scope: "personal",
        accessAllTools: true,
        authorId: bob.id,
      });
      const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
      await makeMcpServer({ catalogId: catalog.id });

      const byOrg = await AgentModel.getAutoModeAgentDetailsByOrganizations([
        org.id,
      ]);

      expect(
        byOrg
          .get(org.id)
          ?.map((agent) => ({
            name: agent.name,
            scope: agent.scope,
            agentType: agent.agentType,
            ownerId: agent.ownerId,
            ownerEmail: agent.ownerEmail,
          }))
          .sort((a, b) =>
            (a.ownerEmail ?? "").localeCompare(b.ownerEmail ?? ""),
          ),
      ).toEqual([
        {
          name: "My Assistant",
          scope: "personal",
          agentType: "agent",
          ownerId: alice.id,
          ownerEmail: "alice@example.com",
        },
        {
          name: "My Assistant",
          scope: "personal",
          agentType: "agent",
          ownerId: bob.id,
          ownerEmail: "bob@example.com",
        },
      ]);
    });

    test("reports a null owner for an authorless agent", async ({
      makeOrganization,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      await makeAgent({
        organizationId: org.id,
        name: "Shared Gateway",
        accessAllTools: true,
      });
      const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
      await makeMcpServer({ catalogId: catalog.id });

      const byOrg = await AgentModel.getAutoModeAgentDetailsByOrganizations([
        org.id,
      ]);

      expect(byOrg.get(org.id)).toEqual([
        expect.objectContaining({
          name: "Shared Gateway",
          ownerId: null,
          ownerEmail: null,
        }),
      ]);
    });

    test("returns servers with no users correctly", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();

      const allServers = await McpServerModel.findAll(undefined, true);
      const found = allServers.find((s) => s.id === server.id);
      expect(found).toBeDefined();
      if (!found) return;
      expect(found.users).toHaveLength(0);
      expect(found.userDetails).toHaveLength(0);
    });

    test("does not duplicate servers when multiple users assigned", async ({
      makeMcpServer,
      makeUser,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const user3 = await makeUser();
      const server = await makeMcpServer();

      await McpServerUserModel.assignUserToMcpServer(server.id, user1.id);
      await McpServerUserModel.assignUserToMcpServer(server.id, user2.id);
      await McpServerUserModel.assignUserToMcpServer(server.id, user3.id);

      const allServers = await McpServerModel.findAll(undefined, true);
      // Ensure the server only appears once despite 3 users (LEFT JOIN dedup)
      const matching = allServers.filter((s) => s.id === server.id);
      expect(matching).toHaveLength(1);
      expect(matching[0].users).toHaveLength(3);
    });
  });

  describe("findAll with scope filter", () => {
    test("returns the owner's personal installation from a global catalog when organization-scoped", async ({
      makeInternalMcpCatalog,
      makeOrganization,
      makeUser,
    }) => {
      const organization = await makeOrganization();
      const owner = await makeUser();
      const catalog = await makeInternalMcpCatalog();
      await db
        .update(schema.internalMcpCatalogTable)
        .set({ organizationId: null })
        .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
      const server = await McpServerModel.create({
        name: catalog.name,
        serverType: "local",
        catalogId: catalog.id,
        ownerId: owner.id,
        userId: owner.id,
        scope: "personal",
      });

      const visible = await McpServerModel.findAll(
        owner.id,
        false,
        organization.id,
      );

      expect(visible.map((candidate) => candidate.id)).toContain(server.id);
    });

    test("returns an org-scoped server to any member of the organization", async ({
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      const organization = await makeOrganization();
      const installer = await makeUser();
      const otherMember = await makeUser();
      await makeMember(installer.id, organization.id);
      await makeMember(otherMember.id, organization.id);

      const catalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
      });
      const server = await McpServerModel.create({
        name: catalog.name,
        serverType: "remote",
        catalogId: catalog.id,
        ownerId: installer.id,
        scope: "org",
      });

      const otherMemberView = await McpServerModel.findAll(
        otherMember.id,
        false,
      );
      expect(otherMemberView.find((s) => s.id === server.id)).toBeDefined();
    });

    test("returns a personal server only to its owner", async ({
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      const organization = await makeOrganization();
      const owner = await makeUser();
      const otherMember = await makeUser();
      await makeMember(owner.id, organization.id);
      await makeMember(otherMember.id, organization.id);

      const catalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
      });
      const server = await McpServerModel.create({
        name: catalog.name,
        serverType: "remote",
        catalogId: catalog.id,
        ownerId: owner.id,
        userId: owner.id,
        scope: "personal",
      });

      const ownerView = await McpServerModel.findAll(owner.id, false);
      expect(ownerView.find((s) => s.id === server.id)).toBeDefined();

      const otherView = await McpServerModel.findAll(otherMember.id, false);
      expect(otherView.find((s) => s.id === server.id)).toBeUndefined();
    });

    test("returns a team server to team members and hides it from non-members", async ({
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeUser,
    }) => {
      const organization = await makeOrganization();
      const installer = await makeUser();
      const teamMember = await makeUser();
      const nonMember = await makeUser();
      await makeMember(installer.id, organization.id);
      await makeMember(teamMember.id, organization.id);
      await makeMember(nonMember.id, organization.id);

      const team = await makeTeam(organization.id, installer.id);
      await makeTeamMember(team.id, teamMember.id);

      const catalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
      });
      const server = await McpServerModel.create({
        name: catalog.name,
        serverType: "remote",
        catalogId: catalog.id,
        ownerId: installer.id,
        scope: "team",
        teamId: team.id,
      });

      const memberView = await McpServerModel.findAll(teamMember.id, false);
      expect(memberView.find((s) => s.id === server.id)).toBeDefined();

      const nonMemberView = await McpServerModel.findAll(nonMember.id, false);
      expect(nonMemberView.find((s) => s.id === server.id)).toBeUndefined();
    });

    test("returns all servers to a predefined Admin regardless of scope", async ({
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTeam,
      makeUser,
    }) => {
      const organization = await makeOrganization();
      const admin = await makeUser();
      const installer = await makeUser();
      await makeMember(admin.id, organization.id);
      await makeMember(installer.id, organization.id);

      const team = await makeTeam(organization.id, installer.id);

      const catalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
      });
      const orgServer = await McpServerModel.create({
        name: `${catalog.name}-org`,
        serverType: "remote",
        catalogId: catalog.id,
        ownerId: installer.id,
        scope: "org",
      });
      const personalServer = await McpServerModel.create({
        name: `${catalog.name}-personal`,
        serverType: "remote",
        catalogId: catalog.id,
        ownerId: installer.id,
        scope: "personal",
      });
      const teamServer = await McpServerModel.create({
        name: `${catalog.name}-team`,
        serverType: "remote",
        catalogId: catalog.id,
        ownerId: installer.id,
        scope: "team",
        teamId: team.id,
      });

      const adminView = await McpServerModel.findAll(
        admin.id,
        true,
        organization.id,
        undefined,
        true,
      );
      const adminIds = adminView.map((s) => s.id);
      expect(adminIds).toContain(orgServer.id);
      expect(adminIds).toContain(personalServer.id);
      expect(adminIds).toContain(teamServer.id);
    });
  });

  describe("getUserPersonalServerForCatalog", () => {
    test("does not return an org-scoped server owned by the user", async ({
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      const organization = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, organization.id);

      const catalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
      });
      await McpServerModel.create({
        name: catalog.name,
        serverType: "remote",
        catalogId: catalog.id,
        ownerId: user.id,
        scope: "org",
      });

      const result = await McpServerModel.getUserPersonalServerForCatalog(
        user.id,
        catalog.id,
      );
      expect(result).toBeNull();
    });

    test("returns the personal server when both personal and org scopes exist", async ({
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      const organization = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, organization.id);

      const catalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
      });
      await McpServerModel.create({
        name: `${catalog.name}-org`,
        serverType: "remote",
        catalogId: catalog.id,
        ownerId: user.id,
        scope: "org",
      });
      const personal = await McpServerModel.create({
        name: `${catalog.name}-personal`,
        serverType: "remote",
        catalogId: catalog.id,
        ownerId: user.id,
        userId: user.id,
        scope: "personal",
      });

      const result = await McpServerModel.getUserPersonalServerForCatalog(
        user.id,
        catalog.id,
      );
      expect(result?.id).toBe(personal.id);
    });
  });

  describe("getUserPersonalServersForCatalogs", () => {
    test("does not return org-scoped servers owned by the user", async ({
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      const organization = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, organization.id);

      const orgCatalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
      });
      const personalCatalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
      });
      await McpServerModel.create({
        name: orgCatalog.name,
        serverType: "remote",
        catalogId: orgCatalog.id,
        ownerId: user.id,
        scope: "org",
      });
      const personal = await McpServerModel.create({
        name: personalCatalog.name,
        serverType: "remote",
        catalogId: personalCatalog.id,
        ownerId: user.id,
        userId: user.id,
        scope: "personal",
      });

      const result = await McpServerModel.getUserPersonalServersForCatalogs(
        user.id,
        [orgCatalog.id, personalCatalog.id],
      );
      expect(result.has(orgCatalog.id)).toBe(false);
      expect(result.get(personalCatalog.id)?.id).toBe(personal.id);
    });
  });

  describe("constructServerName", () => {
    const baseParams = {
      baseName: "notion",
      ownerId: "user-123",
      teamId: "team-456",
    };

    test("remote server ignores scope when deriving the name", () => {
      const remotePersonal = McpServerModel.constructServerName({
        ...baseParams,
        serverType: "remote",
        scope: "personal",
      });
      const remoteTeam = McpServerModel.constructServerName({
        ...baseParams,
        serverType: "remote",
        scope: "team",
      });
      const remoteOrg = McpServerModel.constructServerName({
        ...baseParams,
        serverType: "remote",
        scope: "org",
      });
      expect(remotePersonal).toBe("notion");
      expect(remoteTeam).toBe("notion");
      expect(remoteOrg).toBe("notion");
    });

    test("local personal scope suffixes with ownerId", () => {
      expect(
        McpServerModel.constructServerName({
          ...baseParams,
          serverType: "local",
          scope: "personal",
        }),
      ).toBe("notion-user-123");
    });

    test("local team scope suffixes with teamId", () => {
      expect(
        McpServerModel.constructServerName({
          ...baseParams,
          serverType: "local",
          scope: "team",
        }),
      ).toBe("notion-team-456");
    });

    test("local org scope uses base name (no suffix)", () => {
      expect(
        McpServerModel.constructServerName({
          ...baseParams,
          serverType: "local",
          scope: "org",
        }),
      ).toBe("notion");
    });
  });

  describe("findUiCapableForCaller", () => {
    test("lists a catalog's ui:// tool once per accessible install, with its metadata, resource, and install scope", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Excalidraw",
        description: "Draw diagrams",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      const install = await makeMcpServer({
        catalogId: catalog.id,
        scope: "org",
      });
      await makeTool({
        catalogId: catalog.id,
        name: "draw",
        description: "Draws a picture",
        meta: uiMeta("ui://excalidraw/app.html"),
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
      });
      const entry = res.find((r) => r.catalogId === catalog.id);
      expect(entry).toMatchObject({
        catalogId: catalog.id,
        mcpServerId: install.id,
        scope: "org",
        serverName: "Excalidraw",
        toolName: "draw",
        toolDescription: "Draws a picture",
        resourceUri: "ui://excalidraw/app.html",
      });
    });

    test("strips the server prefix from the tool name", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Excalidraw Staging",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({
        catalogId: catalog.id,
        name: "excalidraw_staging__create_view",
        meta: uiMeta("ui://excalidraw/view.html"),
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
      });
      expect(res.find((r) => r.catalogId === catalog.id)?.toolName).toBe(
        "create_view",
      );
    });

    test("orders per-install entries by scope precedence (personal → team → org), not DB order", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Multi-scope",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      // Insert the org install first so a naive (DB-order) result would put
      // "org" before "personal".
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      const personal = await makeMcpServer({
        catalogId: catalog.id,
        scope: "personal",
        ownerId: user.id,
      });
      await McpServerUserModel.assignUserToMcpServer(personal.id, user.id);
      await makeTool({
        catalogId: catalog.id,
        name: "draw",
        meta: uiMeta("ui://ms/app.html"),
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
      });
      // One entry per accessible install, ordered by scope precedence.
      expect(
        res.filter((r) => r.catalogId === catalog.id).map((r) => r.scope),
      ).toEqual(["personal", "org"]);
    });

    test("lists a UI catalog once per accessible install", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Archestra PM",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({
        catalogId: catalog.id,
        name: "open",
        meta: uiMeta("ui://pm/app.html"),
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
      });
      const entries = res.filter((r) => r.catalogId === catalog.id);
      expect(entries).toHaveLength(3);
      // Each entry is a distinct install of the same UI resource.
      expect(new Set(entries.map((e) => e.mcpServerId)).size).toBe(3);
    });

    test("omits a visible catalog with no accessible install entirely", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Uninstalled",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeTool({
        catalogId: catalog.id,
        name: "draw",
        meta: uiMeta("ui://uninstalled/app.html"),
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
      });
      expect(res.find((r) => r.catalogId === catalog.id)).toBeUndefined();
    });

    test("excludes catalogs whose tools carry no ui:// resource", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Plain",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({
        catalogId: catalog.id,
        name: "plain",
        meta: { _meta: {} },
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
      });
      expect(res.some((r) => r.catalogId === catalog.id)).toBe(false);
    });

    test("excludes the built-in Archestra catalog even when it has ui:// tools", async ({
      makeUser,
      makeOrganization,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      try {
        await makeInternalMcpCatalog({
          id: ARCHESTRA_MCP_CATALOG_ID,
          name: "Archestra",
          serverType: "builtin",
          scope: "org",
        });
      } catch {
        // The built-in catalog may already be seeded in this test database.
      }
      await makeMcpServer({
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        scope: "org",
      });
      await makeTool({
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        name: "open_panel",
        meta: uiMeta("ui://archestra/panel.html"),
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: org.id,
      });
      expect(res.some((r) => r.catalogId === ARCHESTRA_MCP_CATALOG_ID)).toBe(
        false,
      );
    });

    test("hides another user's personal-scope catalog, but its author sees it (no admin bypass)", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const owner = await makeUser();
      const caller = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Private",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "personal",
        authorId: owner.id,
      });
      // The author's own personal install (the only thing that makes it listable
      // to them); the caller has no accessible install of it.
      const install = await makeMcpServer({
        catalogId: catalog.id,
        scope: "personal",
        ownerId: owner.id,
      });
      await McpServerUserModel.assignUserToMcpServer(install.id, owner.id);
      await makeTool({
        catalogId: catalog.id,
        name: "draw",
        meta: uiMeta("ui://private/app.html"),
      });

      // The caller (even as an org admin — there is no bypass) does not see it.
      const asOther = await McpServerModel.findUiCapableForCaller({
        userId: caller.id,
        organizationId: mustExist(catalog.organizationId),
      });
      expect(asOther.some((r) => r.catalogId === catalog.id)).toBe(false);

      // The author does — proving the filter isn't hiding everything.
      const asAuthor = await McpServerModel.findUiCapableForCaller({
        userId: owner.id,
        organizationId: mustExist(catalog.organizationId),
      });
      expect(asAuthor.some((r) => r.catalogId === catalog.id)).toBe(true);
    });

    test("lists each of a catalog's ui:// tools as its own app, sorted by tool name", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Multi",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({
        catalogId: catalog.id,
        name: "b_second",
        meta: uiMeta("ui://multi/second.html"),
      });
      await makeTool({
        catalogId: catalog.id,
        name: "a_first",
        meta: uiMeta("ui://multi/first.html"),
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
      });
      const entries = res.filter((r) => r.catalogId === catalog.id);
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.toolName)).toEqual(["a_first", "b_second"]);
      expect(entries.map((e) => e.resourceUri)).toEqual([
        "ui://multi/first.html",
        "ui://multi/second.html",
      ]);
      // Every app of the same server carries the catalog display name, not a slug.
      expect(entries.every((e) => e.serverName === "Multi")).toBe(true);
    });

    test("detects the legacy flat ui/resourceUri metadata key", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Legacy",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({
        catalogId: catalog.id,
        name: "draw",
        meta: { _meta: { "ui/resourceUri": "ui://legacy/app.html" } },
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
      });
      expect(res.find((r) => r.catalogId === catalog.id)?.resourceUri).toBe(
        "ui://legacy/app.html",
      );
    });

    test("search filters by catalog name", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Searchable Widget",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({
        catalogId: catalog.id,
        name: "draw",
        meta: uiMeta("ui://sw/app.html"),
      });

      const hit = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
        search: "widget",
      });
      expect(hit.some((r) => r.catalogId === catalog.id)).toBe(true);

      const miss = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
        search: "no-such-server-xyz",
      });
      expect(miss.some((r) => r.catalogId === catalog.id)).toBe(false);
    });

    test("search filters by tool name", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Plain Server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({
        catalogId: catalog.id,
        name: "special_widget",
        meta: uiMeta("ui://ps/app.html"),
      });

      const hit = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
        search: "special_widget",
      });
      expect(hit.some((r) => r.catalogId === catalog.id)).toBe(true);
    });

    test("excludes a tool whose resourceUri is not a ui:// scheme", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const catalog = await makeInternalMcpCatalog({
        name: "Sneaky",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({
        catalogId: catalog.id,
        name: "draw",
        meta: uiMeta("https://evil.example/x.html"),
      });

      const res = await McpServerModel.findUiCapableForCaller({
        userId: user.id,
        organizationId: mustExist(catalog.organizationId),
      });
      expect(res.some((r) => r.catalogId === catalog.id)).toBe(false);
    });
  });

  describe("oauth refresh failure persistence", () => {
    test("persists the terminal failure trio and clears all three", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const failedAt = new Date();

      const failed = await McpServerModel.update(server.id, {
        oauthRefreshError: "refresh_failed",
        oauthRefreshErrorMessage: "invalid_grant",
        oauthRefreshErrorDescription: "The refresh token is invalid",
        oauthRefreshFailedAt: failedAt,
      });
      expect(failed?.oauthRefreshError).toBe("refresh_failed");
      expect(failed?.oauthRefreshErrorMessage).toBe("invalid_grant");
      expect(failed?.oauthRefreshErrorDescription).toBe(
        "The refresh token is invalid",
      );
      expect(failed?.oauthRefreshFailedAt?.getTime()).toBe(failedAt.getTime());

      const cleared = await McpServerModel.update(server.id, {
        oauthRefreshError: null,
        oauthRefreshErrorMessage: null,
        oauthRefreshErrorDescription: null,
        oauthRefreshFailedAt: null,
      });
      expect(cleared?.oauthRefreshError).toBeNull();
      expect(cleared?.oauthRefreshErrorMessage).toBeNull();
      expect(cleared?.oauthRefreshErrorDescription).toBeNull();
      expect(cleared?.oauthRefreshFailedAt).toBeNull();
    });
  });

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  describe("lastUsedAt tracking", () => {
    const getRow = async (id: string) => {
      const [row] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, id));
      return mustExist(row);
    };

    const setLastUsedAt = (id: string, lastUsedAt: Date | null) =>
      db
        .update(schema.mcpServersTable)
        .set({ lastUsedAt })
        .where(eq(schema.mcpServersTable.id, id));

    describe("updateLastUsed", () => {
      test("collapses repeated refreshes into one write per staleness window", async ({
        makeMcpServer,
      }) => {
        const server = await makeMcpServer();

        // The column defaults to now(), so a fresh row is already inside the
        // staleness window and the first refresh is a no-op
        const initial = (await getRow(server.id)).lastUsedAt;
        expect(initial).not.toBeNull();

        await McpServerModel.updateLastUsed(server.id);
        const afterFresh = (await getRow(server.id)).lastUsedAt;
        expect(afterFresh?.getTime()).toBe(initial?.getTime());

        // Stale timestamp: the refresh writes again
        const staleDate = new Date(
          Date.now() - 2 * MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
        );
        await setLastUsedAt(server.id, staleDate);

        await McpServerModel.updateLastUsed(server.id);
        const afterStale = (await getRow(server.id)).lastUsedAt;
        expect(afterStale?.getTime()).toBeGreaterThan(staleDate.getTime());

        // Freshly refreshed: the follow-up refresh inside the window skips
        await McpServerModel.updateLastUsed(server.id);
        const afterRepeat = (await getRow(server.id)).lastUsedAt;
        expect(afterRepeat?.getTime()).toBe(afterStale?.getTime());
      });

      test("refreshes a NULL lastUsedAt", async ({ makeMcpServer }) => {
        const server = await makeMcpServer();
        await setLastUsedAt(server.id, null);

        await McpServerModel.updateLastUsed(server.id);
        expect((await getRow(server.id)).lastUsedAt).not.toBeNull();
      });

      test("does not churn updatedAt", async ({ makeMcpServer }) => {
        const server = await makeMcpServer();
        const staleDate = new Date(
          Date.now() - 2 * MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
        );
        await setLastUsedAt(server.id, staleDate);
        const before = await getRow(server.id);

        await McpServerModel.updateLastUsed(server.id);

        const after = await getRow(server.id);
        // The refresh provably wrote lastUsedAt...
        expect(after.lastUsedAt?.getTime()).toBeGreaterThan(
          staleDate.getTime(),
        );
        // ...without drizzle's $onUpdate bumping updatedAt
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      });
    });

    describe("getLatestUsageAt", () => {
      test("returns max over COALESCE(last_used_at, created_at), ignoring soft-deleted rows", async ({
        makeMcpServer,
      }) => {
        const neverUsed = await makeMcpServer({ name: "Never Used" });
        const usedEarlier = await makeMcpServer({ name: "Used Earlier" });
        const usedLater = await makeMcpServer({ name: "Used Later" });
        const ids = [neverUsed.id, usedEarlier.id, usedLater.id];

        // neverUsed falls back to createdAt, which is the overall max
        const newestCreatedAt = new Date("2026-01-04T00:00:00Z");
        await db
          .update(schema.mcpServersTable)
          .set({ lastUsedAt: null, createdAt: newestCreatedAt })
          .where(eq(schema.mcpServersTable.id, neverUsed.id));
        await setLastUsedAt(usedEarlier.id, new Date("2026-01-02T00:00:00Z"));
        await setLastUsedAt(usedLater.id, new Date("2026-01-03T00:00:00Z"));

        const latest = await McpServerModel.getLatestUsageAt(ids);
        expect(latest?.getTime()).toBe(newestCreatedAt.getTime());

        // Soft-deleting the max holder drops it from the aggregate
        await db
          .update(schema.mcpServersTable)
          .set({ deletedAt: new Date() })
          .where(eq(schema.mcpServersTable.id, neverUsed.id));
        const afterDelete = await McpServerModel.getLatestUsageAt(ids);
        expect(afterDelete?.getTime()).toBe(
          new Date("2026-01-03T00:00:00Z").getTime(),
        );

        // Only soft-deleted / unknown ids -> null
        expect(
          await McpServerModel.getLatestUsageAt([neverUsed.id]),
        ).toBeNull();
      });

      test("returns null for empty input", async () => {
        expect(await McpServerModel.getLatestUsageAt([])).toBeNull();
      });
    });
  });
  // SPDX-SnippetEnd

  describe("reinstall reason invariant", () => {
    test("clearing reinstallRequired also nulls reinstallReason", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      await McpServerModel.update(server.id, {
        reinstallRequired: true,
        reinstallReason: "restart",
      });

      const cleared = await McpServerModel.update(server.id, {
        reinstallRequired: false,
      });
      expect(cleared?.reinstallRequired).toBe(false);
      expect(cleared?.reinstallReason).toBeNull();
    });

    test("flagging reinstallRequired without a reason defaults to 'new-input' (conservative: UI collects values)", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const flagged = await McpServerModel.update(server.id, {
        reinstallRequired: true,
      });
      expect(flagged?.reinstallRequired).toBe(true);
      expect(flagged?.reinstallReason).toBe("new-input");
    });

    test("flagging with an explicit reason persists it", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const flagged = await McpServerModel.update(server.id, {
        reinstallRequired: true,
        reinstallReason: "restart",
      });
      expect(flagged?.reinstallReason).toBe("restart");
    });

    test("an update not touching reinstallRequired leaves the reason alone", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      await McpServerModel.update(server.id, {
        reinstallRequired: true,
        reinstallReason: "restart",
      });

      const renamed = await McpServerModel.update(server.id, {
        name: "renamed-install",
      });
      expect(renamed?.reinstallRequired).toBe(true);
      expect(renamed?.reinstallReason).toBe("restart");
    });
  });

  describe("purgePersonalServersForUserInOrganization", () => {
    test("purges only installs on the organization's catalogs, credentials included", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeOrganization,
      makeUser,
    }) => {
      const user = await makeUser();
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const catalogA = await makeInternalMcpCatalog({
        organizationId: orgA.id,
        serverType: "remote",
      });
      const catalogB = await makeInternalMcpCatalog({
        organizationId: orgB.id,
        serverType: "remote",
      });
      const secretA = await SecretModel.create({
        name: "org-a-cred",
        secret: { access_token: "at-a" },
      });
      const inOrgA = await makeMcpServer({
        ownerId: user.id,
        scope: "personal",
        serverType: "remote",
        catalogId: catalogA.id,
        secretId: secretA.id,
      });
      const inOrgB = await makeMcpServer({
        ownerId: user.id,
        scope: "personal",
        serverType: "remote",
        catalogId: catalogB.id,
      });

      const purged =
        await McpServerModel.purgePersonalServersForUserInOrganization(
          user.id,
          orgA.id,
        );

      expect(purged).toEqual([inOrgA.id]);
      expect(await McpServerModel.findById(inOrgA.id)).toBeNull();
      expect(await SecretModel.findById(secretA.id)).toBeNull();
      expect(await McpServerModel.findById(inOrgB.id)).not.toBeNull();
    });

    test("leaves installs on catalogs without an organization alone", async ({
      makeMcpServer,
      makeOrganization,
      makeUser,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      // No creation context — the catalog carries no organization_id, like
      // legacy/system-seeded entries, so it cannot be attributed to the org.
      const orgLessCatalog = await InternalMcpCatalogModel.create({
        name: "org-less-catalog",
        serverType: "remote",
      });
      const install = await makeMcpServer({
        ownerId: user.id,
        scope: "personal",
        serverType: "remote",
        catalogId: orgLessCatalog.id,
      });

      const purged =
        await McpServerModel.purgePersonalServersForUserInOrganization(
          user.id,
          org.id,
        );

      expect(purged).toEqual([]);
      expect(await McpServerModel.findById(install.id)).not.toBeNull();
    });
  });
});
