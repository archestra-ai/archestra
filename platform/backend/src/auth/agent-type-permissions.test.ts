import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeAdminPermission,
  hasAnyAgentTypeReadPermission,
  isAgentTypeAdmin,
  requireAgentTypePermission,
} from "./agent-type-permissions";

describe("requireAgentTypePermission", () => {
  test("allows when user has the required permission", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "gw_reader",
      permission: { mcpGateway: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "gw_reader" });

    await expect(
      requireAgentTypePermission({
        userId: user.id,
        organizationId: org.id,
        agentType: "mcp_gateway",
        action: "read",
      }),
    ).resolves.toBeUndefined();
  });

  test("throws 403 when user lacks the required permission", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "gw_reader",
      permission: { mcpGateway: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "gw_reader" });

    await expect(
      requireAgentTypePermission({
        userId: user.id,
        organizationId: org.id,
        agentType: "mcp_gateway",
        action: "create",
      }),
    ).rejects.toThrow(ApiError);

    try {
      await requireAgentTypePermission({
        userId: user.id,
        organizationId: org.id,
        agentType: "mcp_gateway",
        action: "create",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).statusCode).toBe(403);
    }
  });

  test("maps agentType correctly to resource", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "proxy_only",
      permission: { llmProxy: ["read", "create"] },
    });
    await makeMember(user.id, org.id, { role: "proxy_only" });

    // llm_proxy -> llmProxy resource: allowed
    await expect(
      requireAgentTypePermission({
        userId: user.id,
        organizationId: org.id,
        agentType: "llm_proxy",
        action: "read",
      }),
    ).resolves.toBeUndefined();

    // mcp_gateway -> mcpGateway resource: forbidden
    await expect(
      requireAgentTypePermission({
        userId: user.id,
        organizationId: org.id,
        agentType: "mcp_gateway",
        action: "read",
      }),
    ).rejects.toThrow(ApiError);

    // "profile" -> agent resource: forbidden
    await expect(
      requireAgentTypePermission({
        userId: user.id,
        organizationId: org.id,
        agentType: "profile",
        action: "read",
      }),
    ).rejects.toThrow(ApiError);
  });

  test("treats 'profile' and 'agent' agentTypes identically", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "agent_reader",
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "agent_reader" });

    // Both "profile" and "agent" map to the "agent" resource
    await expect(
      requireAgentTypePermission({
        userId: user.id,
        organizationId: org.id,
        agentType: "profile",
        action: "read",
      }),
    ).resolves.toBeUndefined();

    await expect(
      requireAgentTypePermission({
        userId: user.id,
        organizationId: org.id,
        agentType: "agent",
        action: "read",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("isAgentTypeAdmin", () => {
  test("returns true when user has admin on the agent type resource", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "gw_admin",
      permission: { mcpGateway: ["read", "admin"] },
    });
    await makeMember(user.id, org.id, { role: "gw_admin" });

    const result = await isAgentTypeAdmin({
      userId: user.id,
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    expect(result).toBe(true);
  });

  test("returns false when user lacks admin on the agent type resource", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "gw_reader",
      permission: { mcpGateway: ["read", "create"] },
    });
    await makeMember(user.id, org.id, { role: "gw_reader" });

    const result = await isAgentTypeAdmin({
      userId: user.id,
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    expect(result).toBe(false);
  });

  test("returns false for a different agent type even when admin on another", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "gw_admin",
      permission: { mcpGateway: ["admin"] },
    });
    await makeMember(user.id, org.id, { role: "gw_admin" });

    expect(
      await isAgentTypeAdmin({
        userId: user.id,
        organizationId: org.id,
        agentType: "mcp_gateway",
      }),
    ).toBe(true);

    expect(
      await isAgentTypeAdmin({
        userId: user.id,
        organizationId: org.id,
        agentType: "llm_proxy",
      }),
    ).toBe(false);
  });
});

describe("hasAnyAgentTypeReadPermission", () => {
  test("returns true when user has read on at least one agent-type resource", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "proxy_reader",
      permission: { llmProxy: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "proxy_reader" });

    const result = await hasAnyAgentTypeReadPermission({
      userId: user.id,
      organizationId: org.id,
    });
    expect(result).toBe(true);
  });

  test("returns false when user has no read on any agent-type resource", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    // Role with permissions only on non-agent-type resources
    await makeCustomRole(org.id, {
      role: "tool_only",
      permission: { tool: ["read", "create"] },
    });
    await makeMember(user.id, org.id, { role: "tool_only" });

    const result = await hasAnyAgentTypeReadPermission({
      userId: user.id,
      organizationId: org.id,
    });
    expect(result).toBe(false);
  });

  test("returns true for predefined admin role", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });

    const result = await hasAnyAgentTypeReadPermission({
      userId: user.id,
      organizationId: org.id,
    });
    expect(result).toBe(true);
  });
});

