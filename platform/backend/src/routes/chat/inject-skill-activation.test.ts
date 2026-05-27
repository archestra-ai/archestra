import type { ChatMessage } from "@shared";
import { SkillModel } from "@/models";
import { expect, test } from "@/test";
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
  });

  const text = result[0].parts?.[0]?.text ?? "";
  expect(text).toContain('<skill_content name="Research">');
  expect(text).toContain("Follow the Research steps.");
  expect(text).toContain("summarize this paper");
  // the original message is left untouched for persistence / display
  expect(messages[0].parts?.[0]?.text).toBe("summarize this paper");
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
  });

  expect(result).toBe(messages);
});
