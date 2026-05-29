import type { SkillPermissionChecker } from "@/auth/skill-permissions";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { isSkillSandboxAvailableForAgent } from "./skill-sandbox-availability";

const executor: SkillPermissionChecker = {
  canRead: true,
  canExecute: true,
  isAdmin: false,
  isTeamAdmin: false,
};

describe("isSkillSandboxAvailableForAgent", () => {
  let originalEnabled: boolean;

  beforeEach(() => {
    originalEnabled = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
  });

  afterEach(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalEnabled;
  });

  test("true when feature on, caller can execute, and tools are assigned", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent({ name: "Sandbox Agent" });
    // seeding pulls from getArchestraMcpTools(), which only includes the
    // sandbox tools while the feature is enabled — hence the flag is set first.
    await seedAndAssignArchestraTools(agent.id);

    expect(
      await isSkillSandboxAvailableForAgent({
        checker: executor,
        agentId: agent.id,
      }),
    ).toBe(true);
  });

  test("false when the sandbox tools are not assigned to the agent", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Bare Agent" });

    expect(
      await isSkillSandboxAvailableForAgent({
        checker: executor,
        agentId: agent.id,
      }),
    ).toBe(false);
  });

  test("false when the feature is disabled, even with tools assigned", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent({ name: "Sandbox Agent" });
    await seedAndAssignArchestraTools(agent.id);
    (config.skillsSandbox as { enabled: boolean }).enabled = false;

    expect(
      await isSkillSandboxAvailableForAgent({
        checker: executor,
        agentId: agent.id,
      }),
    ).toBe(false);
  });

  test("false without skill:execute", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent({ name: "Sandbox Agent" });
    await seedAndAssignArchestraTools(agent.id);

    expect(
      await isSkillSandboxAvailableForAgent({
        checker: { ...executor, canExecute: false },
        agentId: agent.id,
      }),
    ).toBe(false);
    expect(
      await isSkillSandboxAvailableForAgent({
        checker: null,
        agentId: agent.id,
      }),
    ).toBe(false);
  });

  test("false when no agent context is available", async () => {
    expect(
      await isSkillSandboxAvailableForAgent({
        checker: executor,
        agentId: undefined,
      }),
    ).toBe(false);
  });
});
