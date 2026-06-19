// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ADMIN_ROLE_NAME,
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_SAVE_RESULT_FULL_NAME,
  TOOL_SEARCH_FILES_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
} from "@archestra/shared";
import config from "@/config";
import {
  ConversationAttachmentModel,
  ConversationModel,
  FileModel,
  ProjectModel,
  SkillModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
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
import type { Agent } from "@/types";
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

describe("sandbox tools (runtime disabled)", () => {
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
    expect(names).not.toContain(TOOL_RUN_COMMAND_FULL_NAME);
    expect(names).not.toContain(TOOL_DOWNLOAD_FILE_FULL_NAME);
    expect(names).not.toContain(TOOL_UPLOAD_FILE_FULL_NAME);
  });

  test("all sandbox tools require sandbox:execute", () => {
    const perm = { resource: "sandbox", action: "execute" };
    expect(TOOL_PERMISSIONS.run_command).toEqual(perm);
    expect(TOOL_PERMISSIONS.download_file).toEqual(perm);
    expect(TOOL_PERMISSIONS.upload_file).toEqual(perm);
  });

  test("run_command returns a clean error when the runtime is disabled", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    // The runtime-disabled catalog omits sandbox tools, so seeding can't assign
    // run_command. Assign it directly so execution reaches the "not enabled"
    // handler rather than the assignment gate.
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      name: TOOL_RUN_COMMAND_FULL_NAME,
      catalogId: catalog.id,
    });
    await makeAgentTool(context.agentId as string, tool.id);

    const result = await executeArchestraTool(
      TOOL_RUN_COMMAND_FULL_NAME,
      { command: "echo hi" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Error: The sandbox is not enabled on this deployment.",
    );
  });
});

