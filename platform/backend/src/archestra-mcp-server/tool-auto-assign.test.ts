import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
} from "@archestra/shared";
import config from "@/config";
import { OrganizationModel, ToolModel } from "@/models";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import type { Agent } from "@/types";
import {
  grantToolToAgent,
  isToolGrantApprovable,
  resolveToolGrant,
} from "./tool-auto-assign";

// resolveToolGrant decides whether an accessible-but-unassigned tool may be
// granted to the agent WITHOUT writing the assignment (the grant write happens
// later through the assign endpoint when the user confirms). isToolGrantApprovable
// is the chat gate: only an unassigned, grantable target prompts a grant approval.

describe("resolveToolGrant", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    agent = await makeAgent({ name: "Grant Agent", organizationId: org.id });
  });

  test("grantable for an accessible catalog tool when the user may modify the agent", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const outcome = await resolveToolGrant({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(outcome).toBe("grantable");
  });

  test("forbidden when the user can see the tool but cannot modify the agent", async ({
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMember,
    makeTool,
    makeUser,
  }) => {
    const memberUser = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"] },
    });
    await makeMember(memberUser.id, organizationId, { role: role.role });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const outcome = await resolveToolGrant({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId: memberUser.id,
      organizationId,
    });

    expect(outcome).toBe("forbidden");
  });

  test("unavailable when the org disables tool auto-assignment", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await OrganizationModel.patch(organizationId, {
      allowToolAutoAssignment: false,
    });

    const outcome = await resolveToolGrant({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(outcome).toBe("unavailable");
  });

  test("unavailable for sessions without a user (org/team tokens)", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const outcome = await resolveToolGrant({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId: undefined,
      organizationId,
    });

    expect(outcome).toBe("unavailable");
  });

  describe("sandbox built-in reserved-name resolution", () => {
    const originalSandboxEnabled = config.skillsSandbox.enabled;
    beforeAll(() => {
      (config.skillsSandbox as { enabled: boolean }).enabled = true;
    });
    afterAll(() => {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
    });

    test("unavailable when only a third-party row reuses the reserved name", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      // colliding third-party row, but the real Archestra catalog is NOT seeded
      const catalog = await makeInternalMcpCatalog({ organizationId });
      await makeTool({
        name: TOOL_RUN_COMMAND_FULL_NAME,
        catalogId: catalog.id,
      });

      const outcome = await resolveToolGrant({
        toolName: TOOL_RUN_COMMAND_FULL_NAME,
        agentId: agent.id,
        userId,
        organizationId,
      });

      expect(outcome).toBe("unavailable");
    });

    test("grantable once the Archestra-catalog row exists, even with a colliding row", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({ organizationId });
      await makeTool({
        name: TOOL_RUN_COMMAND_FULL_NAME,
        catalogId: catalog.id,
      });
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

      const outcome = await resolveToolGrant({
        toolName: TOOL_RUN_COMMAND_FULL_NAME,
        agentId: agent.id,
        userId,
        organizationId,
      });

      expect(outcome).toBe("grantable");
    });

    test("grants a sandbox built-in referenced by its short name", async () => {
      // The model and the run_tool dispatch use the short name (`run_command`);
      // the grant path must resolve it to the full Archestra row, not 404.
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

      const outcome = await grantToolToAgent({
        toolName: TOOL_RUN_COMMAND_SHORT_NAME,
        agentId: agent.id,
        userId,
        organizationId,
      });

      expect(outcome).toBe("grantable");
      const assigned = await ToolModel.getAssignedToolNames(agent.id);
      expect(assigned.has(TOOL_RUN_COMMAND_FULL_NAME)).toBe(true);
    });

    test("unavailable when the user lacks sandbox:execute", async ({
      makeCustomRole,
      makeMember,
      makeUser,
    }) => {
      // Catalog visibility alone must not let a user who cannot run the sandbox
      // grant run_command: per-tool RBAC (sandbox:execute) still gates it.
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      const memberUser = await makeUser();
      const role = await makeCustomRole(organizationId, {
        permission: { agent: ["read", "update"] },
      });
      await makeMember(memberUser.id, organizationId, { role: role.role });

      const outcome = await grantToolToAgent({
        toolName: TOOL_RUN_COMMAND_SHORT_NAME,
        agentId: agent.id,
        userId: memberUser.id,
        organizationId,
      });

      expect(outcome).toBe("unavailable");
      const assigned = await ToolModel.getAssignedToolNames(agent.id);
      expect(assigned.has(TOOL_RUN_COMMAND_FULL_NAME)).toBe(false);
    });
  });
});

describe("isToolGrantApprovable", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    agent = await makeAgent({ name: "Grant Agent", organizationId: org.id });
  });

  test("true for an unassigned, grantable target (short name resolved)", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const approvable = await isToolGrantApprovable({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(approvable).toBe(true);
  });

  test("false when the target is already assigned to the agent", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, tool.id);

    const approvable = await isToolGrantApprovable({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(approvable).toBe(false);
  });

  test("false when the user cannot modify the agent", async ({
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMember,
    makeTool,
    makeUser,
  }) => {
    const memberUser = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"] },
    });
    await makeMember(memberUser.id, organizationId, { role: role.role });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const approvable = await isToolGrantApprovable({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId: memberUser.id,
      organizationId,
    });

    expect(approvable).toBe(false);
  });
});

describe("grantToolToAgent", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    agent = await makeAgent({ name: "Grant Agent", organizationId: org.id });
  });

  test("assigns a grantable tool to the agent", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const outcome = await grantToolToAgent({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(outcome).toBe("grantable");
    const assigned = await ToolModel.getAssignedToolNames(agent.id);
    expect(assigned.has("github__search_repositories")).toBe(true);
  });

  test("does not assign when the user cannot modify the agent", async ({
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMember,
    makeTool,
    makeUser,
  }) => {
    const memberUser = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"] },
    });
    await makeMember(memberUser.id, organizationId, { role: role.role });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const outcome = await grantToolToAgent({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId: memberUser.id,
      organizationId,
    });

    expect(outcome).toBe("forbidden");
    const assigned = await ToolModel.getAssignedToolNames(agent.id);
    expect(assigned.has("github__search_repositories")).toBe(false);
  });

  test("is idempotent when the tool is already assigned", async ({
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, tool.id);

    const outcome = await grantToolToAgent({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(outcome).toBe("grantable");
    const assigned = await ToolModel.getAssignedToolNames(agent.id);
    expect(assigned.has("github__search_repositories")).toBe(true);
  });
});
