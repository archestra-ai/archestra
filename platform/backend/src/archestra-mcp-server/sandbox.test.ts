// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ADMIN_ROLE_NAME,
  PROJECT_INSTRUCTIONS_FILENAME,
  TOOL_DELETE_FILE_FULL_NAME,
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_EDIT_FILE_FULL_NAME,
  TOOL_READ_FILE_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_SAVE_FILE_FULL_NAME,
  TOOL_SEARCH_FILES_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
} from "@archestra/shared";
import config from "@/config";
import {
  ConversationAttachmentModel,
  ConversationModel,
  FileModel,
  FileNameExistsError,
  ProjectModel,
  SkillModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import { sandboxRuntimeService } from "@/sandbox-runtime/sandbox-runtime-service";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { fileStore } from "@/skills-sandbox/file-store";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { SkillSandboxError } from "@/skills-sandbox/types";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "@/test";
import { type Agent, asSandboxId } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from ".";

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

  beforeEach(() => {
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

    test("surfaces an empty-stderr section on a non-zero exit, but not on success", async () => {
      const ctx = await makeConversationCtx();
      const spy = vi.spyOn(skillSandboxRuntimeService, "runCommand");

      // a command failed without writing to stderr: the model must still see an
      // explicit (empty) stderr section so it can tell "no stderr" from "stderr
      // withheld" rather than the section silently vanishing.
      spy.mockResolvedValue({
        commandId: "cmd-1",
        sandboxId: "x" as any,
        command: "exit 1",
        cwd: null,
        stdout: "",
        stderr: "",
        exitCode: 1,
        durationMs: 5,
        timedOut: false,
        truncated: false,
        binaryStripped: false,
        stagingNotices: [],
      });
      const failed = textOf(
        await executeArchestraTool(
          TOOL_RUN_COMMAND_FULL_NAME,
          { command: "exit 1" },
          ctx,
        ),
      );
      // Assert the empty marker belongs to the stderr section specifically — stdout is
      // also empty here, so a bare "(empty)" check could pass on the stdout section alone.
      expect(failed).toContain("stderr:\n(empty)");

      // success with empty stderr stays terse — no stderr section.
      spy.mockResolvedValue({
        commandId: "cmd-2",
        sandboxId: "x" as any,
        command: "true",
        cwd: null,
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
        truncated: false,
        binaryStripped: false,
        stagingNotices: [],
      });
      const ok = textOf(
        await executeArchestraTool(
          TOOL_RUN_COMMAND_FULL_NAME,
          { command: "true" },
          ctx,
        ),
      );
      expect(ok).not.toContain("stderr:");
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
    test("delegates to the runtime service and returns fileId without a download link", async () => {
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
          overwritten: false,
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
        downloadUrl?: string;
      }>(result);
      expect(structured.fileId).toBe("artifact-1");
      expect(structured.sizeBytes).toBe(42);
      // No download link is surfaced anymore — the file is reached via the Files
      // panel, and neither the structured output nor the text mentions a URL.
      expect(structured.downloadUrl).toBeUndefined();
      expect(JSON.stringify(result.content)).not.toContain(
        "/api/skill-sandbox/artifacts",
      );
      // text-only — bytes flow sandbox -> DB -> Files panel via the artifacts
      // route, never via the MCP content array (which the chat layer would
      // stringify into context).
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
        overwritten: false,
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

    test("surfaces a name collision as a clean, non-retryable error", async () => {
      const ctx = await makeConversationCtx();
      vi.spyOn(skillSandboxRuntimeService, "exportArtifact").mockRejectedValue(
        new FileNameExistsError("report.pdf"),
      );

      const result = await executeArchestraTool(
        TOOL_DOWNLOAD_FILE_FULL_NAME,
        { path: "out/report.pdf", mimeType: "application/pdf" },
        ctx,
      );

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("already exists");
      expect(text).not.toContain("Try the operation again");
    });

    // Guards the propagation path the handler test above cannot reach: the real
    // exportArtifact must let a typed name collision escape rather than flatten it
    // into a generic, retryable storage error. Only the Dagger boundary is stubbed.
    test("exportArtifact rethrows a name collision instead of masking it", async () => {
      const sandbox = await SkillSandboxModel.create({
        organizationId,
        userId,
        conversationId: null,
        defaultCwd: "/home/sandbox",
      });
      // Stub only the Dagger runtime boundary: its availability gate and the
      // artifact read. fileStore + the files table stay real so the collision
      // (and its rethrow) is genuine.
      vi.spyOn(sandboxRuntimeService, "isEnabled", "get").mockReturnValue(true);
      vi.spyOn(sandboxRuntimeService, "readArtifact").mockResolvedValue({
        dataBase64: Buffer.from("pi=3.14159").toString("base64"),
        sizeBytes: 10,
      });

      const params = {
        sandboxId: asSandboxId(sandbox.id),
        caller: { userId, organizationId },
        path: "out/result.txt",
        projectId: null,
      };
      await skillSandboxRuntimeService.exportArtifact(params);
      await expect(
        skillSandboxRuntimeService.exportArtifact(params),
      ).rejects.toBeInstanceOf(FileNameExistsError);
    });

    // overwrite replaces the same-named persistent file in place (keeps its id)
    // instead of colliding, so a regenerated sandbox file can supersede the one
    // exported earlier. Only the Dagger boundary is stubbed.
    test("exportArtifact with overwrite replaces an existing file in place", async () => {
      const sandbox = await SkillSandboxModel.create({
        organizationId,
        userId,
        conversationId: null,
        defaultCwd: "/home/sandbox",
      });
      vi.spyOn(sandboxRuntimeService, "isEnabled", "get").mockReturnValue(true);
      const readSpy = vi.spyOn(sandboxRuntimeService, "readArtifact");

      const params = {
        sandboxId: asSandboxId(sandbox.id),
        caller: { userId, organizationId },
        path: "out/result.txt",
        projectId: null,
      };

      readSpy.mockResolvedValue({
        dataBase64: Buffer.from("v1").toString("base64"),
        sizeBytes: 2,
      });
      const first = await skillSandboxRuntimeService.exportArtifact(params);
      expect(first.overwritten).toBe(false);

      readSpy.mockResolvedValue({
        dataBase64: Buffer.from("version-two").toString("base64"),
        sizeBytes: 11,
      });
      const second = await skillSandboxRuntimeService.exportArtifact({
        ...params,
        overwrite: true,
      });
      expect(second.overwritten).toBe(true);
      expect(second.artifactId).toBe(first.artifactId);
      expect(second.sizeBytes).toBe(Buffer.from("version-two").byteLength);
    });

    // Conversation scope resolves the existing file via resolveMyFileRef (not the
    // orphan path) before replacing it in place.
    test("exportArtifact overwrite replaces in place within a conversation scope", async () => {
      const conversation = await ConversationModel.create({
        userId,
        organizationId,
        agentId: agent.id,
        title: "overwrite conv",
      });
      const sandbox = await SkillSandboxModel.create({
        organizationId,
        userId,
        conversationId: conversation.id,
        defaultCwd: "/home/sandbox",
      });
      vi.spyOn(sandboxRuntimeService, "isEnabled", "get").mockReturnValue(true);
      const readSpy = vi.spyOn(sandboxRuntimeService, "readArtifact");
      const params = {
        sandboxId: asSandboxId(sandbox.id),
        caller: { userId, organizationId },
        path: "out/data.txt",
        projectId: null,
      };

      readSpy.mockResolvedValue({
        dataBase64: Buffer.from("one").toString("base64"),
        sizeBytes: 3,
      });
      const first = await skillSandboxRuntimeService.exportArtifact(params);

      readSpy.mockResolvedValue({
        dataBase64: Buffer.from("two!").toString("base64"),
        sizeBytes: 4,
      });
      const second = await skillSandboxRuntimeService.exportArtifact({
        ...params,
        overwrite: true,
      });
      expect(second.overwritten).toBe(true);
      expect(second.artifactId).toBe(first.artifactId);
      expect(second.sizeBytes).toBe(4);
    });

    // overwrite with no existing same-named file creates it (overwritten: false),
    // exercising the not-found → create fall-through.
    test("exportArtifact overwrite creates the file when none exists", async () => {
      const sandbox = await SkillSandboxModel.create({
        organizationId,
        userId,
        conversationId: null,
        defaultCwd: "/home/sandbox",
      });
      vi.spyOn(sandboxRuntimeService, "isEnabled", "get").mockReturnValue(true);
      vi.spyOn(sandboxRuntimeService, "readArtifact").mockResolvedValue({
        dataBase64: Buffer.from("fresh").toString("base64"),
        sizeBytes: 5,
      });

      const result = await skillSandboxRuntimeService.exportArtifact({
        sandboxId: asSandboxId(sandbox.id),
        caller: { userId, organizationId },
        path: "out/new.txt",
        projectId: null,
        overwrite: true,
      });
      expect(result.overwritten).toBe(false);
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

    test("rejects a non-UUID attachmentId without throwing a DB error", async () => {
      // A model that only sees the attachment's filename guesses it as the id.
      // The id column is uuid-typed, so this once threw an unhandled Postgres
      // error that aborted the whole turn — it must surface gracefully instead.
      const ctx = await makeConversationCtx();
      const uploadSpy = vi.spyOn(skillSandboxRuntimeService, "uploadFile");
      const result = await executeArchestraTool(
        TOOL_UPLOAD_FILE_FULL_NAME,
        {
          path: "certificate.pdf",
          source: { type: "chat_attachment", attachmentId: "certificate.pdf" },
        },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        "must be the attachment's id, not its filename",
      );
      expect(uploadSpy).not.toHaveBeenCalled();
    });

    // uploadFile does no Dagger work, so enabling the runtime engine lets these
    // exercise the real persistence + validation path against PGlite.
    describe("with the runtime engine available", () => {
      const originalDagger = config.daggerRuntime.enabled;
      beforeEach(() => {
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
      beforeEach(() => {
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

  beforeEach(() => {
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

  async function seedPfsArtifact(
    filename: string,
    content = "abc",
    conversationId: string | null = null,
  ) {
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId,
      conversationId,
      defaultCwd: "/home/sandbox",
    });
    return fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId,
      sandboxId: sandbox.id,
      filename,
      mimeType: "text/plain",
      sizeBytes: content.length,
      data: Buffer.from(content),
    });
  }

  describe("search_files", () => {
    test("lists and filters this conversation's persistent files", async () => {
      const ctx = await makeConversationCtx();
      await seedPfsArtifact("q2-report.txt", "abc", ctx.conversationId);
      await seedPfsArtifact("notes.txt", "abc", ctx.conversationId);

      const all = await executeArchestraTool(
        TOOL_SEARCH_FILES_FULL_NAME,
        {},
        ctx,
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

      // A model that passes an empty string instead of omitting the query must browse,
      // not hit a validation error: the schema accepts "" and lists every file.
      const emptyQuery = await executeArchestraTool(
        TOOL_SEARCH_FILES_FULL_NAME,
        { query: "" },
        ctx,
      );
      expect(emptyQuery.isError).toBe(false);
      const emptyOut = structuredOf<{ files: Array<{ filename: string }> }>(
        emptyQuery,
      );
      expect(emptyOut.files.map((f) => f.filename).sort()).toEqual([
        "notes.txt",
        "q2-report.txt",
      ]);

      const filtered = await executeArchestraTool(
        TOOL_SEARCH_FILES_FULL_NAME,
        { query: "REPORT" },
        ctx,
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
      const ctx = await makeConversationCtx();
      await seedPfsArtifact("mine.txt", "abc", ctx.conversationId);
      const stranger = await makeUser({ email: "pfs-stranger@test.com" });
      const strangerSandbox = await SkillSandboxModel.create({
        organizationId,
        userId: stranger.id,
        conversationId: ctx.conversationId,
        defaultCwd: "/home/sandbox",
      });
      await fileStore.put({
        organizationId,
        userId: stranger.id,
        projectId: null,
        conversationId: ctx.conversationId ?? null,
        sandboxId: strangerSandbox.id,
        filename: "theirs.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        data: Buffer.from("x"),
      });

      const result = await executeArchestraTool(
        TOOL_SEARCH_FILES_FULL_NAME,
        {},
        ctx,
      );
      const out = structuredOf<{ files: Array<{ filename: string }> }>(result);
      expect(out.files.map((f) => f.filename)).toEqual(["mine.txt"]);
    });
  });

  describe("upload_file my_file source", () => {
    test("loads PFS bytes by id and marks the upload origin", async () => {
      const ctx = await makeConversationCtx();
      const artifact = await seedPfsArtifact(
        "pull-me.txt",
        "pfs-bytes",
        ctx.conversationId,
      );
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
          overwritten: false,
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
          overwritten: false,
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

describe("project file scope (save_file, scoped search/my_file)", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;
  let context: ArchestraContext;
  const originalEnabled = config.skillsSandbox.enabled;

  beforeEach(() => {
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

  const SAVE_FILE_FULL_NAME = "archestra__save_file";

  test("delete_file refuses the project instructions file", async () => {
    const { project, ctx } = await makeProjectChatCtx("instr-del");
    await fileStore.writeProjectInstructions({
      organizationId,
      userId,
      projectId: project.id,
      content: "keep me",
    });

    const result = await executeArchestraTool(
      TOOL_DELETE_FILE_FULL_NAME,
      { filename: PROJECT_INSTRUCTIONS_FILENAME },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("can't be deleted");

    // still present
    expect(
      await FileModel.findByProjectAndName({
        organizationId,
        projectId: project.id,
        filename: PROJECT_INSTRUCTIONS_FILENAME,
      }),
    ).not.toBeNull();
  });

  test("save_file persists inline content to the PFS root without a project", async () => {
    const ctx = await makePlainChatCtx();
    const result = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "joke.md", content: "# why did the test pass\n" },
      ctx,
    );
    expect(result.isError).toBe(false);
    const out = structuredOf<{
      fileId: string;
      projectName: string | null;
      downloadUrl?: string;
    }>(result);
    expect(out.projectName).toBeNull();
    // save_file no longer surfaces a download link.
    expect(out.downloadUrl).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain(
      "/api/skill-sandbox/artifacts",
    );

    const { FileModel } = await import("@/models");
    const row = await FileModel.findById(out.fileId);
    expect(row).not.toBeNull();
    expect(row?.projectId).toBeNull();
  });

  test("save_file lands in the project in a project chat", async () => {
    const { project, ctx } = await makeProjectChatCtx("save-here");
    const result = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
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

  test("save_file validates filename and content/base64 exclusivity", async () => {
    const ctx = await makePlainChatCtx();
    const badName = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "../escape.md", content: "x" },
      ctx,
    );
    expect(badName.isError).toBe(true);

    const both = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "x.md", content: "a", contentBase64: "YQ==" },
      ctx,
    );
    expect(both.isError).toBe(true);
  });

  test("save_file creates an empty file from empty content", async () => {
    const ctx = await makePlainChatCtx();
    const result = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "blank.md", content: "" },
      ctx,
    );
    expect(result.isError).toBe(false);
    const out = structuredOf<{ fileId: string; sizeBytes: number }>(result);
    expect(out.sizeBytes).toBe(0);

    const { FileModel } = await import("@/models");
    const row = await FileModel.findById(out.fileId);
    expect(row?.filename).toBe("blank.md");
    expect(row?.sizeBytes).toBe(0);
  });

  test("save_file errors on a duplicate name without overwrite", async () => {
    const ctx = await makePlainChatCtx();
    const first = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "dup.md", content: "one" },
      ctx,
    );
    expect(first.isError).toBe(false);

    const second = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "dup.md", content: "two" },
      ctx,
    );
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("already exists");
  });

  test("save_file overwrite is idempotent for a headless (no-conversation) write", async () => {
    // the base context has no conversationId and no project → the orphan scope.
    const first = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "run.md", content: "v1" },
      context,
    );
    expect(first.isError).toBe(false);
    const firstId = structuredOf<{ fileId: string }>(first).fileId;

    // a re-run with overwrite must replace the orphan in place, not dead-end
    // with FileNameExistsError.
    const second = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "run.md", content: "v2", overwrite: true },
      context,
    );
    expect(second.isError).toBe(false);
    const out = structuredOf<{ fileId: string; overwritten: boolean }>(second);
    expect(out.fileId).toBe(firstId);
    expect(out.overwritten).toBe(true);

    const { FileModel } = await import("@/models");
    const row = await FileModel.findById(firstId);
    expect(row?.conversationId).toBeNull();
    expect(row?.data?.toString()).toBe("v2");
  });

  test("save_file overwrite replaces an existing file in place, keeping its id", async () => {
    const ctx = await makePlainChatCtx();
    const first = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "report.md", content: "draft" },
      ctx,
    );
    const firstOut = structuredOf<{ fileId: string }>(first);

    const second = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "report.md", content: "final", overwrite: true },
      ctx,
    );
    expect(second.isError).toBe(false);
    const secondOut = structuredOf<{ fileId: string; overwritten: boolean }>(
      second,
    );
    expect(secondOut.overwritten).toBe(true);
    expect(secondOut.fileId).toBe(firstOut.fileId);

    const row = await FileModel.findById(firstOut.fileId);
    expect(row?.data?.toString()).toBe("final");
  });

  test("save_file overwrite creates the file when none exists", async () => {
    const ctx = await makePlainChatCtx();
    const result = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "fresh.md", content: "hi", overwrite: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(structuredOf<{ overwritten: boolean }>(result).overwritten).toBe(
      false,
    );
  });

  test("save_file overwrite stays within the project in a project chat", async () => {
    const { project, ctx } = await makeProjectChatCtx("overwrite-here");
    const first = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "out.md", content: "v1" },
      ctx,
    );
    const firstOut = structuredOf<{ fileId: string }>(first);

    const second = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "out.md", content: "v2", overwrite: true },
      ctx,
    );
    expect(second.isError).toBe(false);
    const secondOut = structuredOf<{ fileId: string; overwritten: boolean }>(
      second,
    );
    expect(secondOut.overwritten).toBe(true);
    expect(secondOut.fileId).toBe(firstOut.fileId);

    const row = await FileModel.findById(firstOut.fileId);
    expect(row?.projectId).toBe(project.id);
    expect(row?.data?.toString()).toBe("v2");
  });

  test("save_file overwrite surfaces an error if the row vanishes mid-write", async () => {
    const ctx = await makePlainChatCtx();
    await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "racy.md", content: "before" },
      ctx,
    );
    // Simulate the file's row disappearing after the bytes were written.
    vi.spyOn(FileModel, "updateContent").mockResolvedValue(null);
    const result = await executeArchestraTool(
      SAVE_FILE_FULL_NAME,
      { filename: "racy.md", content: "after", overwrite: true },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  test("search_files in a project chat sees only the project's files", async () => {
    const { project, ctx } = await makeProjectChatCtx("searchable");
    const { SkillSandboxModel } = await import("@/models");
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    await fileStore.put({
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
    await fileStore.put({
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
      files: Array<{ filename: string; id: string | null; ref: string }>;
    }>(result);
    expect(out.files.map((f) => f.filename)).toEqual(["inside.txt"]);
    // every result carries a stable ref; for a row-backed file it is the id
    expect(out.files[0].ref).toBe(out.files[0].id);
    expect(out.files[0].ref).toBeTruthy();
  });

  test("my_file uploads in a project chat are confined to the project", async () => {
    const { project, ctx } = await makeProjectChatCtx("confined");
    const { SkillSandboxModel } = await import("@/models");
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    const inside = await fileStore.put({
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
    const outside = await fileStore.put({
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

describe("read_file", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;
  let context: ArchestraContext;
  const originalEnabled = config.skillsSandbox.enabled;

  beforeEach(() => {
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
      agent = await makeAgent({ name: "Read Agent" });
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

  async function makePlainChatCtx() {
    const conversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: agent.id,
      title: "plain",
    });
    return { ...context, conversationId: conversation.id };
  }

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
    return { project, ctx: { ...context, conversationId: conversation.id } };
  }

  function makePersonalFile(
    filename: string,
    body: string,
    conversationId: string | null = null,
  ) {
    return fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId,
      filename,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(body),
      data: Buffer.from(body),
    });
  }

  test("reads a file's content as numbered lines, by id", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile(
      "a.txt",
      "first\nsecond\nthird",
      ctx.conversationId,
    );

    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("1\tfirst\n2\tsecond\n3\tthird");
    const out = structuredOf<{
      fileId: string;
      totalLines: number;
      returnedLines: number;
      truncated: boolean;
    }>(result);
    expect(out.fileId).toBe(file.id);
    expect(out.totalLines).toBe(3);
    expect(out.returnedLines).toBe(3);
    expect(out.truncated).toBe(false);
  });

  test("reads by filename", async () => {
    const ctx = await makePlainChatCtx();
    await makePersonalFile("notes.md", "hello", ctx.conversationId);
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { filename: "notes.md" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("1\thello");
  });

  test("windows large files with offset/limit and flags truncation", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile(
      "lines.txt",
      "l1\nl2\nl3\nl4\nl5",
      ctx.conversationId,
    );

    const head = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id, limit: 2 },
      ctx,
    );
    expect(textOf(head)).toContain("1\tl1");
    const headOut = structuredOf<{ returnedLines: number; truncated: boolean }>(
      head,
    );
    expect(headOut.returnedLines).toBe(2);
    expect(headOut.truncated).toBe(true);

    const tail = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id, offset: 3 },
      ctx,
    );
    expect(textOf(tail)).toBe("3\tl3\n4\tl4\n5\tl5");
    expect(structuredOf<{ truncated: boolean }>(tail).truncated).toBe(false);
  });

  test("refuses a binary file even when labeled text/plain", async () => {
    const ctx = await makePlainChatCtx();
    const file = await fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId: ctx.conversationId,
      filename: "fake.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      data: Buffer.from([0x61, 0x00, 0x62, 0x63, 0x64]),
    });
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not text or a supported image");
  });

  test("refuses invalid UTF-8 even without a NUL byte", async () => {
    const ctx = await makePlainChatCtx();
    const file = await fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId: ctx.conversationId,
      filename: "latin1.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      // 0xff 0xfe 0xfd is not valid UTF-8 (and has no NUL byte).
      data: Buffer.from([0xff, 0xfe, 0xfd]),
    });
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not text or a supported image");
  });

  test("returns an inline-safe image as an image content block", async () => {
    const ctx = await makePlainChatCtx();
    // PNG magic bytes are enough for the byte-sniffer to classify it as image/png.
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
    ]);
    const file = await fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId: ctx.conversationId,
      filename: "pic.png",
      mimeType: "image/png",
      sizeBytes: pngBytes.byteLength,
      data: pngBytes,
    });
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(false);
    const image = (result.content as Array<{ type: string }>).find(
      (c) => c.type === "image",
    ) as { type: string; data: string; mimeType: string } | undefined;
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data).toBe(pngBytes.toString("base64"));
    expect(structuredOf<{ kind: string }>(result).kind).toBe("image");
  });

  test("classifies an image by its bytes even when mislabeled text/plain", async () => {
    const ctx = await makePlainChatCtx();
    const gifBytes = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
    ]);
    const file = await fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId: ctx.conversationId,
      filename: "sneaky.txt",
      mimeType: "text/plain",
      sizeBytes: gifBytes.byteLength,
      data: gifBytes,
    });
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(structuredOf<{ kind: string; mimeType: string }>(result).kind).toBe(
      "image",
    );
    expect(structuredOf<{ mimeType: string }>(result).mimeType).toBe(
      "image/gif",
    );
  });

  test("returns JPEG and WebP raster images inline", async () => {
    const ctx = await makePlainChatCtx();
    const cases = [
      {
        name: "p.jpg",
        mime: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      },
      {
        name: "p.webp",
        mime: "image/webp",
        bytes: Buffer.from([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
          0x50,
        ]),
      },
    ];
    for (const c of cases) {
      const file = await fileStore.put({
        organizationId,
        userId,
        projectId: null,
        conversationId: ctx.conversationId,
        filename: c.name,
        mimeType: c.mime,
        sizeBytes: c.bytes.byteLength,
        data: c.bytes,
      });
      const result = await executeArchestraTool(
        TOOL_READ_FILE_FULL_NAME,
        { id: file.id },
        ctx,
      );
      expect(result.isError).toBe(false);
      const out = structuredOf<{ kind: string; mimeType: string }>(result);
      expect(out.kind).toBe("image");
      expect(out.mimeType).toBe(c.mime);
    }
  });

  test("reads a project-scoped image in its project chat", async () => {
    const { project, ctx } = await makeProjectChatCtx("img-project");
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const file = await fileStore.put({
      organizationId,
      userId,
      projectId: project.id,
      conversationId: null,
      filename: "chart.png",
      mimeType: "image/png",
      sizeBytes: png.byteLength,
      data: png,
    });
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(structuredOf<{ kind: string }>(result).kind).toBe("image");
  });

  test("refuses an image larger than the inline size cap", async () => {
    const ctx = await makePlainChatCtx();
    const big = Buffer.alloc(4 * 1024 * 1024); // > 3.75 MB image cap
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
    const file = await fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId: ctx.conversationId,
      filename: "huge.png",
      mimeType: "image/png",
      sizeBytes: big.byteLength,
      data: big,
    });
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too large to view inline");
  });

  test("returns no lines when offset is past the end of the file", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile("two.txt", "a\nb", ctx.conversationId);
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id, offset: 99 },
      ctx,
    );
    expect(result.isError).toBe(false);
    const out = structuredOf<{ returnedLines: number; truncated: boolean }>(
      result,
    );
    expect(out.returnedLines).toBe(0);
    expect(out.truncated).toBe(false);
    expect(textOf(result)).toContain("No lines at offset 99");
  });

  test("explains when a single line exceeds the output byte cap", async () => {
    const ctx = await makePlainChatCtx();
    const huge = "x".repeat(config.skillsSandbox.outputBytesLimit + 100);
    const file = await makePersonalFile(
      "huge-line.txt",
      huge,
      ctx.conversationId,
    );
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(false);
    const out = structuredOf<{ returnedLines: number; truncated: boolean }>(
      result,
    );
    expect(out.returnedLines).toBe(0);
    expect(out.truncated).toBe(true);
    expect(textOf(result)).toContain("too large to render inline");
  });

  test("reads a project file in its project chat", async () => {
    const { project, ctx } = await makeProjectChatCtx("readable-project");
    const projectFile = await fileStore.put({
      organizationId,
      userId,
      projectId: project.id,
      conversationId: null,
      filename: "plan.md",
      mimeType: "text/markdown",
      sizeBytes: 4,
      data: Buffer.from("plan"),
    });
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: projectFile.id },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("1\tplan");
  });

  test("reports an empty file", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile("blank.txt", "", ctx.conversationId);
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(structuredOf<{ sizeBytes: number }>(result).sizeBytes).toBe(0);
    expect(textOf(result)).toContain("empty");
  });

  test("errors when the file does not exist", async () => {
    const ctx = await makePlainChatCtx();
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: "00000000-0000-0000-0000-000000000000" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  test("routes an obj_ ref to the object store (fails closed on db backend)", async () => {
    const ctx = await makePlainChatCtx();
    // An obj_ ref must go to the object-store resolver, not the uuid column. On
    // the db backend there is no store, so it resolves to a clean not-found.
    const ref = `obj_${Buffer.from(
      JSON.stringify({ s: { kind: "user", userId }, k: `${userId}/x.txt` }),
      "utf8",
    ).toString("base64url")}`;
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: ref },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  test("reads without materializing a sandbox", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile(
      "touch.txt",
      "content",
      ctx.conversationId,
    );
    const createSpy = vi.spyOn(SkillSandboxModel, "create");
    const defaultSpy = vi.spyOn(SkillSandboxModel, "findOrCreateDefault");

    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
    expect(defaultSpy).not.toHaveBeenCalled();
  });

  test("in a project chat cannot read a personal file", async () => {
    const { ctx } = await makeProjectChatCtx("scoped-read");
    const personal = await makePersonalFile("secret.txt", "classified");
    const result = await executeArchestraTool(
      TOOL_READ_FILE_FULL_NAME,
      { id: personal.id },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("classified");
  });
});

describe("edit_file / delete_file", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;
  let context: ArchestraContext;
  const originalEnabled = config.skillsSandbox.enabled;

  beforeEach(() => {
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
      agent = await makeAgent({ name: "Edit Agent" });
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

  async function makePlainChatCtx() {
    const conversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: agent.id,
      title: "plain",
    });
    return { ...context, conversationId: conversation.id };
  }

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
    return { project, ctx: { ...context, conversationId: conversation.id } };
  }

  function makePersonalFile(
    filename: string,
    body: string,
    conversationId: string | null = null,
  ) {
    return fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId,
      filename,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(body),
      data: Buffer.from(body),
    });
  }

  test("edit_file replaces a snippet in place, keeps the id", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile(
      "poem.md",
      "roses are red\nviolets are blue\n",
      ctx.conversationId,
    );

    const result = await executeArchestraTool(
      TOOL_EDIT_FILE_FULL_NAME,
      { id: file.id, old_string: "blue", new_string: "cyan" },
      ctx,
    );
    expect(result.isError).toBe(false);
    const out = structuredOf<{ fileId: string; replacements: number }>(result);
    expect(out.fileId).toBe(file.id);
    expect(out.replacements).toBe(1);

    const row = await FileModel.findById(file.id);
    expect(row?.data?.toString()).toBe("roses are red\nviolets are cyan\n");
  });

  test("edit_file resolves by filename", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile(
      "notes.txt",
      "old value",
      ctx.conversationId,
    );

    const result = await executeArchestraTool(
      TOOL_EDIT_FILE_FULL_NAME,
      { filename: "notes.txt", old_string: "old", new_string: "new" },
      ctx,
    );
    expect(result.isError).toBe(false);
    const row = await FileModel.findById(file.id);
    expect(row?.data?.toString()).toBe("new value");
  });

  test("edit_file errors when old_string is not found", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile(
      "a.txt",
      "hello world",
      ctx.conversationId,
    );
    const result = await executeArchestraTool(
      TOOL_EDIT_FILE_FULL_NAME,
      { id: file.id, old_string: "absent", new_string: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
    const row = await FileModel.findById(file.id);
    expect(row?.data?.toString()).toBe("hello world");
  });

  test("edit_file errors when old_string is not unique without replace_all", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile("dup.txt", "a a a", ctx.conversationId);
    const result = await executeArchestraTool(
      TOOL_EDIT_FILE_FULL_NAME,
      { id: file.id, old_string: "a", new_string: "b" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not unique");
    const row = await FileModel.findById(file.id);
    expect(row?.data?.toString()).toBe("a a a");
  });

  test("edit_file replace_all changes every occurrence", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile("dup.txt", "a a a", ctx.conversationId);
    const result = await executeArchestraTool(
      TOOL_EDIT_FILE_FULL_NAME,
      { id: file.id, old_string: "a", new_string: "b", replace_all: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(structuredOf<{ replacements: number }>(result).replacements).toBe(3);
    const row = await FileModel.findById(file.id);
    expect(row?.data?.toString()).toBe("b b b");
  });

  test("edit_file rejects new_string equal to old_string", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile("a.txt", "keep", ctx.conversationId);
    const result = await executeArchestraTool(
      TOOL_EDIT_FILE_FULL_NAME,
      { id: file.id, old_string: "keep", new_string: "keep" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  test("edit_file refuses a binary (non-UTF-8) file", async () => {
    const ctx = await makePlainChatCtx();
    const binary = await fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId: ctx.conversationId,
      filename: "image.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 4,
      data: Buffer.from([0x00, 0x01, 0x02, 0xff]),
    });
    const result = await executeArchestraTool(
      TOOL_EDIT_FILE_FULL_NAME,
      { id: binary.id, old_string: "x", new_string: "y" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("text");
  });

  test("edit_file in a project chat cannot touch a personal file", async () => {
    const { ctx } = await makeProjectChatCtx("scoped");
    const personal = await makePersonalFile("personal.txt", "secret");

    const result = await executeArchestraTool(
      TOOL_EDIT_FILE_FULL_NAME,
      { id: personal.id, old_string: "secret", new_string: "hacked" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("project");
    const row = await FileModel.findById(personal.id);
    expect(row?.data?.toString()).toBe("secret");
  });

  test("delete_file removes the file", async () => {
    const ctx = await makePlainChatCtx();
    const file = await makePersonalFile("trash.txt", "bye", ctx.conversationId);

    const result = await executeArchestraTool(
      TOOL_DELETE_FILE_FULL_NAME,
      { id: file.id },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(structuredOf<{ deleted: boolean }>(result).deleted).toBe(true);
    expect(await FileModel.findById(file.id)).toBeNull();
  });

  test("delete_file in a project chat cannot touch a personal file", async () => {
    const { ctx } = await makeProjectChatCtx("scoped-del");
    const personal = await makePersonalFile("keep.txt", "stays");

    const result = await executeArchestraTool(
      TOOL_DELETE_FILE_FULL_NAME,
      { id: personal.id },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(await FileModel.findById(personal.id)).not.toBeNull();
  });
});

describe("persistent-files tools follow the sandbox runtime flag", () => {
  const originalSandbox = config.skillsSandbox.enabled;
  afterAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalSandbox;
  });

  test("advertises the PFS tools alongside the runtime tools when the sandbox runtime is on", () => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
    const names = getArchestraMcpTools().map((tool) => tool.name);
    for (const name of [
      TOOL_SEARCH_FILES_FULL_NAME,
      TOOL_READ_FILE_FULL_NAME,
      TOOL_SAVE_FILE_FULL_NAME,
      TOOL_EDIT_FILE_FULL_NAME,
      TOOL_DELETE_FILE_FULL_NAME,
      TOOL_RUN_COMMAND_FULL_NAME,
      TOOL_DOWNLOAD_FILE_FULL_NAME,
      TOOL_UPLOAD_FILE_FULL_NAME,
    ]) {
      expect(names).toContain(name);
    }
  });

  test("hides every sandbox tool when the runtime is off", () => {
    (config.skillsSandbox as { enabled: boolean }).enabled = false;
    const names = getArchestraMcpTools().map((tool) => tool.name);
    for (const name of [
      TOOL_SEARCH_FILES_FULL_NAME,
      TOOL_READ_FILE_FULL_NAME,
      TOOL_SAVE_FILE_FULL_NAME,
      TOOL_EDIT_FILE_FULL_NAME,
      TOOL_DELETE_FILE_FULL_NAME,
      TOOL_RUN_COMMAND_FULL_NAME,
      TOOL_DOWNLOAD_FILE_FULL_NAME,
      TOOL_UPLOAD_FILE_FULL_NAME,
    ]) {
      expect(names).not.toContain(name);
    }
  });
});
