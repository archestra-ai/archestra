import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  ConversationModel,
  SkillModel,
  SkillSandboxConversationGoneError,
  SkillSandboxFileModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import type { Skill } from "@/types";

async function seedSkill(
  organizationId: string,
  name: string,
  files: { path: string; content: string; kind: "reference" | "script" }[] = [],
): Promise<Skill> {
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
    files,
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

/** Resolve a seeded skill's version-1 id, the head a mount would pin. */
async function latestVersionId(skill: Skill): Promise<string> {
  const version = await SkillVersionModel.findBySkillAndVersion(
    skill.id,
    skill.latestVersion,
  );
  if (!version) throw new Error("skill has no version");
  return version.id;
}

function mountRef(skill: Skill, skillVersionId: string) {
  return {
    skillId: skill.id,
    skillName: skill.name,
    skillVersionId,
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
      defaultCwd: "/home/sandbox",
    };
    const first = await SkillSandboxModel.findOrCreateDefault(params);
    const second = await SkillSandboxModel.findOrCreateDefault(params);

    expect(first.isDefault).toBe(true);
    expect(second.id).toBe(first.id);
    // findDefault sees the same row without creating one.
    const found = await SkillSandboxModel.findDefault({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    });
    expect(found?.id).toBe(first.id);
  });

  test("create and findOrCreateDefault surface a typed error for a deleted conversation", async ({
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
    await ConversationModel.delete(conversation.id, user.id, org.id);

    await expect(
      SkillSandboxModel.create({
        organizationId: org.id,
        userId: user.id,
        conversationId: conversation.id,
        defaultCwd: "/home/sandbox",
      }),
    ).rejects.toThrow(SkillSandboxConversationGoneError);

    await expect(
      SkillSandboxModel.findOrCreateDefault({
        organizationId: org.id,
        userId: user.id,
        conversationId: conversation.id,
        defaultCwd: "/home/sandbox",
      }),
    ).rejects.toThrow(SkillSandboxConversationGoneError);
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
      defaultCwd: "/home/sandbox",
    });

    const found = await SkillSandboxModel.findById(sandbox.id);
    expect(found?.id).toBe(sandbox.id);
    expect(await SkillSandboxModel.findById(crypto.randomUUID())).toBeNull();
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
      defaultCwd: "/home/sandbox",
    });

    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      mount: mountRef(skillA, await latestVersionId(skillA)),
    });
    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      mount: mountRef(skillB, await latestVersionId(skillB)),
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
    const skill = await seedSkill(org.id, "alpha", [
      { path: "requirements.txt", content: "httpx\n", kind: "reference" },
    ]);
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
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
      path: "/home/sandbox/input.csv",
      mimeType: "text/csv",
      originalName: "input.csv",
      sizeBytes: 3,
      data: Buffer.from("a,b", "utf8"),
    });
    if (!upload) throw new Error("upload not appended");
    // a mount that ships requirements.txt also appends an install command in the
    // same transaction, so this is two events: skill_mount then command.
    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      mount: mountRef(skill, await latestVersionId(skill)),
      installCommands: [
        {
          command:
            "uv add --project /home/sandbox -r /skills/alpha/requirements.txt",
          cwd: "/home/sandbox",
          timeoutSeconds: 180,
        },
      ],
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
    // SKILL.md is carried as the version body; requirements.txt as a version file.
    expect(m.content).toBe("# alpha");
    expect(m.files.map((f) => f.path)).toEqual(["requirements.txt"]);
    expect(install.command.command).toContain("uv add --project");

    // the allocator advanced past every appended event.
    const refreshed = await SkillSandboxModel.findById(sandbox.id);
    expect(refreshed?.nextReplaySequence).toBe(4);
  });

  test("appendSkillMount records every install command in order within the mount transaction", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha", [
      { path: "requirements.txt", content: "httpx\n", kind: "reference" },
      {
        path: "tools/requirements.txt",
        content: "mpmath\n",
        kind: "reference",
      },
    ]);
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });

    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      mount: mountRef(skill, await latestVersionId(skill)),
      installCommands: [
        {
          command:
            "uv add --project /home/sandbox -r /skills/alpha/requirements.txt",
          cwd: "/home/sandbox",
          timeoutSeconds: 180,
        },
        {
          command:
            "uv add --project /home/sandbox -r /skills/alpha/tools/requirements.txt",
          cwd: "/home/sandbox",
          timeoutSeconds: 180,
        },
      ],
    });

    const log = await SkillSandboxReplayEventModel.listBySandbox(sandbox.id);
    expect(log.map((e) => e.kind)).toEqual([
      "skill_mount",
      "command",
      "command",
    ]);
    const commands = log.flatMap((e) =>
      e.kind === "command" ? [e.command.command] : [],
    );
    expect(commands[0]).toContain("/skills/alpha/requirements.txt");
    expect(commands[1]).toContain("/skills/alpha/tools/requirements.txt");
  });

  test("appendSkillMount is idempotent under the per-skill unique constraint", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await seedSkill(org.id, "alpha");
    const versionId = await latestVersionId(skill);
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });

    const first = await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      mount: mountRef(skill, versionId),
    });
    const second = await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId: org.id,
      mount: mountRef(skill, versionId),
    });

    expect(first).not.toBeNull();
    // re-activation is a no-op: ON CONFLICT (sandbox_id, skill_id) DO NOTHING.
    expect(second).toBeNull();
    const log = await SkillSandboxReplayEventModel.listBySandbox(sandbox.id);
    expect(log.filter((e) => e.kind === "skill_mount")).toHaveLength(1);
  });

  test("a replay event cannot reference an artifact file (composite FK)", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    const artifact = await SkillSandboxFileModel.createArtifact({
      sandboxId: sandbox.id,
      path: "out/report.txt",
      mimeType: "text/plain",
      originalName: null,
      sizeBytes: 1,
      data: Buffer.from("a"),
    });

    // file_kind is generated as 'upload', so pointing file_id at an artifact row
    // violates the (file_id, file_kind) -> (id, kind) composite FK.
    await expect(
      db.insert(schema.skillSandboxReplayEventsTable).values({
        sandboxId: sandbox.id,
        sequence: 0,
        kind: "upload",
        fileId: artifact.id,
      }),
    ).rejects.toThrow();
  });
});

