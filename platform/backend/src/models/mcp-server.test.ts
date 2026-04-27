import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import McpServerModel from "./mcp-server";
import McpServerUserModel from "./mcp-server-user";

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

    test("returns all servers to an admin regardless of scope", async ({
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

      const adminView = await McpServerModel.findAll(admin.id, true);
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
});
