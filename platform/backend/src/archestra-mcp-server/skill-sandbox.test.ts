// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ADMIN_ROLE_NAME,
  TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
  TOOL_GET_SKILL_SANDBOX_ARTIFACT_FULL_NAME,
  TOOL_RUN_SKILL_COMMAND_FULL_NAME,
  TOOL_UPLOAD_SKILL_SANDBOX_FILE_FULL_NAME,
} from "@shared";
import config from "@/config";
import {
  ConversationAttachmentModel,
  ConversationModel,
  SkillModel,
  SkillSandboxFileSnapshotModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
} from "@/models";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { SkillSandboxError } from "@/skills-sandbox/types";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "@/test";
import type { Agent, InsertSkill } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from ".";
import { TOOL_PERMISSIONS } from "./rbac";

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as any).text as string;
}

function structuredOf<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

describe("skill sandbox tools (runtime disabled)", () => {
  let context: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    const agent = await makeAgent({ name: "Sandbox Agent" });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId, { role: ADMIN_ROLE_NAME });
    context = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: agent.organizationId,
      userId: user.id,
    };
  });

  test("sandbox tools are excluded from the catalog while disabled", () => {
    const names = getArchestraMcpTools().map((tool) => tool.name);
    expect(names).not.toContain(TOOL_CREATE_SKILL_SANDBOX_FULL_NAME);
    expect(names).not.toContain(TOOL_RUN_SKILL_COMMAND_FULL_NAME);
    expect(names).not.toContain(TOOL_GET_SKILL_SANDBOX_ARTIFACT_FULL_NAME);
    expect(names).not.toContain(TOOL_UPLOAD_SKILL_SANDBOX_FILE_FULL_NAME);
  });

  test("all sandbox tools require the skill:execute permission", () => {
    expect(TOOL_PERMISSIONS.create_skill_sandbox).toEqual({
      resource: "skill",
      action: "execute",
    });
    expect(TOOL_PERMISSIONS.run_skill_command).toEqual({
      resource: "skill",
      action: "execute",
    });
    expect(TOOL_PERMISSIONS.get_skill_sandbox_artifact).toEqual({
      resource: "skill",
      action: "execute",
    });
    expect(TOOL_PERMISSIONS.upload_skill_sandbox_file).toEqual({
      resource: "skill",
      action: "execute",
    });
  });

  test("create_skill_sandbox returns a clean error when the runtime is disabled", async () => {
    const result = await executeArchestraTool(
      TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
      { skillNames: ["any"] },
      context,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not enabled");
  });
});

