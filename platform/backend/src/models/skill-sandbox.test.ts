import {
  SkillModel,
  SkillSandboxArtifactModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
} from "@/models";
import type { SkillMountInput } from "@/skills-sandbox/types";
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

function mountInput(skill: Skill, files: SkillMountInput["files"] = []) {
  return {
    skillId: skill.id,
    skillName: skill.name,
    content: skill.content,
    files,
  };
}

describe("SkillSandboxModel", () => {
  test("create persists an empty sandbox", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      agentId: null,
      defaultCwd: "/home/sandbox",
    });

    expect(sandbox.id).toBeDefined();
    expect(sandbox.isDefault).toBe(false);
    // nothing mounted until a skill is activated.
    expect(await SkillSandboxModel.listMountedSkillIds(sandbox.id)).toEqual([]);
  });

  test("findOrCreateDefault returns the same default per conversation", async ({
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

    const params = {
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      agentId: agent.id,
      defaultCwd: "/home/sandbox",
    };
    const first = await SkillSandboxModel.findOrCreateDefault(params);
    const second = await SkillSandboxModel.findOrCreateDefault(params);

    expect(first.isDefault).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test("findById returns the sandbox or null", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      agentId: null,
      defaultCwd: "/home/sandbox",
    });

    const found = await SkillSandboxModel.findById(sandbox.id);
    expect(found?.id).toBe(sandbox.id);
    expect(await SkillSandboxModel.findById(crypto.randomUUID())).toBeNull();
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

    const base = {
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      agentId: agent.id,
      defaultCwd: "/home/sandbox",
    };
    const first = await SkillSandboxModel.create(base);
    // ensure deterministic ordering despite identical timestamps in pglite
    await new Promise((r) => setTimeout(r, 5));
    const second = await SkillSandboxModel.create(base);

    const found = await SkillSandboxModel.listForConversation({
      conversationId: conversation.id,
      organizationId: org.id,
    });
    expect(found.map((s) => s.id)).toEqual([second.id, first.id]);

    expect(
      await SkillSandboxModel.listForConversation({
        conversationId: crypto.randomUUID(),
        organizationId: org.id,
      }),
    ).toHaveLength(0);

    // a sandbox in this conversation but a different org must not leak.
    expect(
      await SkillSandboxModel.listForConversation({
        conversationId: conversation.id,
        organizationId: crypto.randomUUID(),
      }),
    ).toHaveLength(0);
  });

  test("listMountedSkillIds reflects mounted skills, deduped", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skillA = await seedSkill(org.id, "alpha");
    const skillB = await seedSkill(org.id, "beta");

    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      agentId: null,
      defaultCwd: "/home/sandbox",
    });

    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      skill: mountInput(skillA),
    });
    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      skill: mountInput(skillB),
    });

    expect(
      new Set(await SkillSandboxModel.listMountedSkillIds(sandbox.id)),
    ).toEqual(new Set([skillA.id, skillB.id]));
  });
});

