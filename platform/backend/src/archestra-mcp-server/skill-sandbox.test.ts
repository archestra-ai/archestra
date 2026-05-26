// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ADMIN_ROLE_NAME,
  TOOL_CREATE_SKILL_SANDBOX_FULL_NAME,
  TOOL_GET_SKILL_SANDBOX_ARTIFACT_FULL_NAME,
  TOOL_RUN_SKILL_COMMAND_FULL_NAME,
} from "@shared";
import config from "@/config";
import { ConversationModel, SkillModel, SkillSandboxModel } from "@/models";
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
      }>(result);
      expect(structured.artifactId).toBe("artifact-1");
      expect(structured.sizeBytes).toBe(42);
    });
  });
});
