import config from "@/config";
import {
  SkillModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { afterAll, beforeEach, describe, expect, test } from "@/test";
import type { Skill } from "@/types";
import {
  resolveActivationVersion,
  resolveEffectiveSkillVersion,
} from "./skill-version-resolution";

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
    // mounted version wins — load_skill (with or without a path) and slash all see v1.
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

describe("resolveActivationVersion (sandbox runtime enabled)", () => {
  const originalSkills = config.skillsSandbox.enabled;
  const originalDagger = config.daggerRuntime.enabled;
  beforeEach(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
    (config.daggerRuntime as { enabled: boolean }).enabled = true;
  });
  afterAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalSkills;
    (config.daggerRuntime as { enabled: boolean }).enabled = originalDagger;
  });

  test("mounts a skill and reports it runnable", async ({
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

    const skill = await seedSkillV2(org.id);
    const result = await resolveActivationVersion({
      skill,
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      canRunSandbox: true,
    });

    expect(result?.mounted).toBe(true);
    expect(result?.version.version).toBe(2);
    const sandbox = await SkillSandboxModel.findDefault({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    });
    const mount = await SkillSandboxModel.findMountBySkill({
      sandboxId: sandbox?.id ?? "",
      skillId: skill.id,
    });
    expect(mount?.skillVersionId).toBe(result?.version.id);
  });

  test("mounts into the per-execution sandbox for headless runs", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkillV2(org.id);
    const isolationKey = crypto.randomUUID();

    const result = await resolveActivationVersion({
      skill,
      organizationId: org.id,
      userId: user.id,
      conversationId: undefined,
      isolationKey,
      canRunSandbox: true,
    });
    expect(result?.mounted).toBe(true);
    expect(result?.version.version).toBe(2);

    // the per-execution sandbox pins the mounted version: a later edit is not
    // visible inside the execution, but is everywhere else.
    const edited = await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { content: "# v3" },
    });
    if (!edited) throw new Error("update failed");

    const inExecution = await resolveEffectiveSkillVersion({
      skill: edited,
      organizationId: org.id,
      userId: user.id,
      conversationId: undefined,
      isolationKey,
    });
    expect(inExecution?.version).toBe(2);

    const elsewhere = await resolveEffectiveSkillVersion({
      skill: edited,
      organizationId: org.id,
      userId: user.id,
      conversationId: undefined,
    });
    expect(elsewhere?.version).toBe(3);

    executionSandboxRegistry.release(isolationKey);
  });

  test("a same-named skill that loses the mount path is shown read-only", async ({
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

    // two accessible skills with the same name (org + the caller's personal),
    // allowed by per-scope name uniqueness. Both want /skills/shared.
    const orgSkill = await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        authorId: null,
        name: "shared",
        description: "org",
        content: "# org body",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    const personalSkill = await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        authorId: user.id,
        name: "shared",
        description: "personal",
        content: "# personal body",
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });
    if (!orgSkill || !personalSkill) throw new Error("seed failed");

    const orgV1 = await SkillVersionModel.findBySkillAndVersion(orgSkill.id, 1);
    if (!orgV1) throw new Error("missing org v1");

    // the org skill already occupies /skills/shared in the default sandbox.
    const sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      defaultCwd: "/home/sandbox",
    });
    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      mount: {
        skillId: orgSkill.id,
        skillName: orgSkill.name,
        skillVersionId: orgV1.id,
      },
    });

    // activating the personal "shared" collides on (sandbox, skill_name): it
    // must NOT be reported runnable, and the org skill must keep the path.
    const result = await resolveActivationVersion({
      skill: personalSkill,
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      canRunSandbox: true,
    });

    expect(result?.mounted).toBe(false);
    expect(result?.version.content).toBe("# personal body");
    // the personal skill never got a mount; the org skill still owns the path.
    expect(
      await SkillSandboxModel.findMountBySkill({
        sandboxId: sandbox.id,
        skillId: personalSkill.id,
      }),
    ).toBeNull();
    const pathOwner = await SkillSandboxModel.findMountBySkill({
      sandboxId: sandbox.id,
      skillId: orgSkill.id,
    });
    expect(pathOwner?.skillVersionId).toBe(orgV1.id);
  });
});