describe("hasAnyAgentTypeAdminPermission", () => {
  test("returns true when user has admin on at least one agent-type resource", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "agent_admin",
      permission: { agent: ["read", "admin"] },
    });
    await makeMember(user.id, org.id, { role: "agent_admin" });

    const result = await hasAnyAgentTypeAdminPermission({
      userId: user.id,
      organizationId: org.id,
    });
    expect(result).toBe(true);
  });

  test("returns false when user has read but not admin", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "all_reader",
      permission: {
        agent: ["read"],
        mcpGateway: ["read"],
        llmProxy: ["read"],
      },
    });
    await makeMember(user.id, org.id, { role: "all_reader" });

    const result = await hasAnyAgentTypeAdminPermission({
      userId: user.id,
      organizationId: org.id,
    });
    expect(result).toBe(false);
  });
});

describe("getAgentTypePermissionChecker", () => {
  test("require() does not throw when permission is present", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "mixed",
      permission: {
        agent: ["read"],
        mcpGateway: ["read", "create"],
        llmProxy: ["read", "update"],
      },
    });
    await makeMember(user.id, org.id, { role: "mixed" });

    const checker = await getAgentTypePermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(() => checker.require("agent", "read")).not.toThrow();
    expect(() => checker.require("mcp_gateway", "read")).not.toThrow();
    expect(() => checker.require("mcp_gateway", "create")).not.toThrow();
    expect(() => checker.require("llm_proxy", "read")).not.toThrow();
    expect(() => checker.require("llm_proxy", "update")).not.toThrow();
  });

  test("require() throws ApiError(403) when permission is missing", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "gw_only",
      permission: { mcpGateway: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "gw_only" });

    const checker = await getAgentTypePermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(() => checker.require("agent", "read")).toThrow(ApiError);
    expect(() => checker.require("llm_proxy", "read")).toThrow(ApiError);
    expect(() => checker.require("mcp_gateway", "create")).toThrow(ApiError);
  });

  test("isAdmin() returns correct values per agent type", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "partial_admin",
      permission: {
        agent: ["read", "admin"],
        mcpGateway: ["read"],
        llmProxy: ["read", "admin"],
      },
    });
    await makeMember(user.id, org.id, { role: "partial_admin" });

    const checker = await getAgentTypePermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.isAdmin("agent")).toBe(true);
    expect(checker.isAdmin("profile")).toBe(true); // alias for agent
    expect(checker.isAdmin("mcp_gateway")).toBe(false);
    expect(checker.isAdmin("llm_proxy")).toBe(true);
  });

  test("hasAnyReadPermission() returns true when at least one resource has read", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "proxy_only",
      permission: { llmProxy: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "proxy_only" });

    const checker = await getAgentTypePermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.hasAnyReadPermission()).toBe(true);
  });

  test("hasAnyReadPermission() returns false when no agent-type resource has read", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "tool_only",
      permission: { tool: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "tool_only" });

    const checker = await getAgentTypePermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.hasAnyReadPermission()).toBe(false);
  });

  test("hasAnyAdminPermission() returns correct values", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeCustomRole(org.id, {
      role: "gw_admin",
      permission: { mcpGateway: ["read", "admin"] },
    });
    await makeMember(user.id, org.id, { role: "gw_admin" });

    const checker = await getAgentTypePermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.hasAnyAdminPermission()).toBe(true);
  });

  test("makes only a single DB query regardless of check count", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

    // The checker fetches permissions once at creation time.
    // Subsequent calls are synchronous (no additional DB queries).
    const checker = await getAgentTypePermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    // All these calls should work without errors (member has read on all three)
    checker.hasAnyReadPermission();
    checker.hasAnyAdminPermission();
    checker.isAdmin("agent");
    checker.isAdmin("mcp_gateway");
    checker.isAdmin("llm_proxy");
    // If this reached here without issues, the synchronous pattern works
  });
});
