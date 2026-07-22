import type { ChatMessage } from "@archestra/shared";
import { EnvironmentModel, SkillModel } from "@/models";
import { expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { injectSkillActivation } from "./inject-skill-activation";

async function seedSkill(
  organizationId: string,
  name: string,
  scope: "personal" | "team" | "org" = "org",
  authorId: string | null = null,
) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId,
      authorId,
      name,
      description: `${name} description`,
      content: `Follow the ${name} steps.`,
      license: null,
      compatibility: null,
      sourceType: "manual",
      scope,
    },
    files: [],
  });
  if (!skill) {
    throw new Error("failed to seed skill");
  }
  return skill;
}

test("prepends the skill activation block to the last user message", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  // a plain member has the predefined `member` role, which grants skill:read
  await makeMember(user.id, org.id);
  const skill = await seedSkill(org.id, "Research");

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "summarize this paper" }],
      metadata: { skill: { id: skill.id, name: skill.name } },
    },
  ];

  const result = await injectSkillActivation({
    messages,
    organizationId: org.id,
    userId: user.id,
    agentId: undefined,
    conversationId: undefined,
  });

  const text = result[0].parts?.[0]?.text ?? "";
  expect(text).toContain('<skill_content name="Research" version="1">');
  expect(text).toContain("Follow the Research steps.");
  expect(text).toContain("summarize this paper");
  // the original message is left untouched for persistence / display
  expect(messages[0].parts?.[0]?.text).toBe("summarize this paper");

  // the activation counts one use
  await drainBackgroundWork();
  expect((await SkillModel.findById(skill.id))?.usageCount).toBe(1);
});

test("ignores a skill that belongs to another organization", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const user = await makeUser();
  const skill = await seedSkill(otherOrg.id, "Research");

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
      metadata: { skill: { id: skill.id, name: skill.name } },
    },
  ];

  const result = await injectSkillActivation({
    messages,
    organizationId: org.id,
    userId: user.id,
    agentId: undefined,
    conversationId: undefined,
  });

  expect(result[0].parts?.[0]?.text).toBe("hello");
});

test("ignores a skill the user cannot access under its scope", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const org = await makeOrganization();
  const author = await makeUser();
  const otherUser = await makeUser();
  await makeMember(otherUser.id, org.id);
  // a personal skill owned by `author` — `otherUser` must not be able to use it
  const skill = await seedSkill(org.id, "Research", "personal", author.id);

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
      metadata: { skill: { id: skill.id, name: skill.name } },
    },
  ];

  const result = await injectSkillActivation({
    messages,
    organizationId: org.id,
    userId: otherUser.id,
    agentId: undefined,
    conversationId: undefined,
  });

  expect(result[0].parts?.[0]?.text).toBe("hello");
});

test("ignores a slash-command skill when the user lacks skill:read", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  // a custom role with chat access but no `skill` permission at all
  const role = await makeCustomRole(org.id, {
    permission: { chat: ["read"] },
  });
  await makeMember(user.id, org.id, { role: role.role });
  // an org-scoped skill is in-scope for everyone, so only the read gate stops it
  const skill = await seedSkill(org.id, "Research");

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
      metadata: { skill: { id: skill.id, name: skill.name } },
    },
  ];

  const result = await injectSkillActivation({
    messages,
    organizationId: org.id,
    userId: user.id,
    agentId: undefined,
    conversationId: undefined,
  });

  expect(result[0].parts?.[0]?.text).toBe("hello");
});

test("returns the messages unchanged when no skill metadata is present", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();

  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "hello" }] },
  ];

  const result = await injectSkillActivation({
    messages,
    organizationId: org.id,
    userId: user.id,
    agentId: undefined,
    conversationId: undefined,
  });

  expect(result).toBe(messages);
});

test("leaves the message unchanged when the skill is outside the agent's environment", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const agent = await makeAgent({
    name: "Default Env Agent",
    organizationId: org.id,
  });

  const otherEnv = await EnvironmentModel.create({
    organizationId: org.id,
    name: "Other Environment",
  });
  const skill = await seedSkill(org.id, "Research");
  await SkillModel.updateWithFiles({
    id: skill.id,
    skill: { scope: "org" },
    environmentIds: [otherEnv.id],
  });

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "summarize this paper" }],
      metadata: { skill: { id: skill.id, name: skill.name } },
    },
  ];

  const result = await injectSkillActivation({
    messages,
    organizationId: org.id,
    userId: user.id,
    agentId: agent.id,
    conversationId: undefined,
  });

  expect(result).toBe(messages);
});

test("injects a delegation directive instead of the body for an agent-designated skill", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const skill = await seedSkill(org.id, "Deep Research");
  await SkillModel.updateWithFiles({
    id: skill.id,
    skill: { agentName: "Research Bot" },
  });

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "find prior art" }],
      metadata: { skill: { id: skill.id, name: skill.name } },
    },
  ];

  const result = await injectSkillActivation({
    messages,
    organizationId: org.id,
    userId: user.id,
    agentId: undefined,
    conversationId: undefined,
  });

  const text = result[0].parts?.[0]?.text ?? "";
  expect(text).toContain(
    '<skill_delegation skill="Deep Research" agent="Research Bot">',
  );
  expect(text).toContain("skill__deep_research");
  expect(text).toContain("find prior art");
  // the skill's instructions never reach the parent context
  expect(text).not.toContain("Follow the Deep Research steps.");
  expect(text).not.toContain("<skill_content");
});
