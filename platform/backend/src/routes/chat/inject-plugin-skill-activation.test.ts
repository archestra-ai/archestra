import { ADMIN_ROLE_NAME, type ChatMessage } from "@archestra/shared";
import config from "@/config";
import { PluginModel, PluginSkillUsageEventModel } from "@/models";
import { beforeEach, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { injectPluginSkillActivation } from "./inject-skill-activation";

beforeEach(() => {
  config.plugins.enabled = true;
});

test("injects and counts an accessible plugin Skill attachment", async ({
  makeAgent,
  makeMember,
  makeUser,
}) => {
  const agent = await makeAgent();
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId, { role: ADMIN_ROLE_NAME });
  const plugin = await PluginModel.create({
    organizationId: agent.organizationId,
    userId: user.id,
    input: {
      displayName: "Portable bundle",
      description: "Portable skills",
      clientType: "claude-code",
      scope: "org",
      files: [
        {
          path: "skills/release/SKILL.md",
          content: [
            "---",
            "name: release-guide",
            "description: Ship safely.",
            "---",
            "",
            "Check every release artifact.",
          ].join("\n"),
          encoding: "utf8",
          mode: "100644",
        },
      ],
    },
  });
  if (!plugin) throw new Error("plugin seed failed");
  const messages: ChatMessage[] = [
    {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "Prepare the release." }],
      metadata: {
        pluginSkill: {
          pluginId: plugin.id,
          skillPath: "skills/release",
          name: "release-guide",
          pluginName: plugin.displayName,
          commandValue: "/release-guide",
          displayName: "release-guide",
        },
      },
    },
  ];

  const result = await injectPluginSkillActivation({
    messages,
    organizationId: agent.organizationId,
    userId: user.id,
    conversationId: "conversation-1",
    provider: "openai",
    model: "gpt-4o-mini",
  });

  expect(result[0]).toMatchObject({
    parts: [
      {
        type: "text",
        text: expect.stringContaining("Check every release artifact."),
      },
    ],
  });
  await drainBackgroundWork();
  const usage = await PluginSkillUsageEventModel.getSummaries([
    { pluginId: plugin.id, skillPath: "skills/release" },
  ]);
  expect(usage.get(plugin.id)?.get("skills/release")?.usageCount).toBe(1);
});
