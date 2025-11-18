import { describe, expect, test } from "@/test";
import McpServerUserModel from "./mcp-server-user";

describe("McpServerUserModel", () => {
  describe("getUserDetailsForMcpServer", () => {
    test("returns user details for a single MCP server", async ({
      makeUser,
      makeMcpServer,
    }) => {
      const user1 = await makeUser({ email: "user1@test.com" });
      const user2 = await makeUser({ email: "user2@test.com" });
      const mcpServer = await makeMcpServer();

      await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user1.id);
      await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user2.id);

      const userDetails = await McpServerUserModel.getUserDetailsForMcpServer(
        mcpServer.id,
      );

      expect(userDetails).toHaveLength(2);
      expect(userDetails.map((u) => u.userId)).toContain(user1.id);
      expect(userDetails.map((u) => u.userId)).toContain(user2.id);
      expect(userDetails.map((u) => u.email)).toContain("user1@test.com");
      expect(userDetails.map((u) => u.email)).toContain("user2@test.com");
    });

    test("returns empty array when MCP server has no users", async ({
      makeMcpServer,
    }) => {
      const mcpServer = await makeMcpServer();
      const userDetails = await McpServerUserModel.getUserDetailsForMcpServer(
        mcpServer.id,
      );
      expect(userDetails).toHaveLength(0);
    });
  });

  describe("getUserDetailsForMcpServers", () => {
    test("returns user details for multiple MCP servers in bulk", async ({
      makeUser,
      makeMcpServer,
    }) => {
      const user1 = await makeUser({ email: "user1@test.com" });
      const user2 = await makeUser({ email: "user2@test.com" });
      const user3 = await makeUser({ email: "user3@test.com" });

      const mcpServer1 = await makeMcpServer();
      const mcpServer2 = await makeMcpServer();
      const mcpServer3 = await makeMcpServer();

      await McpServerUserModel.assignUserToMcpServer(mcpServer1.id, user1.id);
      await McpServerUserModel.assignUserToMcpServer(mcpServer1.id, user2.id);
      await McpServerUserModel.assignUserToMcpServer(mcpServer2.id, user3.id);
      // mcpServer3 has no users

      const userDetailsMap =
        await McpServerUserModel.getUserDetailsForMcpServers([
          mcpServer1.id,
          mcpServer2.id,
          mcpServer3.id,
        ]);

      expect(userDetailsMap.size).toBe(3);

      const server1Users = userDetailsMap.get(mcpServer1.id);
      expect(server1Users).toHaveLength(2);
      expect(server1Users?.map((u) => u.userId)).toContain(user1.id);
      expect(server1Users?.map((u) => u.userId)).toContain(user2.id);
      expect(server1Users?.map((u) => u.email)).toContain("user1@test.com");
      expect(server1Users?.map((u) => u.email)).toContain("user2@test.com");

      const server2Users = userDetailsMap.get(mcpServer2.id);
      expect(server2Users).toHaveLength(1);
      expect(server2Users?.[0].userId).toBe(user3.id);
      expect(server2Users?.[0].email).toBe("user3@test.com");

      const server3Users = userDetailsMap.get(mcpServer3.id);
      expect(server3Users).toHaveLength(0);
    });

    test("returns empty map for empty MCP server IDs array", async () => {
      const userDetailsMap =
        await McpServerUserModel.getUserDetailsForMcpServers([]);
      expect(userDetailsMap.size).toBe(0);
    });
  });

  describe("getUserPersonalMcpServerIds", () => {
    test("returns MCP server IDs for user's personal access", async ({
      makeUser,
      makeMcpServer,
    }) => {
      const user = await makeUser();
      const mcpServer1 = await makeMcpServer();
      const mcpServer2 = await makeMcpServer();

      await McpServerUserModel.assignUserToMcpServer(mcpServer1.id, user.id);
      await McpServerUserModel.assignUserToMcpServer(mcpServer2.id, user.id);

      const serverIds = await McpServerUserModel.getUserPersonalMcpServerIds(
        user.id,
      );

      expect(serverIds).toHaveLength(2);
      expect(serverIds).toContain(mcpServer1.id);
      expect(serverIds).toContain(mcpServer2.id);
    });

    test("returns empty array when user has no personal MCP servers", async ({
      makeUser,
    }) => {
      const user = await makeUser();
      const serverIds = await McpServerUserModel.getUserPersonalMcpServerIds(
        user.id,
      );
      expect(serverIds).toHaveLength(0);
    });
  });

  describe("userHasPersonalMcpServerAccess", () => {
    test("returns true when user has personal access", async ({
      makeUser,
      makeMcpServer,
    }) => {
      const user = await makeUser();
      const mcpServer = await makeMcpServer();

      await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

      const hasAccess = await McpServerUserModel.userHasPersonalMcpServerAccess(
        user.id,
        mcpServer.id,
      );

      expect(hasAccess).toBe(true);
    });

    test("returns false when user has no personal access", async ({
      makeUser,
      makeMcpServer,
    }) => {
      const user = await makeUser();
      const mcpServer = await makeMcpServer();

      const hasAccess = await McpServerUserModel.userHasPersonalMcpServerAccess(
        user.id,
        mcpServer.id,
      );

      expect(hasAccess).toBe(false);
    });
  });

  describe("assignUserToMcpServer", () => {
    test("assigns user to MCP server", async ({ makeUser, makeMcpServer }) => {
      const user = await makeUser();
      const mcpServer = await makeMcpServer();

      await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

      const hasAccess = await McpServerUserModel.userHasPersonalMcpServerAccess(
        user.id,
        mcpServer.id,
      );

      expect(hasAccess).toBe(true);
    });

    test("is idempotent - does not fail on duplicate assignment", async ({
      makeUser,
      makeMcpServer,
    }) => {
      const user = await makeUser();
      const mcpServer = await makeMcpServer();

      await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);
      await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

      const hasAccess = await McpServerUserModel.userHasPersonalMcpServerAccess(
        user.id,
        mcpServer.id,
      );

      expect(hasAccess).toBe(true);
    });
  });
});
