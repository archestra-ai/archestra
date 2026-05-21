import type { ChatMessage } from "@shared";
import { SkillModel } from "@/models";
import { expect, test } from "@/test";
import { injectSkillActivation } from "./inject-skill-activation";

async function seedSkill(organizationId: string, name: string) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId,
      authorId: null,
      name,
      description: `${name} description`,
      content: `Follow the ${name} steps.`,
      license: null,
      compatibility: null,
      sourceType: "manual",
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
}) => {
  const org = await makeOrganization();
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
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
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
  });

  expect(result[0].parts?.[0]?.text).toBe("hello");
});

test("returns the messages unchanged when no skill metadata is present", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();

  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "hello" }] },
  ];

  const result = await injectSkillActivation({
    messages,
    organizationId: org.id,
  });

  expect(result).toBe(messages);
});
