import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import type { AgentScope } from "@/types";
import { ApiError } from "@/types";
import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeAdminPermission,
  hasAnyAgentTypeReadPermission,
  isAgentTypeAdmin,
  requireAgentModifyPermission,
  requireAgentTypePermission,
  requireScopedModifyPermission,
} from "./agent-type-permissions";

describe("requireAgentTypePermission", () => {
  test("allows when user has the required permission", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization({ legacyPermissions: true });
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
    const org = await makeOrganization({ legacyPermissions: true });
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
    const org = await makeOrganization({ legacyPermissions: true });
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
    const org = await makeOrganization({ legacyPermissions: true });
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
  test("returns false when user lacks admin on the agent type resource", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization({ legacyPermissions: true });
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
});

describe("hasAnyAgentTypeReadPermission", () => {
  test("returns true when user has read on at least one agent-type resource", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization({ legacyPermissions: true });
    await makeCustomRole(org.id, {
      role: "gw_reader",
      permission: { mcpGateway: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "gw_reader" });

    const result = await hasAnyAgentTypeReadPermission({
      userId: user.id,
      organizationId: org.id,
    });
    expect(result).toBe(true);
  });

  test("llmProxy read alone does not count as agent-type read", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization({ legacyPermissions: true });
    // The LLM Proxy has its own management routes; llmProxy permissions grant
    // nothing on the generic agent surface.
    await makeCustomRole(org.id, {
      role: "llm_only",
      permission: { llmProxy: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "llm_only" });

    const result = await hasAnyAgentTypeReadPermission({
      userId: user.id,
      organizationId: org.id,
    });
    expect(result).toBe(false);
  });

  test("returns false when user has no read on any agent-type resource", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization({ legacyPermissions: true });
    // Role with permissions only on non-agent-type resources
    await makeCustomRole(org.id, {
      role: "tool_only",
      permission: { toolPolicy: ["read", "create"] },
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
    const org = await makeOrganization({ legacyPermissions: true });
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });

    const result = await hasAnyAgentTypeReadPermission({
      userId: user.id,
      organizationId: org.id,
    });
    expect(result).toBe(true);
  });
});

describe("hasAnyAgentTypeAdminPermission", () => {
  test("returns false when user has read but not admin", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization({ legacyPermissions: true });
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
    const org = await makeOrganization({ legacyPermissions: true });
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
    const org = await makeOrganization({ legacyPermissions: true });
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

  test("hasAnyReadPermission() returns true when at least one resource has read", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization({ legacyPermissions: true });
    await makeCustomRole(org.id, {
      role: "gw_only",
      permission: { mcpGateway: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "gw_only" });

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
    const org = await makeOrganization({ legacyPermissions: true });
    await makeCustomRole(org.id, {
      role: "tool_only",
      permission: { toolPolicy: ["read"] },
    });
    await makeMember(user.id, org.id, { role: "tool_only" });

    const checker = await getAgentTypePermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.hasAnyReadPermission()).toBe(false);
  });

  test("makes only a single DB query regardless of check count", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization({ legacyPermissions: true });
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

describe("requireAgentModifyPermission", () => {
  // The agent's scope, teams and author, and the role's admin/team-admin
  // actions, no longer decide anything: only a grant on the agent (or at `*`)
  // lets a caller modify it.
  test("authorizes from grants alone", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const context = { userId: user.id, organizationId: org.id };
    const modify = async (action: "update" | "delete" | "manage-permissions") =>
      requireAgentModifyPermission({
        checker: await getAgentTypePermissionChecker(context),
        agentType: agent.agentType,
        agentId: agent.id,
        action,
      });

    await expect(modify("update")).rejects.toThrow(ApiError);

    const key = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const current = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: current?.revision ?? 0,
      grants: [
        ...(current?.grants ?? []),
        {
          subject: { type: "user", id: user.id },
          actions: ["read", "use", "update"],
        },
      ],
    });

    await expect(modify("update")).resolves.toBeUndefined();
    await expect(modify("delete")).rejects.toThrow(ApiError);
    await expect(modify("manage-permissions")).rejects.toThrow(
      "You do not have permission to manage access to this resource",
    );
  });

  test("a role holding the retired admin actions gains nothing from them", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const role = await makeCustomRole(org.id, {
      role: "legacy_agent_admin",
      permission: { agent: ["read", "update", "team-admin", "admin"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const checker = await getAgentTypePermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.isAdmin("agent")).toBe(false);
    expect(checker.hasAnyAdminPermission()).toBe(false);
    expect(() =>
      requireAgentModifyPermission({
        checker,
        agentType: "agent",
        agentId: agent.id,
        action: "update",
      }),
    ).toThrow(ApiError);
  });
});

describe("requireScopedModifyPermission", () => {
  test("fails closed on an out-of-union scope", () => {
    // a corrupted/unknown scope must be denied, not fall through and grant
    expect(() =>
      requireScopedModifyPermission({
        isAdmin: false,
        isTeamAdmin: false,
        scope: "bogus" as AgentScope,
        authorId: "author-id",
        resourceTeamIds: [],
        userTeamIds: [],
        userId: "author-id",
        resourceLabel: "skill",
      }),
    ).toThrow(ApiError);
  });

  test("admins still bypass before the scope switch", () => {
    expect(() =>
      requireScopedModifyPermission({
        isAdmin: true,
        isTeamAdmin: false,
        scope: "bogus" as AgentScope,
        authorId: null,
        resourceTeamIds: [],
        userTeamIds: [],
        userId: "u1",
        resourceLabel: "skill",
      }),
    ).not.toThrow();
  });
});

describe("scoped agent authority", () => {
  test("wildcard update authority follows resource type and disappears on revocation", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, { permission: {} });
    await makeMember(user.id, org.id, { role: role.role });
    const key = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: "*",
    };
    const current = await ResourcePermissionPolicyModel.find(key);
    const saved = await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: current?.revision ?? 0,
      grants: [{ subject: { type: "role", id: role.id }, actions: ["update"] }],
    });
    expect(saved).not.toBeNull();
    const context = { organizationId: org.id, userId: user.id };
    const checker = await getAgentTypePermissionChecker(context);
    expect(checker.isAdmin("agent")).toBe(true);
    expect(checker.isAdmin("profile")).toBe(true);
    expect(checker.isAdmin("mcp_gateway")).toBe(false);
    expect(checker.hasAnyAdminPermission()).toBe(true);
    expect(await isAgentTypeAdmin({ ...context, agentType: "agent" })).toBe(
      true,
    );
    expect(await hasAnyAgentTypeAdminPermission(context)).toBe(true);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: saved?.revision ?? 0,
      grants: [],
    });
    expect(await hasAnyAgentTypeAdminPermission(context)).toBe(false);
  });

  test("the built-in Editor has no implicit team-wide or wildcard authority", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: EDITOR_ROLE_NAME });
    const checker = await getAgentTypePermissionChecker({
      organizationId: org.id,
      userId: user.id,
    });
    expect(checker.isAdmin("agent")).toBe(false);
    expect(checker.hasAnyAdminPermission()).toBe(false);
  });
});
