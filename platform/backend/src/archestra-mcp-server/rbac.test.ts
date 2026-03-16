// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { vi } from "vitest";
import { UserModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { ArchestraContext } from ".";
import { ALL_TOOL_SHORT_NAMES } from ".";
import {
  checkToolPermission,
  filterToolNamesByPermission,
  TOOL_PERMISSIONS,
} from "./rbac";

const t = (name: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${name}`;

// === Permission map completeness ===

describe("TOOL_PERMISSIONS map", () => {
  test("has an entry for every registered tool", () => {
    for (const shortName of ALL_TOOL_SHORT_NAMES) {
      expect(TOOL_PERMISSIONS).toHaveProperty(shortName);
    }
  });

  test("every entry has valid resource and action or is null", () => {
    for (const [name, perm] of Object.entries(TOOL_PERMISSIONS)) {
      if (perm === null) continue;
      expect(perm, `${name} should have resource`).toHaveProperty("resource");
      expect(perm, `${name} should have action`).toHaveProperty("action");
      expect(typeof perm.resource).toBe("string");
      expect(typeof perm.action).toBe("string");
    }
  });
});

// === checkToolPermission ===

describe("checkToolPermission", () => {
  let adminContext: ArchestraContext;
  let memberContext: ArchestraContext;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const agent = await makeAgent({ name: "Test Agent" });

    adminContext = {
      agent: { id: agent.id, name: agent.name },
      organizationId: org.id,
      userId: admin.id,
    };
    memberContext = {
      agent: { id: agent.id, name: agent.name },
      organizationId: org.id,
      userId: member.id,
    };
  });

  test("allows tool with null permission for any user", async () => {
    const result = await checkToolPermission(t("whoami"), memberContext);
    expect(result).toBeNull();
  });

  test("allows admin to use any tool", async () => {
    const result = await checkToolPermission(
      t("create_knowledge_base"),
      adminContext,
    );
    expect(result).toBeNull();
  });

  test("allows member to use tools they have permission for", async () => {
    // Members have knowledgeBase:read by default
    const result = await checkToolPermission(
      t("get_knowledge_bases"),
      memberContext,
    );
    expect(result).toBeNull();
  });

  test("denies tool when user lacks permission", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    // Create a user with a custom role that has NO knowledgeBase permissions
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({ name: "Test Agent" });

    const restrictedContext: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      organizationId: org.id,
      userId: user.id,
    };

    const result = await checkToolPermission(
      t("create_knowledge_base"),
      restrictedContext,
    );
    expect(result).not.toBeNull();
    expect((result?.content[0] as any).text).toContain(
      "do not have permission",
    );
  });

  test("returns error when userId is missing", async () => {
    const noUserCtx: ArchestraContext = {
      agent: { id: "a", name: "a" },
      organizationId: "org",
    };
    const result = await checkToolPermission(
      t("create_knowledge_base"),
      noUserCtx,
    );
    expect(result).not.toBeNull();
    expect((result?.content[0] as any).text).toContain(
      "User context not available",
    );
  });

  test("returns null for non-Archestra tool names", async () => {
    const result = await checkToolPermission(
      "some_external_tool",
      memberContext,
    );
    expect(result).toBeNull();
  });
});

// === filterToolNamesByPermission ===

describe("filterToolNamesByPermission", () => {
  test("includes non-Archestra tools regardless of permissions", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const result = await filterToolNamesByPermission(
      ["external_server__some_tool", t("whoami")],
      user.id,
      org.id,
    );
    expect(result.has("external_server__some_tool")).toBe(true);
    expect(result.has(t("whoami"))).toBe(true);
  });

  test("filters out tools user lacks permission for", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    // Custom role with only agent:read — no knowledgeBase permissions
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });

    const result = await filterToolNamesByPermission(
      [
        t("whoami"),
        t("get_agent"),
        t("create_knowledge_base"),
        t("get_knowledge_bases"),
      ],
      user.id,
      org.id,
    );

    expect(result.has(t("whoami"))).toBe(true); // null perm
    expect(result.has(t("get_agent"))).toBe(true); // agent:read ✓
    expect(result.has(t("create_knowledge_base"))).toBe(false); // knowledgeBase:create ✗
    expect(result.has(t("get_knowledge_bases"))).toBe(false); // knowledgeBase:read ✗
  });

  test("admin sees all tools", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });

    const allTools = [
      t("whoami"),
      t("create_agent"),
      t("create_knowledge_base"),
      t("delete_limit"),
      t("create_tool_invocation_policy"),
    ];

    const result = await filterToolNamesByPermission(
      allTools,
      admin.id,
      org.id,
    );
    expect(result.size).toBe(allTools.length);
  });

  test("handles missing userId gracefully", async () => {
    const result = await filterToolNamesByPermission(
      [t("whoami"), t("create_agent"), "external__tool"],
      undefined,
      "org-id",
    );

    // Only null-perm Archestra tools and non-Archestra tools should be included
    expect(result.has(t("whoami"))).toBe(true);
    expect(result.has("external__tool")).toBe(true);
    expect(result.has(t("create_agent"))).toBe(false);
  });

  test("loads user permissions once for repeated permission checks", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });

    const permissionsSpy = vi.spyOn(UserModel, "getUserPermissions");

    const result = await filterToolNamesByPermission(
      [
        t("create_agent"),
        t("get_agent"),
        t("create_knowledge_base"),
        t("get_knowledge_bases"),
      ],
      user.id,
      org.id,
    );

    expect(result.size).toBe(4);
    expect(permissionsSpy).toHaveBeenCalledTimes(1);
  });
});
