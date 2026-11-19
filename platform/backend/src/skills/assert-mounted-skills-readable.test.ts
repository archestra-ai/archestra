import config from "@/config";
import {
  AgentModel,
  EnvironmentModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import { sandboxRuntimeService } from "@/sandbox-runtime/sandbox-runtime-service";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { expect, test, vi } from "@/test";
import { asSandboxId } from "@/types";
import { assertMountedSkillsReadable } from "./assert-mounted-skills-readable";

test("blocks replay after the mounted skill is removed from the agent policy", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeSkill,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id);
  const agent = await makeAgent({ organizationId: organization.id });
  const skill = await makeSkill(organization.id, {
    name: "mounted-skill",
    description: "A mounted skill",
    content: "Follow the mounted procedure.",
    metadata: {},
    sourceType: "manual",
    access: "org",
  });
  if (!skill) throw new Error("skill seed failed");
  const version = await SkillVersionModel.findBySkillAndVersion(
    skill.id,
    skill.latestVersion,
  );
  if (!version) throw new Error("skill version seed failed");
  const sandbox = await SkillSandboxModel.create({
    organizationId: organization.id,
    userId: user.id,
    conversationId: null,
    defaultCwd: "/home/sandbox",
  });
  await SkillSandboxReplayEventModel.appendSkillMount({
    sandboxId: sandbox.id,
    organizationId: organization.id,
    mount: {
      skillId: skill.id,
      skillName: skill.name,
      skillVersionId: version.id,
    },
  });

  expect(
    await assertMountedSkillsReadable({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId: organization.id,
      agentId: agent.id,
    }),
  ).toEqual({ ok: true });

  await AgentModel.setActivationSkillPolicyState({
    id: agent.id,
    mode: "manual",
    revision: 1,
  });

  expect(
    await assertMountedSkillsReadable({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId: organization.id,
      agentId: agent.id,
    }),
  ).toEqual({
    ok: false,
    code: "skill_agent_policy_revoked",
    reason:
      'the skill "mounted-skill" mounted in this sandbox is no longer enabled for this agent',
  });

  // The real runtime service must recheck the policy through its port before
  // any command reaches the external sandbox engine.
  config.skillsSandbox.enabled = true;
  const enabled = vi
    .spyOn(sandboxRuntimeService, "isEnabled", "get")
    .mockReturnValue(true);
  const execute = vi
    .spyOn(sandboxRuntimeService, "runCommand")
    .mockRejectedValue(new Error("unexpected engine call"));
  try {
    await expect(
      skillSandboxRuntimeService.runCommand({
        sandboxId: asSandboxId(sandbox.id),
        caller: {
          userId: user.id,
          organizationId: organization.id,
          agentId: agent.id,
        },
        command: "echo should-not-run",
      }),
    ).rejects.toThrow(
      'the skill "mounted-skill" mounted in this sandbox is no longer enabled for this agent',
    );
    expect(execute).not.toHaveBeenCalled();
  } finally {
    enabled.mockRestore();
    execute.mockRestore();
  }
});

test("blocks replay after the mounted skill leaves the agent environment", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeSkill,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id);
  const environment = await EnvironmentModel.create({
    organizationId: organization.id,
    name: "Skill Environment",
  });
  const agent = await makeAgent({
    organizationId: organization.id,
    environmentId: environment.id,
  });
  const skill = await makeSkill(organization.id, {
    name: "environment-mounted-skill",
    description: "An environment-bound mounted skill",
    content: "Follow the environment-bound procedure.",
    metadata: {},
    sourceType: "manual",
    environmentIds: [environment.id],
    access: "org",
  });
  if (!skill) throw new Error("skill seed failed");
  const version = await SkillVersionModel.findBySkillAndVersion(
    skill.id,
    skill.latestVersion,
  );
  if (!version) throw new Error("skill version seed failed");
  const sandbox = await SkillSandboxModel.create({
    organizationId: organization.id,
    userId: user.id,
    conversationId: null,
    defaultCwd: "/home/sandbox",
  });
  await SkillSandboxReplayEventModel.appendSkillMount({
    sandboxId: sandbox.id,
    organizationId: organization.id,
    mount: {
      skillId: skill.id,
      skillName: skill.name,
      skillVersionId: version.id,
    },
  });

  expect(
    await assertMountedSkillsReadable({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId: organization.id,
      agentId: agent.id,
    }),
  ).toEqual({ ok: true });

  await AgentModel.update(agent.id, { environmentId: null });

  expect(
    await assertMountedSkillsReadable({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId: organization.id,
      agentId: agent.id,
    }),
  ).toEqual({
    ok: false,
    code: "skill_environment_revoked",
    reason:
      'the skill "environment-mounted-skill" mounted in this sandbox is no longer available in this agent\'s environment',
  });
});
