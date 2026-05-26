import {
  SkillModel,
  SkillSandboxArtifactModel,
  SkillSandboxCommandModel,
  SkillSandboxFileSnapshotModel,
  SkillSandboxModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import type { Skill } from "@/types";

async function seedSkill(organizationId: string, name: string): Promise<Skill> {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId,
      authorId: null,
      name,
      description: `${name} description`,
      content: `# ${name}`,
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

describe("SkillSandboxModel", () => {
  test("create persists sandbox and junction rows", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skillA = await seedSkill(org.id, "alpha");
    const skillB = await seedSkill(org.id, "beta");

    const sandbox = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        agentId: null,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skillA.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skillA.id, skillB.id],
    });

    expect(sandbox.id).toBeDefined();
    expect(sandbox.primarySkillId).toBe(skillA.id);

    const skillIds = await SkillSandboxModel.listSkillIds(sandbox.id);
    expect(new Set(skillIds)).toEqual(new Set([skillA.id, skillB.id]));
  });

  test("findById returns the sandbox or null", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");

    const sandbox = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        agentId: null,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skill.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skill.id],
    });

    const found = await SkillSandboxModel.findById(sandbox.id);
    expect(found?.id).toBe(sandbox.id);

    const missing = await SkillSandboxModel.findById(crypto.randomUUID());
    expect(missing).toBeNull();
  });

  test("listForConversation returns all sandboxes newest first", async ({
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

    const skill = await seedSkill(org.id, "alpha");

    const first = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: conversation.id,
        agentId: agent.id,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skill.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skill.id],
    });
    // ensure deterministic ordering despite identical timestamps in pglite
    await new Promise((r) => setTimeout(r, 5));
    const second = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: conversation.id,
        agentId: agent.id,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skill.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skill.id],
    });

    const found = await SkillSandboxModel.listForConversation(conversation.id);
    expect(found.map((s) => s.id)).toEqual([second.id, first.id]);

    const missing = await SkillSandboxModel.listForConversation(
      crypto.randomUUID(),
    );
    expect(missing).toHaveLength(0);
  });
});

describe("SkillSandboxFileSnapshotModel", () => {
  test("create auto-snapshots SKILL.md; createMany adds extra files", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");
    const sandbox = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        agentId: null,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skill.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skill.id],
    });

    // SKILL.md is auto-snapshotted; add a supplementary file to verify createMany
    await SkillSandboxFileSnapshotModel.createMany([
      {
        sandboxId: sandbox.id,
        skillId: skill.id,
        skillName: "alpha",
        path: "scripts/run.sh",
        encoding: "utf8",
        content: "echo hi",
      },
    ]);

    const rows = await SkillSandboxFileSnapshotModel.listBySandbox(sandbox.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.path).sort()).toEqual(
      ["SKILL.md", "scripts/run.sh"].sort(),
    );
    expect(rows.find((r) => r.path === "SKILL.md")?.content).toBe("# alpha");
  });

  test("createMany is a no-op for empty input", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");
    const sandbox = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        agentId: null,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skill.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skill.id],
    });

    // auto-snapshot already created SKILL.md; empty createMany adds nothing
    await SkillSandboxFileSnapshotModel.createMany([]);
    const rows = await SkillSandboxFileSnapshotModel.listBySandbox(sandbox.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe("SKILL.md");
  });
});

describe("SkillSandboxCommandModel", () => {
  test("append + listBySandbox preserves insertion order", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");
    const sandbox = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        agentId: null,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skill.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skill.id],
    });

    const first = await SkillSandboxCommandModel.append({
      sandboxId: sandbox.id,
      command: "echo hi",
      cwd: null,
      stdout: "hi\n",
      stderr: "",
      exitCode: 0,
      durationMs: 12,
      timeoutSeconds: 30,
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await SkillSandboxCommandModel.append({
      sandboxId: sandbox.id,
      command: "python --version",
      cwd: "/skills/alpha/scripts",
      stdout: "Python 3.12.0\n",
      stderr: "",
      exitCode: 0,
      durationMs: 40,
      timeoutSeconds: 10,
    });

    const log = await SkillSandboxCommandModel.listBySandbox(sandbox.id);
    expect(log.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(log[1].cwd).toBe("/skills/alpha/scripts");
  });
});

describe("SkillSandboxArtifactModel", () => {
  test("create stores raw bytes and findById round-trips", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");
    const sandbox = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        agentId: null,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skill.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skill.id],
    });

    const payload = Buffer.from("hello, world", "utf8");
    const artifact = await SkillSandboxArtifactModel.create({
      sandboxId: sandbox.id,
      path: "out/report.txt",
      mimeType: "text/plain",
      sizeBytes: payload.byteLength,
      data: payload,
    });

    const fetched = await SkillSandboxArtifactModel.findById(artifact.id);
    if (!fetched) throw new Error("artifact not found");
    expect(fetched.path).toBe("out/report.txt");
    expect(fetched.sizeBytes).toBe(payload.byteLength);
    expect(Buffer.from(fetched.data).toString("utf8")).toBe("hello, world");
  });

  test("listBySandbox returns most-recent first", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");
    const sandbox = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        agentId: null,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skill.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skill.id],
    });

    const a = await SkillSandboxArtifactModel.create({
      sandboxId: sandbox.id,
      path: "out/a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      data: Buffer.from("a"),
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = await SkillSandboxArtifactModel.create({
      sandboxId: sandbox.id,
      path: "out/b.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      data: Buffer.from("b"),
    });

    const rows = await SkillSandboxArtifactModel.listBySandbox(sandbox.id);
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
  });
});

describe("Cascade behavior", () => {
  test("deleting a sandbox removes commands, artifacts, and junction rows", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");

    const sandbox = await SkillSandboxModel.create({
      sandbox: {
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        agentId: null,
        baseImage: "archestra/skill-sandbox:dev",
        primarySkillId: skill.id,
        defaultCwd: "/skills/alpha",
      },
      skillIds: [skill.id],
    });

    await SkillSandboxCommandModel.append({
      sandboxId: sandbox.id,
      command: "echo hi",
      cwd: null,
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timeoutSeconds: 30,
    });
    await SkillSandboxArtifactModel.create({
      sandboxId: sandbox.id,
      path: "out/a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      data: Buffer.from("a"),
    });
    await SkillSandboxFileSnapshotModel.createMany([
      {
        sandboxId: sandbox.id,
        skillId: skill.id,
        skillName: "alpha",
        path: "SKILL.md",
        encoding: "utf8",
        content: "# alpha",
      },
    ]);

    const { default: db, schema } = await import("@/database");
    const { eq } = await import("drizzle-orm");
    await db
      .delete(schema.skillSandboxesTable)
      .where(eq(schema.skillSandboxesTable.id, sandbox.id));

    expect(await SkillSandboxModel.findById(sandbox.id)).toBeNull();
    expect(
      await SkillSandboxCommandModel.listBySandbox(sandbox.id),
    ).toHaveLength(0);
    expect(
      await SkillSandboxArtifactModel.listBySandbox(sandbox.id),
    ).toHaveLength(0);
    expect(await SkillSandboxModel.listSkillIds(sandbox.id)).toHaveLength(0);
    expect(
      await SkillSandboxFileSnapshotModel.listBySandbox(sandbox.id),
    ).toHaveLength(0);
  });
});