describe("SkillSandboxFileModel (artifacts)", () => {
  test("createArtifact stores raw bytes and findArtifactById round-trips", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });

    const payload = Buffer.from("hello, world", "utf8");
    const artifact = await SkillSandboxFileModel.createArtifact({
      sandboxId: sandbox.id,
      path: "out/report.txt",
      mimeType: "text/plain",
      originalName: null,
      sizeBytes: payload.byteLength,
      data: payload,
    });

    const fetched = await SkillSandboxFileModel.findArtifactById(artifact.id);
    if (!fetched) throw new Error("artifact not found");
    expect(fetched.kind).toBe("artifact");
    expect(fetched.path).toBe("out/report.txt");
    expect(Buffer.from(fetched.data).toString("utf8")).toBe("hello, world");
  });

  test("findArtifactById ignores upload-kind rows", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    const upload = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      path: "/home/sandbox/in.csv",
      mimeType: "text/csv",
      originalName: null,
      sizeBytes: 1,
      data: Buffer.from("a"),
    });
    if (!upload) throw new Error("upload not appended");

    // an upload is a file row too, but the artifact lookup is kind-scoped.
    expect(await SkillSandboxFileModel.findArtifactById(upload.id)).toBeNull();
  });
});

describe("Cascade behavior", () => {
  test("deleting a sandbox removes its replay log, mounts, files, and artifacts", async ({
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
      mount: mountRef(skill, await latestVersionId(skill)),
    });
    const artifact = await SkillSandboxFileModel.createArtifact({
      sandboxId: sandbox.id,
      path: "out/a.txt",
      mimeType: "text/plain",
      originalName: null,
      sizeBytes: 1,
      data: Buffer.from("a"),
    });

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
      await SkillSandboxFileModel.findArtifactById(artifact.id),
    ).toBeNull();
    // the pinned version survives (RESTRICT would block deleting it, not the
    // sandbox); the mount row is gone via cascade.
    expect(
      await SkillVersionModel.findBySkillAndVersion(skill.id, 1),
    ).not.toBeNull();
  });
});