describe("sandbox tools (runtime enabled)", () => {
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

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeMember,
      seedAndAssignArchestraTools,
    }) => {
      agent = await makeAgent({ name: "Sandbox Agent" });
      organizationId = agent.organizationId;
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      userId = user.id;
      // Sandbox tools are gated by per-agent assignment (plus sandbox:execute),
      // so assign the full Archestra set (seeded with the runtime enabled).
      await seedAndAssignArchestraTools(agent.id);
      context = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId,
        userId,
      };
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeConversationCtx(): Promise<ArchestraContext> {
    const conversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: agent.id,
      title: "Test",
    });
    return { ...context, conversationId: conversation.id };
  }

  function stubRunCommand(sandboxId: string) {
    return vi
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
        binaryStripped: false,
        stagingNotices: [],
      });
  }

  describe("run_command", () => {
    test("lazily creates the conversation default sandbox and delegates to it", async () => {
      const ctx = await makeConversationCtx();
      const runSpy = vi
        .spyOn(skillSandboxRuntimeService, "runCommand")
        .mockResolvedValue({
          commandId: "cmd-1",
          sandboxId: "placeholder" as any,
          command: "echo hi",
          cwd: null,
          stdout: "hi\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
          truncated: false,
          binaryStripped: false,
          stagingNotices: [],
        });

      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      expect(result.isError).toBe(false);

      // a single default sandbox was created for the conversation...
      const sandboxes = await SkillSandboxModel.listForConversation({
        conversationId: ctx.conversationId as string,
        organizationId,
      });
      expect(sandboxes).toHaveLength(1);
      expect(sandboxes[0].isDefault).toBe(true);
      expect(sandboxes[0].defaultCwd).toBe("/home/sandbox");
      // ...and the command was delegated to it.
      expect(runSpy).toHaveBeenCalledWith({
        sandboxId: sandboxes[0].id,
        caller: { organizationId, userId },
        command: "echo hi",
        cwd: undefined,
        timeoutSeconds: undefined,
      });
    });

    test("surfaces the truncation warning before stdout", async () => {
      const ctx = await makeConversationCtx();
      vi.spyOn(skillSandboxRuntimeService, "runCommand").mockResolvedValue({
        commandId: "cmd-1",
        sandboxId: "x" as any,
        command: "cat big",
        cwd: null,
        stdout: "partial output\n",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
        truncated: true,
        binaryStripped: false,
        stagingNotices: [],
      });

      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "cat big" },
        ctx,
      );
      const text = textOf(result);
      expect(text).toContain("Output was truncated");
      // the model must see the warning before it starts reading the blob.
      expect(text.indexOf("Output was truncated")).toBeLessThan(
        text.indexOf("stdout:"),
      );
      // the old trailing marker is gone — no duplicate warning at the end.
      expect(text).not.toContain("(output was truncated)");
    });

    test("surfaces a binary-output warning before stdout, but not on clean text", async () => {
      const ctx = await makeConversationCtx();
      const spy = vi.spyOn(skillSandboxRuntimeService, "runCommand");
      spy.mockResolvedValue({
        commandId: "cmd-1",
        sandboxId: "x" as any,
        command: "cat image.png",
        cwd: null,
        stdout: "PNGdata\n",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
        truncated: false,
        binaryStripped: true,
        stagingNotices: [],
      });

      const dirty = textOf(
        await executeArchestraTool(
          TOOL_RUN_COMMAND_FULL_NAME,
          { command: "cat image.png" },
          ctx,
        ),
      );
      expect(dirty).toContain("binary (NUL) bytes");
      expect(dirty).toContain("download_file");
      // the model must see the warning before it starts reading the blob.
      expect(dirty.indexOf("binary (NUL) bytes")).toBeLessThan(
        dirty.indexOf("stdout:"),
      );

      // happy path: no binary stripped → no warning leaks into the summary.
      spy.mockResolvedValue({
        commandId: "cmd-2",
        sandboxId: "x" as any,
        command: "echo hi",
        cwd: null,
        stdout: "hi\n",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
        truncated: false,
        binaryStripped: false,
        stagingNotices: [],
      });
      const clean = textOf(
        await executeArchestraTool(
          TOOL_RUN_COMMAND_FULL_NAME,
          { command: "echo hi" },
          ctx,
        ),
      );
      expect(clean).not.toContain("binary (NUL) bytes");
    });

    test("omits the truncation warning when output is complete", async () => {
      const ctx = await makeConversationCtx();
      stubRunCommand("x");

      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      expect(textOf(result)).not.toContain("truncated");
    });

    test("guides to timeoutSeconds when the model passes timeout", async () => {
      const ctx = await makeConversationCtx();
      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", timeout: 5 } as any,
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('did you mean "timeoutSeconds"?');
    });

    test("reuses the same default sandbox across calls in a conversation", async () => {
      const ctx = await makeConversationCtx();
      stubRunCommand("x");

      await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo 1" },
        ctx,
      );
      await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo 2" },
        ctx,
      );

      const sandboxes = await SkillSandboxModel.listForConversation({
        conversationId: ctx.conversationId as string,
        organizationId,
      });
      expect(sandboxes).toHaveLength(1);
    });

    test("rejects the default sandbox when there is neither a conversation nor an isolation scope", async () => {
      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        context,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No conversation context");
    });

    test("returns a clean error when the conversation was deleted mid-run", async () => {
      const ctx = await makeConversationCtx();
      stubRunCommand("x");
      await ConversationModel.delete(
        ctx.conversationId as string,
        userId,
        organizationId,
      );

      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("no longer exists");
    });

    test("target {fresh} creates a new non-default sandbox", async () => {
      const ctx = await makeConversationCtx();
      const runSpy = stubRunCommand("x");

      await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { fresh: true } },
        ctx,
      );

      const sandboxes = await SkillSandboxModel.listForConversation({
        conversationId: ctx.conversationId as string,
        organizationId,
      });
      expect(sandboxes).toHaveLength(1);
      expect(sandboxes[0].isDefault).toBe(false);
      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxId: sandboxes[0].id }),
      );
    });

    test("target {fresh:false} resolves to the conversation default sandbox", async () => {
      const ctx = await makeConversationCtx();
      const runSpy = stubRunCommand("x");

      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { fresh: false } },
        ctx,
      );

      expect(result.isError).toBeFalsy();
      const sandboxes = await SkillSandboxModel.listForConversation({
        conversationId: ctx.conversationId as string,
        organizationId,
      });
      expect(sandboxes).toHaveLength(1);
      expect(sandboxes[0].isDefault).toBe(true);
      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxId: sandboxes[0].id }),
      );
    });

    test("target with an empty id resolves to the conversation default sandbox", async () => {
      const ctx = await makeConversationCtx();
      const runSpy = stubRunCommand("x");

      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { id: "" } },
        ctx,
      );

      expect(result.isError).toBeFalsy();
      const sandboxes = await SkillSandboxModel.listForConversation({
        conversationId: ctx.conversationId as string,
        organizationId,
      });
      expect(sandboxes).toHaveLength(1);
      expect(sandboxes[0].isDefault).toBe(true);
      expect(runSpy).toHaveBeenCalled();
    });

    test("target with a non-empty but malformed id returns a clear error", async () => {
      const ctx = await makeConversationCtx();
      stubRunCommand("x");

      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { id: "not-a-uuid" } },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("UUID");
    });

    test("target {id} from a different conversation is rejected", async () => {
      const ctxA = await makeConversationCtx();
      stubRunCommand("x");
      // create a default sandbox in conversation A
      await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctxA,
      );
      const [sandboxA] = await SkillSandboxModel.listForConversation({
        conversationId: ctxA.conversationId as string,
        organizationId,
      });

      // a different conversation cannot reach it by id
      const ctxB = await makeConversationCtx();
      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { id: sandboxA.id } },
        ctxB,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No accessible sandbox");
      expect(textOf(result)).toContain("fresh: true");
    });

    test("target {id} owned by another user is rejected", async ({
      makeUser,
      makeMember,
    }) => {
      const ctx = await makeConversationCtx();
      stubRunCommand("x");
      await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      const [sandbox] = await SkillSandboxModel.listForConversation({
        conversationId: ctx.conversationId as string,
        organizationId,
      });

      const otherAdmin = await makeUser();
      await makeMember(otherAdmin.id, organizationId, {
        role: ADMIN_ROLE_NAME,
      });
      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { id: sandbox.id } },
        { ...ctx, userId: otherAdmin.id },
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No accessible sandbox");
    });

    test("surfaces SkillSandboxError messages verbatim", async () => {
      const ctx = await makeConversationCtx();
      vi.spyOn(skillSandboxRuntimeService, "runCommand").mockRejectedValue(
        new SkillSandboxError("the engine is unreachable"),
      );
      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("the engine is unreachable");
    });
  });

  describe("headless executions (isolation key, no conversation)", () => {
    function headlessCtx(): ArchestraContext {
      return { ...context, isolationKey: crypto.randomUUID() };
    }

    function resolvedSandboxId(
      runSpy: ReturnType<typeof stubRunCommand>,
      callIndex: number,
    ): string {
      return (runSpy.mock.calls[callIndex][0] as { sandboxId: string })
        .sandboxId;
    }

    test("default target creates one conversation-less sandbox and reuses it", async () => {
      const ctx = headlessCtx();
      const runSpy = stubRunCommand("x");

      const first = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo 1" },
        ctx,
      );
      const second = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo 2" },
        ctx,
      );
      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);

      const sandboxId = resolvedSandboxId(runSpy, 0);
      expect(resolvedSandboxId(runSpy, 1)).toBe(sandboxId);

      // never a fake conversation id, never default-flagged (the partial
      // unique index cannot protect null-conversation defaults).
      const row = await SkillSandboxModel.findById(sandboxId);
      expect(row?.conversationId).toBeNull();
      expect(row?.isDefault).toBe(false);
    });

    test("concurrent first calls share a single sandbox", async () => {
      const ctx = headlessCtx();
      const runSpy = stubRunCommand("x");

      const [first, second] = await Promise.all([
        executeArchestraTool(
          TOOL_RUN_COMMAND_FULL_NAME,
          { command: "echo 1" },
          ctx,
        ),
        executeArchestraTool(
          TOOL_RUN_COMMAND_FULL_NAME,
          { command: "echo 2" },
          ctx,
        ),
      ]);
      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
      expect(resolvedSandboxId(runSpy, 0)).toBe(resolvedSandboxId(runSpy, 1));
    });

    test("explicit {id} is scoped to the owning execution", async () => {
      const ctxA = headlessCtx();
      const runSpy = stubRunCommand("x");
      await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctxA,
      );
      const sandboxId = resolvedSandboxId(runSpy, 0);

      // the owning execution can target it explicitly...
      const sameExecution = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { id: sandboxId } },
        ctxA,
      );
      expect(sameExecution.isError).toBe(false);

      // ...another execution cannot...
      const otherExecution = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { id: sandboxId } },
        headlessCtx(),
      );
      expect(otherExecution.isError).toBe(true);
      expect(textOf(otherExecution)).toContain("No accessible sandbox");

      // ...and neither can a conversation-scoped caller.
      const fromConversation = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { id: sandboxId } },
        await makeConversationCtx(),
      );
      expect(fromConversation.isError).toBe(true);
    });

    test("{fresh: true} sandbox is addressable by id within the same execution", async () => {
      const ctx = headlessCtx();
      const runSpy = stubRunCommand("x");
      await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { fresh: true } },
        ctx,
      );
      const sandboxId = resolvedSandboxId(runSpy, 0);
      const row = await SkillSandboxModel.findById(sandboxId);
      expect(row?.conversationId).toBeNull();
      expect(row?.isDefault).toBe(false);

      const sameExecution = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { id: sandboxId } },
        ctx,
      );
      expect(sameExecution.isError).toBe(false);

      const otherExecution = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { id: sandboxId } },
        headlessCtx(),
      );
      expect(otherExecution.isError).toBe(true);
    });

    test("a released execution scope gets a fresh sandbox afterwards", async () => {
      const ctx = headlessCtx();
      const runSpy = stubRunCommand("x");
      await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      const before = resolvedSandboxId(runSpy, 0);

      executionSandboxRegistry.release(ctx.isolationKey as string);

      await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      expect(resolvedSandboxId(runSpy, 1)).not.toBe(before);
    });
  });

  describe("download_file", () => {
    test("delegates to the runtime service and returns fileId + downloadUrl", async () => {
      const ctx = await makeConversationCtx();
      const exportSpy = vi
        .spyOn(skillSandboxRuntimeService, "exportArtifact")
        .mockResolvedValue({
          artifactId: "artifact-1",
          sandboxId: "sb" as any,
          path: "/home/sandbox/out/file.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
          stagingNotices: [],
        });

      const result = await executeArchestraTool(
        TOOL_DOWNLOAD_FILE_FULL_NAME,
        { path: "out/file.txt", mimeType: "text/plain" },
        ctx,
      );
      expect(result.isError).toBe(false);
      expect(exportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "out/file.txt",
          mimeType: "text/plain",
        }),
      );
      const structured = structuredOf<{
        fileId: string;
        sizeBytes: number;
        downloadUrl: string;
      }>(result);
      expect(structured.fileId).toBe("artifact-1");
      expect(structured.sizeBytes).toBe(42);
      expect(structured.downloadUrl).toBe(
        "/api/skill-sandbox/artifacts/artifact-1",
      );
      // text-only — bytes flow sandbox -> DB -> UI via the URL, never via the
      // MCP content array (which the chat layer would stringify into context).
      const contentTypes = (result.content as Array<{ type: string }>).map(
        (c) => c.type,
      );
      expect(contentTypes).toEqual(["text"]);
    });

    test("never attaches inline image content even for small raster files", async () => {
      const ctx = await makeConversationCtx();
      vi.spyOn(skillSandboxRuntimeService, "exportArtifact").mockResolvedValue({
        artifactId: "tiny-png",
        sandboxId: "sb" as any,
        path: "/home/sandbox/preview.png",
        mimeType: "image/png",
        sizeBytes: 256,
        stagingNotices: [],
      });

      const result = await executeArchestraTool(
        TOOL_DOWNLOAD_FILE_FULL_NAME,
        { path: "preview.png", mimeType: "image/png" },
        ctx,
      );
      expect(result.isError).toBe(false);
      const contents = result.content as Array<{ type: string }>;
      expect(contents.map((c) => c.type)).toEqual(["text"]);
    });
  });

  describe("upload_file", () => {
    test("delegates to the runtime service and returns upload metadata", async () => {
      const ctx = await makeConversationCtx();
      const spy = vi
        .spyOn(skillSandboxRuntimeService, "uploadFile")
        .mockResolvedValue({
          uploadId: "up-1",
          sandboxId: "sb" as any,
          path: "/home/sandbox/data.csv",
          mimeType: "text/csv",
          sizeBytes: 5,
        });

      const result = await executeArchestraTool(
        TOOL_UPLOAD_FILE_FULL_NAME,
        {
          path: "data.csv",
          source: {
            type: "base64",
            dataBase64: Buffer.from("a,b,c").toString("base64"),
          },
        },
        ctx,
      );
      expect(result.isError).toBe(false);
      expect(spy).toHaveBeenCalledOnce();
      expect(structuredOf<{ uploadId: string }>(result).uploadId).toBe("up-1");
    });

    test("enumerates the source variants when the discriminator is missing", async () => {
      const ctx = await makeConversationCtx();
      const uploadSpy = vi.spyOn(skillSandboxRuntimeService, "uploadFile");
      // the failure from the transcript: a model guessing the source shape gets
      // an opaque "source.type: Invalid input" and never recovers.
      const result = await executeArchestraTool(
        TOOL_UPLOAD_FILE_FULL_NAME,
        { path: "out.py", source: { text: "print('hi')" } },
        ctx,
      );
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("Validation error in");
      expect(text).toContain(
        'source.type: set "type" to one of: "chat_attachment", "base64", "text"',
      );
      expect(uploadSpy).not.toHaveBeenCalled();
    });

    test("rejects a chat attachment from another conversation", async () => {
      const ctx = await makeConversationCtx();
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
        TOOL_UPLOAD_FILE_FULL_NAME,
        {
          path: "secret.txt",
          source: { type: "chat_attachment", attachmentId: attachment.id },
        },
        ctx,
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
        const ctx = await makeConversationCtx();
        const bytes = Buffer.from("col1,col2\n1,2\n", "utf8");
        const result = await executeArchestraTool(
          TOOL_UPLOAD_FILE_FULL_NAME,
          {
            path: "data/input.csv",
            source: {
              type: "base64",
              dataBase64: bytes.toString("base64"),
              mimeType: "text/csv",
              originalName: "input.csv",
            },
          },
          ctx,
        );
        expect(result.isError).toBe(false);
        const structured = structuredOf<{
          sandboxId: string;
          path: string;
          sizeBytes: number;
        }>(result);
        // default cwd is /home/sandbox, so a relative path resolves there.
        expect(structured.path).toBe("/home/sandbox/data/input.csv");
        expect(structured.sizeBytes).toBe(bytes.byteLength);

        const log = await SkillSandboxReplayEventModel.listBySandbox(
          structured.sandboxId,
        );
        const uploads = log.filter((e) => e.kind === "upload");
        expect(uploads).toHaveLength(1);
        const [only] = uploads;
        if (only.kind !== "upload") throw new Error("expected an upload event");
        expect(only.upload.data?.toString("utf8")).toBe(bytes.toString("utf8"));
        expect(only.upload.path).toBe("/home/sandbox/data/input.csv");
      });

      test("rejects a path outside the sandbox roots", async () => {
        const ctx = await makeConversationCtx();
        const result = await executeArchestraTool(
          TOOL_UPLOAD_FILE_FULL_NAME,
          { path: "/etc/passwd", source: { type: "text", text: "x" } },
          ctx,
        );
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("must be under");
      });

      test("rejects an upload larger than the configured limit", async () => {
        const ctx = await makeConversationCtx();
        const original = config.skillsSandbox.artifactBytesLimit;
        (
          config.skillsSandbox as { artifactBytesLimit: number }
        ).artifactBytesLimit = 8;
        try {
          const result = await executeArchestraTool(
            TOOL_UPLOAD_FILE_FULL_NAME,
            {
              path: "big.txt",
              source: { type: "text", text: "way too many bytes" },
            },
            ctx,
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
        const ctx = await makeConversationCtx();
        const result = await executeArchestraTool(
          TOOL_UPLOAD_FILE_FULL_NAME,
          { path: "empty.txt", source: { type: "text", text: "" } },
          ctx,
        );
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("empty");
      });

      // a path the Rust replay validator would reject must fail the tool call up
      // front; otherwise it persists as an event that breaks every later replay.
      test("rejects a shell-metacharacter path without persisting anything", async () => {
        const ctx = await makeConversationCtx();
        const result = await executeArchestraTool(
          TOOL_UPLOAD_FILE_FULL_NAME,
          { path: "data/in$put.csv", source: { type: "text", text: "x" } },
          ctx,
        );
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("invalid upload path");

        const [sandbox] = await SkillSandboxModel.listForConversation({
          conversationId: ctx.conversationId as string,
          organizationId,
        });
        if (sandbox) {
          const log = await SkillSandboxReplayEventModel.listBySandbox(
            sandbox.id,
          );
          expect(log.filter((e) => e.kind === "upload")).toHaveLength(0);
        }
      });
    });

    // the real runtime is enabled here (no runCommand mock) so the revocation
    // gate runs; a deleted skill must fail the call before any container build.
    describe("revocation gate", () => {
      const originalDagger = config.daggerRuntime.enabled;
      beforeAll(() => {
        (config.daggerRuntime as { enabled: boolean }).enabled = true;
      });
      afterAll(() => {
        (config.daggerRuntime as { enabled: boolean }).enabled = originalDagger;
      });

      test("run_command fails before materialize when a mounted skill was deleted", async () => {
        const ctx = await makeConversationCtx();
        const skill = await SkillModel.createWithFiles({
          skill: {
            organizationId,
            authorId: null,
            name: "doomed",
            description: "desc",
            content: "# doomed",
            metadata: {},
            sourceType: "manual",
            scope: "org",
          },
          files: [],
        });
        if (!skill) throw new Error("skill seed failed");
        const v1 = await SkillVersionModel.findBySkillAndVersion(skill.id, 1);
        if (!v1) throw new Error("missing v1");

        const sandbox = await SkillSandboxModel.findOrCreateDefault({
          organizationId,
          userId,
          conversationId: ctx.conversationId as string,
          defaultCwd: "/home/sandbox",
        });
        await SkillSandboxReplayEventModel.appendSkillMount({
          sandboxId: sandbox.id,
          organizationId,
          mount: {
            skillId: skill.id,
            skillName: skill.name,
            skillVersionId: v1.id,
          },
        });

        // revoke by deleting the source skill; the mount's durable skillId
        // no longer resolves, so the gate fails closed.
        await SkillModel.delete(skill.id);

        const result = await executeArchestraTool(
          TOOL_RUN_COMMAND_FULL_NAME,
          { command: "echo hi" },
          ctx,
        );
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("no longer exists");
      });
    });
  });
});

