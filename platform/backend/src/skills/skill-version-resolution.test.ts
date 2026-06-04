import {
  SkillModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import type { Skill } from "@/types";
import { resolveEffectiveSkillVersion } from "./skill-version-resolution";

async function seedSkillV2(organizationId: string): Promise<Skill> {
  const created = await SkillModel.createWithFiles({
    skill: {
      organizationId,
      authorId: null,
      name: "pdf",
      description: "desc",
      content: "# v1",
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [{ path: "references/a.md", content: "# A v1", kind: "reference" }],
  });
  if (!created) throw new Error("seed failed");
  // fork v2 in place.
  const updated = await SkillModel.updateWithFiles({
    id: created.id,
    skill: { content: "# v2" },
    files: [{ path: "references/a.md", content: "# A v2", kind: "reference" }],
  });
  if (!updated) throw new Error("update failed");
  return updated;
}

describe("resolveEffectiveSkillVersion", () => {
  test("returns the latest version when the skill is not mounted", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkillV2(org.id);

    const version = await resolveEffectiveSkillVersion({
      skill,
      organizationId: org.id,
      userId: user.id,
      conversationId: undefined,
    });
    expect(version?.version).toBe(2);
    expect(version?.content).toBe("# v2");
  });

  test("returns the mounted version even after the skill is edited", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    if (!conversation) throw new Error("conversation seed failed");

    // create a skill at v1 and mount v1 into the conversation's default sandbox.
    const created = await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        authorId: null,
        name: "pdf",
        description: "desc",
        content: "# v1",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    if (!created) throw new Error("seed failed");
    const v1 = await SkillVersionModel.findBySkillAndVersion(created.id, 1);
    if (!v1) throw new Error("missing v1");

    const sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      agentId: agent.id,
      defaultCwd: "/home/sandbox",
    });
    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      mount: {
        skillId: created.id,
        skillName: created.name,
        skillVersionId: v1.id,
      },
    });

    // edit the skill: latest is now v2, but the sandbox is pinned to v1.
    const edited = await SkillModel.updateWithFiles({
      id: created.id,
      skill: { content: "# v2" },
    });
    if (!edited) throw new Error("update failed");
    expect(edited.latestVersion).toBe(2);

    const inConversation = await resolveEffectiveSkillVersion({
      skill: edited,
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    });
    // mounted version wins — activation/read_skill_file/slash all see v1.
    expect(inConversation?.version).toBe(1);
    expect(inConversation?.content).toBe("# v1");

    // a different conversation (no mount) sees the latest version.
    const elsewhere = await resolveEffectiveSkillVersion({
      skill: edited,
      organizationId: org.id,
      userId: user.id,
      conversationId: crypto.randomUUID(),
    });
    expect(elsewhere?.version).toBe(2);
  });
});