describe("skill sandbox tools (runtime enabled)", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;
  let context: ArchestraContext;
  const originalEnabled = config.skillsSandbox.enabled;

  beforeAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
  });

  afterAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalEnabled;
  });

  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    agent = await makeAgent({ name: "Sandbox Agent" });
    organizationId = agent.organizationId;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    userId = user.id;
    context = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId,
      userId,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedSkill(overrides: { skill?: Partial<InsertSkill> } = {}) {
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "pdf-processing",
        description: "Extract text from PDF files.",
        content: "# PDF Processing\nUse pdftotext.",
        metadata: {},
        sourceType: "manual",
        scope: "org",
        ...overrides.skill,
      },
      files: [],
    });
    if (!skill) throw new Error("seed skill failed");
    return skill;
  }

  describe("create_skill_sandbox", () => {
    test("happy path persists a sandbox row + junction with the requested skills", async () => {
      const skill = await seedSkill();
      const result = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"] },
        context,
      );

      expect(result.isError).toBe(false);
      const structured = structuredOf<{
        sandboxId: string;
        defaultCwd: string;
        skillRoots: { skillId: string; skillName: string; rootPath: string }[];
      }>(result);
      expect(structured.defaultCwd).toBe("/skills/pdf-processing");
      expect(structured.skillRoots).toEqual([
        {
          skillId: skill.id,
          skillName: "pdf-processing",
          rootPath: "/skills/pdf-processing",
        },
      ]);

      const sandbox = await SkillSandboxModel.findById(structured.sandboxId);
      expect(sandbox?.userId).toBe(userId);
      expect(sandbox?.organizationId).toBe(organizationId);
      expect(sandbox?.primarySkillId).toBe(skill.id);
      expect(sandbox?.defaultCwd).toBe("/skills/pdf-processing");

      const skillIds = await SkillSandboxModel.listSkillIds(
        structured.sandboxId,
      );
      expect(skillIds).toEqual([skill.id]);

      // file snapshots should be captured at creation time
      const snapshots = await SkillSandboxFileSnapshotModel.listBySandbox(
        structured.sandboxId,
      );
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      const skillMd = snapshots.find((s) => s.path === "SKILL.md");
      expect(skillMd?.skillName).toBe("pdf-processing");
      expect(skillMd?.content).toContain("PDF Processing");
    });

    test("uses primarySkill to set defaultCwd when multiple skills are mounted", async () => {
      const first = await seedSkill({ skill: { name: "skill-a" } });
      const second = await seedSkill({ skill: { name: "skill-b" } });
      const result = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["skill-a", "skill-b"], primarySkill: "skill-b" },
        context,
      );

      expect(result.isError).toBe(false);
      const structured = structuredOf<{
        sandboxId: string;
        defaultCwd: string;
      }>(result);
      expect(structured.defaultCwd).toBe("/skills/skill-b");

      const sandbox = await SkillSandboxModel.findById(structured.sandboxId);
      expect(sandbox?.primarySkillId).toBe(second.id);
      // unused first skill is still mounted into the sandbox
      const skillIds = await SkillSandboxModel.listSkillIds(
        structured.sandboxId,
      );
      expect(skillIds.sort()).toEqual([first.id, second.id].sort());
    });

    test("rejects an unknown skill name", async () => {
      const result = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["does-not-exist"] },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("does-not-exist");
    });

    test("rejects when primarySkill is not in skillNames", async () => {
      await seedSkill();
      const result = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"], primarySkill: "other" },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("primarySkill");
    });
  });

  describe("run_skill_command", () => {
    test("rejects when neither sandboxId nor conversation context is provided", async () => {
      const result = await executeArchestraTool(
        TOOL_RUN_SKILL_COMMAND_FULL_NAME,
        { command: "echo hi" },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("sandboxId");
    });

    test("rejects when conversation has no attached sandbox", async () => {
      const conversation = await ConversationModel.create({
        userId,
        organizationId,
        agentId: agent.id,
        title: "Test",
      });
      const result = await executeArchestraTool(
        TOOL_RUN_SKILL_COMMAND_FULL_NAME,
        { command: "echo hi" },
        { ...context, conversationId: conversation.id },
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No sandbox is attached");
    });

    test("rejects an explicit sandboxId owned by another user", async ({
      makeUser,
      makeMember,
    }) => {
      await seedSkill();
      // create a sandbox via the API as the admin
      const created = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"] },
        context,
      );
      const { sandboxId } = structuredOf<{ sandboxId: string }>(created);

      // a second admin user in the same org has skill:execute but does not
      // own this sandbox, so the handler must refuse access
      const otherAdmin = await makeUser();
      await makeMember(otherAdmin.id, organizationId, {
        role: ADMIN_ROLE_NAME,
      });
      const result = await executeArchestraTool(
        TOOL_RUN_SKILL_COMMAND_FULL_NAME,
        { sandboxId, command: "echo hi" },
        { ...context, userId: otherAdmin.id },
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No accessible sandbox");
    });

    test("routes to the most recently created sandbox when conversation has multiple", async () => {
      const conversation = await ConversationModel.create({
        userId,
        organizationId,
        agentId: agent.id,
        title: "Test",
      });
      await seedSkill();
      // create two sandboxes for the same conversation; the resolver should
      // pick the latest one rather than erroring out on ambiguity.
      await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"] },
        { ...context, conversationId: conversation.id },
      );
      await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"] },
        { ...context, conversationId: conversation.id },
      );

      const result = await executeArchestraTool(
        TOOL_RUN_SKILL_COMMAND_FULL_NAME,
        { command: "echo hi" },
        { ...context, conversationId: conversation.id },
      );
      // resolver no longer rejects; the call reaches the runtime layer which
      // errors with "not enabled" in this test env. crucially, the message is
      // NOT the old "Multiple sandboxes" wording.
      expect(textOf(result)).not.toContain("Multiple sandboxes");
      expect(textOf(result)).toContain("not enabled");
    });

    test("delegates to the runtime service when the sandbox is resolved via conversation", async () => {
      await seedSkill();
      const conversation = await ConversationModel.create({
        userId,
        organizationId,
        agentId: agent.id,
        title: "Test",
      });
      const created = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"] },
        { ...context, conversationId: conversation.id },
      );
      const { sandboxId } = structuredOf<{ sandboxId: string }>(created);

      const runSpy = vi
        .spyOn(skillSandboxRuntimeService, "runCommand")
        .mockResolvedValue({
          commandId: "cmd-1",
          sandboxId: sandboxId as any,
          command: "echo hi",
          cwd: null,
          stdout: "hi\n",
          stderr: "",
          exitCode: 0,
          durationMs: 12,
          timedOut: false,
          truncated: false,
        });

      const result = await executeArchestraTool(
        TOOL_RUN_SKILL_COMMAND_FULL_NAME,
        { command: "echo hi" },
        { ...context, conversationId: conversation.id },
      );
      expect(result.isError).toBe(false);
      expect(runSpy).toHaveBeenCalledWith({
        sandboxId,
        command: "echo hi",
        cwd: undefined,
        timeoutSeconds: undefined,
      });
      const structured = structuredOf<{ exitCode: number; stdout: string }>(
        result,
      );
      expect(structured.exitCode).toBe(0);
      expect(structured.stdout).toBe("hi\n");
    });

    test("surfaces SkillSandboxError messages verbatim", async () => {
      await seedSkill();
      const created = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"] },
        context,
      );
      const { sandboxId } = structuredOf<{ sandboxId: string }>(created);

      vi.spyOn(skillSandboxRuntimeService, "runCommand").mockRejectedValue(
        new SkillSandboxError("the engine is unreachable"),
      );

      const result = await executeArchestraTool(
        TOOL_RUN_SKILL_COMMAND_FULL_NAME,
        { sandboxId, command: "echo hi" },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("the engine is unreachable");
    });
  });

  describe("get_skill_sandbox_artifact", () => {
    test("rejects when neither sandboxId nor conversation context is provided", async () => {
      const result = await executeArchestraTool(
        TOOL_GET_SKILL_SANDBOX_ARTIFACT_FULL_NAME,
        { path: "out/file.txt" },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("sandboxId");
    });

    test("delegates to the runtime service and returns artifact metadata", async () => {
      await seedSkill();
      const created = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"] },
        context,
      );
      const { sandboxId } = structuredOf<{ sandboxId: string }>(created);

      const exportSpy = vi
        .spyOn(skillSandboxRuntimeService, "exportArtifact")
        .mockResolvedValue({
          artifactId: "artifact-1",
          sandboxId: sandboxId as any,
          path: "/skills/pdf-processing/out/file.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
        });

      const result = await executeArchestraTool(
        TOOL_GET_SKILL_SANDBOX_ARTIFACT_FULL_NAME,
        { sandboxId, path: "out/file.txt", mimeType: "text/plain" },
        context,
      );
      expect(result.isError).toBe(false);
      expect(exportSpy).toHaveBeenCalledWith({
        sandboxId,
        path: "out/file.txt",
        mimeType: "text/plain",
      });
      const structured = structuredOf<{
        artifactId: string;
        sizeBytes: number;
        downloadUrl: string;
      }>(result);
      expect(structured.artifactId).toBe("artifact-1");
      expect(structured.sizeBytes).toBe(42);
      expect(structured.downloadUrl).toBe(
        "/api/skill-sandbox/artifacts/artifact-1",
      );
      // tool result is text-only — image bytes flow sandbox -> DB -> UI via
      // the download URL, never via the MCP content array (which the chat
      // layer would stringify into the LLM context).
      const contentTypes = (result.content as Array<{ type: string }>).map(
        (c) => c.type,
      );
      expect(contentTypes).toEqual(["text"]);
    });

    test("never attaches inline image content even for small raster artifacts", async () => {
      await seedSkill();
      const created = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"] },
        context,
      );
      const { sandboxId } = structuredOf<{ sandboxId: string }>(created);

      vi.spyOn(skillSandboxRuntimeService, "exportArtifact").mockResolvedValue({
        artifactId: "tiny-png",
        sandboxId: sandboxId as any,
        path: "/skills/pdf-processing/preview.png",
        mimeType: "image/png",
        sizeBytes: 256,
      });

      const result = await executeArchestraTool(
        TOOL_GET_SKILL_SANDBOX_ARTIFACT_FULL_NAME,
        { sandboxId, path: "preview.png", mimeType: "image/png" },
        context,
      );

      expect(result.isError).toBe(false);
      // even a tiny PNG must not produce an `image` content block; the chat
      // layer would JSON-stringify it into the LLM context.
      const contents = result.content as Array<{ type: string }>;
      expect(contents.map((c) => c.type)).toEqual(["text"]);
    });
  });

  describe("upload_skill_sandbox_file", () => {
    async function createSandbox(): Promise<string> {
      await seedSkill();
      const created = await executeArchestraTool(
        TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
        { skillNames: ["pdf-processing"] },
        context,
      );
      return structuredOf<{ sandboxId: string }>(created).sandboxId;
    }

    test("delegates to the runtime service and returns upload metadata", async () => {
      const sandboxId = await createSandbox();
      const spy = vi
        .spyOn(skillSandboxRuntimeService, "uploadFile")
        .mockResolvedValue({
          uploadId: "up-1",
          sandboxId: sandboxId as any,
          path: "/home/sandbox/data.csv",
          mimeType: "text/csv",
          sizeBytes: 5,
        });

      const result = await executeArchestraTool(
        TOOL_UPLOAD_SKILL_SANDBOX_FILE_FULL_NAME,
        {
          sandboxId,
          path: "data.csv",
          source: {
            type: "base64",
            dataBase64: Buffer.from("a,b,c").toString("base64"),
          },
        },
        context,
      );

      expect(result.isError).toBe(false);
      expect(spy).toHaveBeenCalledOnce();
      expect(structuredOf<{ uploadId: string }>(result).uploadId).toBe("up-1");
    });

    test("rejects a chat attachment from another conversation", async () => {
      const sandboxId = await createSandbox();
      const here = await ConversationModel.create({
        userId,
        organizationId,
        agentId: agent.id,
        title: "here",
      });
      const elsewhere = await ConversationModel.create({
        userId,
        organizationId,
        agentId: agent.id,
        title: "elsewhere",
      });
      const bytes = Buffer.from("secret", "utf8");
      const attachment = await ConversationAttachmentModel.create({
        organizationId,
        conversationId: elsewhere.id,
        uploadedByUserId: userId,
        originalName: "secret.txt",
        mimeType: "text/plain",
        fileSize: bytes.byteLength,
        contentHash: ConversationAttachmentModel.computeContentHash(bytes),
        fileData: bytes,
      });

      const uploadSpy = vi.spyOn(skillSandboxRuntimeService, "uploadFile");
      const result = await executeArchestraTool(
        TOOL_UPLOAD_SKILL_SANDBOX_FILE_FULL_NAME,
        {
          sandboxId,
          path: "secret.txt",
          source: { type: "chat_attachment", attachmentId: attachment.id },
        },
        { ...context, conversationId: here.id },
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("different conversation");
      expect(uploadSpy).not.toHaveBeenCalled();
    });

    // uploadFile does no Dagger work, so enabling the runtime engine lets these
    // exercise the real persistence + validation path against PGlite.
    describe("with the runtime engine available", () => {
      const originalDagger = config.daggerRuntime.enabled;
      beforeAll(() => {
        (config.daggerRuntime as { enabled: boolean }).enabled = true;
      });
      afterAll(() => {
        (config.daggerRuntime as { enabled: boolean }).enabled = originalDagger;
      });

      test("persists uploaded bytes as an ordered replay event", async () => {
        const sandboxId = await createSandbox();
        const bytes = Buffer.from("col1,col2\n1,2\n", "utf8");
        const result = await executeArchestraTool(
          TOOL_UPLOAD_SKILL_SANDBOX_FILE_FULL_NAME,
          {
            sandboxId,
            path: "data/input.csv",
            source: {
              type: "base64",
              dataBase64: bytes.toString("base64"),
              mimeType: "text/csv",
              originalName: "input.csv",
            },
          },
          context,
        );

        expect(result.isError).toBe(false);
        const structured = structuredOf<{ path: string; sizeBytes: number }>(
          result,
        );
        expect(structured.path).toBe("/skills/pdf-processing/data/input.csv");
        expect(structured.sizeBytes).toBe(bytes.byteLength);

        const log = await SkillSandboxReplayEventModel.listBySandbox(sandboxId);
        const uploads = log.filter((e) => e.kind === "upload");
        expect(uploads).toHaveLength(1);
        const [only] = uploads;
        if (only.kind !== "upload") throw new Error("expected an upload event");
        expect(only.upload.data.toString("utf8")).toBe(bytes.toString("utf8"));
        expect(only.upload.path).toBe("/skills/pdf-processing/data/input.csv");
      });

      test("rejects a path outside the sandbox roots", async () => {
        const sandboxId = await createSandbox();
        const result = await executeArchestraTool(
          TOOL_UPLOAD_SKILL_SANDBOX_FILE_FULL_NAME,
          {
            sandboxId,
            path: "/etc/passwd",
            source: { type: "text", text: "x" },
          },
          context,
        );
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("must be under");
      });

      test("rejects an upload larger than the configured limit", async () => {
        const sandboxId = await createSandbox();
        const original = config.skillsSandbox.artifactBytesLimit;
        (
          config.skillsSandbox as { artifactBytesLimit: number }
        ).artifactBytesLimit = 8;
        try {
          const result = await executeArchestraTool(
            TOOL_UPLOAD_SKILL_SANDBOX_FILE_FULL_NAME,
            {
              sandboxId,
              path: "big.txt",
              source: { type: "text", text: "way too many bytes" },
            },
            context,
          );
          expect(result.isError).toBe(true);
          expect(textOf(result)).toContain("too large");
        } finally {
          (
            config.skillsSandbox as { artifactBytesLimit: number }
          ).artifactBytesLimit = original;
        }
      });

      test("rejects an empty upload", async () => {
        const sandboxId = await createSandbox();
        const result = await executeArchestraTool(
          TOOL_UPLOAD_SKILL_SANDBOX_FILE_FULL_NAME,
          { sandboxId, path: "empty.txt", source: { type: "text", text: "" } },
          context,
        );
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("empty");
      });
    });
  });
});
