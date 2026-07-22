import { TOOL_RUN_COMMAND_FULL_NAME } from "@archestra/shared";
import config from "@/config";
import { ToolModel } from "@/models";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { isSkillSandboxAvailableForAgent } from "./skill-sandbox-availability";

describe("isSkillSandboxAvailableForAgent", () => {
  let originalEnabled: boolean;

  beforeEach(() => {
    originalEnabled = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
  });

  afterEach(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalEnabled;
  });

  test("true when feature on, caller has sandbox:execute, and tools are assigned", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { sandbox: ["execute"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({ name: "Sandbox Agent" });
    // seeding pulls from getArchestraMcpTools(), which only includes the
    // sandbox tools while the feature is enabled — hence the flag is set first.
    await seedAndAssignArchestraTools(agent.id);

    expect(
      await isSkillSandboxAvailableForAgent({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
      }),
    ).toBe(true);
  });

  test("false when the sandbox tools are not assigned to the agent", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { sandbox: ["execute"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({ name: "Bare Agent" });

    expect(
      await isSkillSandboxAvailableForAgent({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
      }),
    ).toBe(false);
  });

  test("true via accessAllTools dynamic access even without the sandbox tools assigned", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { sandbox: ["execute"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    // No sandbox tools assigned, but accessAllTools lets a real user run them
    // via dynamic dispatch, so the sandbox is genuinely usable.
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Access-all Agent",
      accessAllTools: true,
    });

    expect(
      await isSkillSandboxAvailableForAgent({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
      }),
    ).toBe(true);
  });

  test("false for accessAllTools when a sandbox tool is excluded", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { sandbox: ["execute"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Access-all Agent",
      accessAllTools: true,
    });
    // Seed the built-in tool rows so run_command has an id to exclude.
    await seedAndAssignArchestraTools(agent.id);
    const runCommand = await ToolModel.findByName(TOOL_RUN_COMMAND_FULL_NAME);
    if (!runCommand) throw new Error("run_command tool not seeded");
    await agentToolExclusionsService.replaceExclusions({
      agentId: agent.id,
      organizationId: org.id,
      excludedToolIds: [runCommand.id],
    });

    // Dynamic access is on, but excluding a sandbox tool means dispatch would
    // refuse it — so the sandbox must not be advertised as available.
    expect(
      await isSkillSandboxAvailableForAgent({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
      }),
    ).toBe(false);
  });

  test("false for accessAllTools without sandbox:execute", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { skill: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Access-all Agent",
      accessAllTools: true,
    });

    expect(
      await isSkillSandboxAvailableForAgent({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
      }),
    ).toBe(false);
  });

  test("false when the feature is disabled, even with tools assigned", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { sandbox: ["execute"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({ name: "Sandbox Agent" });
    await seedAndAssignArchestraTools(agent.id);
    (config.skillsSandbox as { enabled: boolean }).enabled = false;

    expect(
      await isSkillSandboxAvailableForAgent({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
      }),
    ).toBe(false);
  });

  test("false without sandbox:execute", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    // skill:read but no sandbox:execute
    const role = await makeCustomRole(org.id, {
      permission: { skill: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({ name: "Sandbox Agent" });
    await seedAndAssignArchestraTools(agent.id);

    expect(
      await isSkillSandboxAvailableForAgent({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
      }),
    ).toBe(false);
  });

  test("false when no user context is available", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Sandbox Agent" });

    expect(
      await isSkillSandboxAvailableForAgent({
        userId: undefined,
        organizationId: org.id,
        agentId: agent.id,
      }),
    ).toBe(false);
  });

  test("false when no agent context is available", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { sandbox: ["execute"] },
    });
    await makeMember(user.id, org.id, { role: role.role });

    expect(
      await isSkillSandboxAvailableForAgent({
        userId: user.id,
        organizationId: org.id,
        agentId: undefined,
      }),
    ).toBe(false);
  });
});