describe("PFS tools (search_files, my_file source, download_file project)", () => {
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

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeMember,
      seedAndAssignArchestraTools,
    }) => {
      agent = await makeAgent({ name: "PFS Agent" });
      organizationId = agent.organizationId;
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      userId = user.id;
      await seedAndAssignArchestraTools(agent.id);
      context = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId,
        userId,
      };
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeConversationCtx(): Promise<ArchestraContext> {
    const conversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: agent.id,
      title: "PFS Test",
    });
    return { ...context, conversationId: conversation.id };
  }

  async function seedPfsArtifact(filename: string, content = "abc") {
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    return FileModel.create({
      organizationId,
      userId,
      projectId: null,
      conversationId: null,
      sandboxId: sandbox.id,
      filename,
      mimeType: "text/plain",
      sizeBytes: content.length,
      data: Buffer.from(content),
    });
  }

  describe("search_files", () => {
    test("lists and filters the user's persistent files", async () => {
      await seedPfsArtifact("q2-report.txt");
      await seedPfsArtifact("notes.txt");

      const all = await executeArchestraTool(
        TOOL_SEARCH_FILES_FULL_NAME,
        {},
        context,
      );
      expect(all.isError).toBe(false);
      const allOut = structuredOf<{
        files: Array<{ filename: string; id: string | null }>;
      }>(all);
      expect(allOut.files.map((f) => f.filename).sort()).toEqual([
        "notes.txt",
        "q2-report.txt",
      ]);
      expect(allOut.files.every((f) => f.id)).toBe(true);

      const filtered = await executeArchestraTool(
        TOOL_SEARCH_FILES_FULL_NAME,
        { query: "REPORT" },
        context,
      );
      const filteredOut = structuredOf<{ files: Array<{ filename: string }> }>(
        filtered,
      );
      expect(filteredOut.files.map((f) => f.filename)).toEqual([
        "q2-report.txt",
      ]);
      expect(textOf(filtered)).toContain("q2-report.txt");
    });

    test("never returns another user's files", async ({ makeUser }) => {
      await seedPfsArtifact("mine.txt");
      const stranger = await makeUser({ email: "pfs-stranger@test.com" });
      const strangerSandbox = await SkillSandboxModel.create({
        organizationId,
        userId: stranger.id,
        conversationId: null,
        defaultCwd: "/home/sandbox",
      });
      await FileModel.create({
        organizationId,
        userId: stranger.id,
        projectId: null,
        conversationId: null,
        sandboxId: strangerSandbox.id,
        filename: "theirs.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        data: Buffer.from("x"),
      });

      const result = await executeArchestraTool(
        TOOL_SEARCH_FILES_FULL_NAME,
        {},
        context,
      );
      const out = structuredOf<{ files: Array<{ filename: string }> }>(result);
      expect(out.files.map((f) => f.filename)).toEqual(["mine.txt"]);
    });
  });

  describe("upload_file my_file source", () => {
    test("loads PFS bytes by id and marks the upload origin", async () => {
      const ctx = await makeConversationCtx();
      const artifact = await seedPfsArtifact("pull-me.txt", "pfs-bytes");
      const spy = vi
        .spyOn(skillSandboxRuntimeService, "uploadFile")
        .mockResolvedValue({
          uploadId: "up-x",
          sandboxId: "sb" as any,
          path: "/home/sandbox/pull-me.txt",
          mimeType: "text/plain",
          sizeBytes: 9,
        });

      const result = await executeArchestraTool(
        TOOL_UPLOAD_FILE_FULL_NAME,
        {
          path: "pull-me.txt",
          source: { type: "my_file", id: artifact.id },
        },
        ctx,
      );
      expect(result.isError).toBe(false);
      expect(spy).toHaveBeenCalledOnce();
      const call = spy.mock.calls[0][0];
      expect(call.origin).toBe("my_file");
      expect(call.data.toString()).toBe("pfs-bytes");
      expect(call.originalName).toBe("pull-me.txt");
    });

    test("rejects an unknown reference with a search_files hint", async () => {
      const ctx = await makeConversationCtx();
      const spy = vi.spyOn(skillSandboxRuntimeService, "uploadFile");
      const result = await executeArchestraTool(
        TOOL_UPLOAD_FILE_FULL_NAME,
        {
          path: "x.txt",
          source: { type: "my_file", filename: "does-not-exist.txt" },
        },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("search_files");
      expect(spy).not.toHaveBeenCalled();
    });

    test("requires exactly one of id or filename", async () => {
      const ctx = await makeConversationCtx();
      const result = await executeArchestraTool(
        TOOL_UPLOAD_FILE_FULL_NAME,
        { path: "x.txt", source: { type: "my_file" } },
        ctx,
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("download_file project scoping", () => {
    test("non-project chats export with no project", async () => {
      const ctx = await makeConversationCtx();
      const spy = vi
        .spyOn(skillSandboxRuntimeService, "exportArtifact")
        .mockResolvedValue({
          artifactId: "art-0",
          sandboxId: "sb" as any,
          path: "/home/sandbox/out.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
          stagingNotices: [],
        });

      const result = await executeArchestraTool(
        TOOL_DOWNLOAD_FILE_FULL_NAME,
        { path: "out.txt" },
        ctx,
      );
      expect(result.isError).toBe(false);
      expect(spy.mock.calls[0][0].projectId).toBeNull();
    });

    test("project chats force the project id", async () => {
      const project = await ProjectModel.create({
        organizationId,
        userId,
        name: "tool-proj",
        description: null,
      });
      const conversation = await ConversationModel.create({
        userId,
        organizationId,
        agentId: agent.id,
        projectId: project.id,
        title: "in project",
      });
      const ctx = { ...context, conversationId: conversation.id };

      const spy = vi
        .spyOn(skillSandboxRuntimeService, "exportArtifact")
        .mockResolvedValue({
          artifactId: "art-1",
          sandboxId: "sb" as any,
          path: "/home/sandbox/out.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
          stagingNotices: [],
        });

      const result = await executeArchestraTool(
        TOOL_DOWNLOAD_FILE_FULL_NAME,
        { path: "out.txt" },
        ctx,
      );
      expect(result.isError).toBe(false);
      expect(spy.mock.calls[0][0].projectId).toBe(project.id);
    });
  });
});

describe("project file scope (save_result, scoped search/my_file)", () => {
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

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeMember,
      seedAndAssignArchestraTools,
    }) => {
      agent = await makeAgent({ name: "Scope Agent" });
      organizationId = agent.organizationId;
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      userId = user.id;
      await seedAndAssignArchestraTools(agent.id);
      context = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId,
        userId,
      };
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeProjectChatCtx(name: string) {
    const project = await ProjectModel.create({
      organizationId,
      userId,
      name,
      description: null,
    });
    const conversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: agent.id,
      projectId: project.id,
      title: name,
    });
    return {
      project,
      ctx: { ...context, conversationId: conversation.id },
    };
  }

  async function makePlainChatCtx() {
    const conversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: agent.id,
      title: "plain",
    });
    return { ...context, conversationId: conversation.id };
  }

  const SAVE_RESULT_FULL_NAME = "archestra__save_result";

  test("save_result persists inline content to the PFS root without a project", async () => {
    const ctx = await makePlainChatCtx();
    const result = await executeArchestraTool(
      SAVE_RESULT_FULL_NAME,
      { filename: "joke.md", content: "# why did the test pass\n" },
      ctx,
    );
    expect(result.isError).toBe(false);
    const out = structuredOf<{
      fileId: string;
      projectName: string | null;
      downloadUrl: string;
    }>(result);
    expect(out.projectName).toBeNull();
    expect(out.downloadUrl).toBe(`/api/skill-sandbox/artifacts/${out.fileId}`);

    const { FileModel } = await import("@/models");
    const row = await FileModel.findById(out.fileId);
    expect(row).not.toBeNull();
    expect(row?.projectId).toBeNull();
  });

  test("save_result lands in the project in a project chat", async () => {
    const { project, ctx } = await makeProjectChatCtx("save-here");
    const result = await executeArchestraTool(
      SAVE_RESULT_FULL_NAME,
      { filename: "result.md", content: "done" },
      ctx,
    );
    expect(result.isError).toBe(false);
    const out = structuredOf<{ fileId: string; projectName: string }>(result);
    expect(out.projectName).toBe("save-here");

    const { FileModel } = await import("@/models");
    const row = await FileModel.findById(out.fileId);
    expect(row?.projectId).toBe(project.id);
  });

  test("save_result validates filename, content presence, and size", async () => {
    const ctx = await makePlainChatCtx();
    const badName = await executeArchestraTool(
      SAVE_RESULT_FULL_NAME,
      { filename: "../escape.md", content: "x" },
      ctx,
    );
    expect(badName.isError).toBe(true);

    const empty = await executeArchestraTool(
      SAVE_RESULT_FULL_NAME,
      { filename: "empty.md", content: "" },
      ctx,
    );
    expect(empty.isError).toBe(true);

    const both = await executeArchestraTool(
      SAVE_RESULT_FULL_NAME,
      { filename: "x.md", content: "a", contentBase64: "YQ==" },
      ctx,
    );
    expect(both.isError).toBe(true);
  });

  test("search_files in a project chat sees only the project's files", async () => {
    const { project, ctx } = await makeProjectChatCtx("searchable");
    const { FileModel, SkillSandboxModel } = await import("@/models");
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    await FileModel.create({
      organizationId,
      userId,
      projectId: project.id,
      conversationId: null,
      sandboxId: sandbox.id,
      filename: "inside.txt",
      mimeType: "text/plain",
      sizeBytes: 2,
      data: Buffer.from("in"),
    });
    await FileModel.create({
      organizationId,
      userId,
      projectId: null,
      conversationId: null,
      sandboxId: sandbox.id,
      filename: "outside.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("out"),
    });

    const result = await executeArchestraTool(
      TOOL_SEARCH_FILES_FULL_NAME,
      {},
      ctx,
    );
    const out = structuredOf<{
      files: Array<{ filename: string }>;
    }>(result);
    expect(out.files.map((f) => f.filename)).toEqual(["inside.txt"]);
  });

  test("my_file uploads in a project chat are confined to the project", async () => {
    const { project, ctx } = await makeProjectChatCtx("confined");
    const { FileModel, SkillSandboxModel } = await import("@/models");
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    const inside = await FileModel.create({
      organizationId,
      userId,
      projectId: project.id,
      conversationId: null,
      sandboxId: sandbox.id,
      filename: "in.txt",
      mimeType: "text/plain",
      sizeBytes: 2,
      data: Buffer.from("in"),
    });
    const outside = await FileModel.create({
      organizationId,
      userId,
      projectId: null,
      conversationId: null,
      sandboxId: sandbox.id,
      filename: "out.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("out"),
    });

    const spy = vi
      .spyOn(skillSandboxRuntimeService, "uploadFile")
      .mockResolvedValue({
        uploadId: "up-1",
        sandboxId: "sb" as any,
        path: "/home/sandbox/in.txt",
        mimeType: "text/plain",
        sizeBytes: 2,
      });

    const ok = await executeArchestraTool(
      TOOL_UPLOAD_FILE_FULL_NAME,
      { path: "in.txt", source: { type: "my_file", id: inside.id } },
      ctx,
    );
    expect(ok.isError).toBe(false);
    expect(spy.mock.calls[0][0].data.toString()).toBe("in");

    const denied = await executeArchestraTool(
      TOOL_UPLOAD_FILE_FULL_NAME,
      { path: "out.txt", source: { type: "my_file", id: outside.id } },
      ctx,
    );
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("project");
  });
});