describe("SkillSandboxReplayEventModel", () => {
  test("interleaves command/upload/skill_mount and replays them in sequence order", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      agentId: null,
      defaultCwd: "/home/sandbox",
    });

    const commandA = await SkillSandboxReplayEventModel.appendCommand({
      sandboxId: sandbox.id,
      organizationId: org.id,
      command: "echo before",
      cwd: null,
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timeoutSeconds: 30,
    });
    const upload = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      organizationId: org.id,
      path: "/home/sandbox/input.csv",
      mimeType: "text/csv",
      originalName: "input.csv",
      sizeBytes: 3,
      data: Buffer.from("a,b", "utf8"),
    });
    // a mount that ships requirements.txt also appends an install command in the
    // same transaction, so this is two events: skill_mount then command.
    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      skill: mountInput(skill, [
        { path: "requirements.txt", encoding: "utf8", content: "httpx\n" },
      ]),
      installCommand: {
        command: "uv pip install -r /skills/alpha/requirements.txt",
        cwd: "/home/sandbox",
        timeoutSeconds: 180,
      },
    });

    const log = await SkillSandboxReplayEventModel.listBySandbox(sandbox.id);
    expect(log.map((e) => e.kind)).toEqual([
      "command",
      "upload",
      "skill_mount",
      "command",
    ]);
    expect(log.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);

    const [a, u, m, install] = log;
    if (
      a.kind !== "command" ||
      u.kind !== "upload" ||
      m.kind !== "skill_mount" ||
      install.kind !== "command"
    ) {
      throw new Error("unexpected replay event kinds");
    }
    expect(a.command.id).toBe(commandA.id);
    expect(u.upload.id).toBe(upload.id);
    expect(u.upload.data.toString("utf8")).toBe("a,b");
    expect(m.mount.skillName).toBe("alpha");
    // SKILL.md + requirements.txt snapshotted under the mount.
    expect(m.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "requirements.txt",
    ]);
    expect(install.command.command).toContain("uv pip install");

    // the allocator advanced past every appended event.
    const refreshed = await SkillSandboxModel.findById(sandbox.id);
    expect(refreshed?.nextReplaySequence).toBe(4);
  });

  test("appendSkillMount rejects skill files with traversal/absolute paths", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      agentId: null,
      defaultCwd: "/home/sandbox",
    });

    await expect(
      SkillSandboxReplayEventModel.appendSkillMount({
        sandboxId: sandbox.id,
        organizationId: org.id,
        skill: mountInput(skill, [
          { path: "../escape.py", encoding: "utf8", content: "x" },
        ]),
      }),
    ).rejects.toThrow("invalid file path");
  });
});

describe("SkillSandboxArtifactModel", () => {
  test("create stores raw bytes and findById round-trips", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      agentId: null,
      defaultCwd: "/home/sandbox",
    });

    const payload = Buffer.from("hello, world", "utf8");
    const artifact = await SkillSandboxArtifactModel.create({
      sandboxId: sandbox.id,
      organizationId: org.id,
      path: "out/report.txt",
      mimeType: "text/plain",
      sizeBytes: payload.byteLength,
      data: payload,
    });

    const fetched = await SkillSandboxArtifactModel.findById(artifact.id);
    if (!fetched) throw new Error("artifact not found");
    expect(fetched.path).toBe("out/report.txt");
    expect(Buffer.from(fetched.data).toString("utf8")).toBe("hello, world");
  });

  test("listBySandbox returns most-recent first", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      agentId: null,
      defaultCwd: "/home/sandbox",
    });

    const a = await SkillSandboxArtifactModel.create({
      sandboxId: sandbox.id,
      organizationId: org.id,
      path: "out/a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      data: Buffer.from("a"),
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = await SkillSandboxArtifactModel.create({
      sandboxId: sandbox.id,
      organizationId: org.id,
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
  test("deleting a sandbox removes its replay log, mounts, snapshots, and artifacts", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");

    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      agentId: null,
      defaultCwd: "/home/sandbox",
    });

    await SkillSandboxReplayEventModel.appendCommand({
      sandboxId: sandbox.id,
      organizationId: org.id,
      command: "echo hi",
      cwd: null,
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timeoutSeconds: 30,
    });
    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      skill: mountInput(skill),
    });
    await SkillSandboxArtifactModel.create({
      sandboxId: sandbox.id,
      organizationId: org.id,
      path: "out/a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      data: Buffer.from("a"),
    });

    const { default: db, schema } = await import("@/database");
    const { eq } = await import("drizzle-orm");
    await db
      .delete(schema.skillSandboxesTable)
      .where(eq(schema.skillSandboxesTable.id, sandbox.id));

    expect(await SkillSandboxModel.findById(sandbox.id)).toBeNull();
    expect(
      await SkillSandboxReplayEventModel.listBySandbox(sandbox.id),
    ).toHaveLength(0);
    expect(
      await SkillSandboxModel.listMountedSkillIds(sandbox.id),
    ).toHaveLength(0);
    expect(
      await SkillSandboxArtifactModel.listBySandbox(sandbox.id),
    ).toHaveLength(0);
  });
});
