import {
  AgentModel,
  EnvironmentModel,
  SkillModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import { expect, test } from "@/test";
import { assertMountedSkillsReadable } from "./assert-mounted-skills-readable";

test("blocks replay after the mounted skill is removed from the agent policy", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id);
  const agent = await makeAgent({ organizationId: organization.id });
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: organization.id,
      name: "mounted-skill",
      description: "A mounted skill",
      content: "Follow the mounted procedure.",
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [],
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
});

test("blocks replay after the mounted skill leaves the agent environment", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
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
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: organization.id,
      name: "environment-mounted-skill",
      description: "An environment-bound mounted skill",
      content: "Follow the environment-bound procedure.",
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [],
    environmentIds: [environment.id],
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