describe("projects feature gating (search_files / save_result / my_file)", () => {
  const originalSandbox = config.skillsSandbox.enabled;
  const originalProjects = config.projects.enabled;

  beforeAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
  });
  afterAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalSandbox;
    (config.projects as { enabled: boolean }).enabled = originalProjects;
  });

  afterEach(() => {
    (config.projects as { enabled: boolean }).enabled = originalProjects;
    vi.restoreAllMocks();
  });

  test("tools/list hides the PFS tools when projects is off, keeps the rest", () => {
    (config.projects as { enabled: boolean }).enabled = false;
    const off = getArchestraMcpTools().map((tool) => tool.name);
    expect(off).not.toContain(TOOL_SEARCH_FILES_FULL_NAME);
    expect(off).not.toContain(TOOL_SAVE_RESULT_FULL_NAME);
    // the non-gated sandbox surface is still advertised
    expect(off).toContain(TOOL_RUN_COMMAND_FULL_NAME);
    expect(off).toContain(TOOL_DOWNLOAD_FILE_FULL_NAME);
    expect(off).toContain(TOOL_UPLOAD_FILE_FULL_NAME);

    (config.projects as { enabled: boolean }).enabled = true;
    const on = getArchestraMcpTools().map((tool) => tool.name);
    for (const name of [
      TOOL_SEARCH_FILES_FULL_NAME,
      TOOL_SAVE_RESULT_FULL_NAME,
      TOOL_RUN_COMMAND_FULL_NAME,
      TOOL_DOWNLOAD_FILE_FULL_NAME,
      TOOL_UPLOAD_FILE_FULL_NAME,
    ]) {
      expect(on).toContain(name);
    }
  });

  describe("with the runtime active", () => {
    let context: ArchestraContext;
    let userId: string;
    let organizationId: string;
    let agentId: string;

    beforeEach(
      async ({
        makeAgent,
        makeUser,
        makeMember,
        seedAndAssignArchestraTools,
      }) => {
        const agent = await makeAgent({ name: "Gate Agent" });
        organizationId = agent.organizationId;
        agentId = agent.id;
        const user = await makeUser();
        await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
        userId = user.id;
        await seedAndAssignArchestraTools(agent.id);
        context = {
          agent: { id: agent.id, name: agent.name },
          agentId: agent.id,
          organizationId,
          userId,
        };
      },
    );

    test("execute refuses search_files / save_result with -32601 when off", async () => {
      (config.projects as { enabled: boolean }).enabled = false;

      await expect(
        executeArchestraTool(TOOL_SEARCH_FILES_FULL_NAME, {}, context),
      ).rejects.toMatchObject({
        code: -32601,
        message: expect.stringContaining(
          `No tool named "${TOOL_SEARCH_FILES_FULL_NAME}" exists`,
        ),
      });

      await expect(
        executeArchestraTool(
          TOOL_SAVE_RESULT_FULL_NAME,
          { filename: "x.txt", content: "hi" },
          context,
        ),
      ).rejects.toMatchObject({
        code: -32601,
        message: expect.stringContaining(
          `No tool named "${TOOL_SAVE_RESULT_FULL_NAME}" exists`,
        ),
      });
    });

    test("upload_file rejects the my_file source when projects is off", async () => {
      (config.projects as { enabled: boolean }).enabled = false;
      const conversation = await ConversationModel.create({
        userId,
        organizationId,
        agentId,
        title: "gate",
      });
      const spy = vi.spyOn(skillSandboxRuntimeService, "uploadFile");

      const result = await executeArchestraTool(
        TOOL_UPLOAD_FILE_FULL_NAME,
        {
          path: "x.txt",
          source: { type: "my_file", filename: "anything.txt" },
        },
        { ...context, conversationId: conversation.id },
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("my_file");
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
