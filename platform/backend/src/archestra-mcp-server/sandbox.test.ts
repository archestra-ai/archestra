// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ADMIN_ROLE_NAME,
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import {
  ConversationAttachmentModel,
  ConversationModel,
  SkillModel,
  SkillSandboxFileModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import type { Agent } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from ".";
import { TOOL_PERMISSIONS } from "./rbac";

// the Dagger engine is the process boundary: stub the NAPI surface and let the
// real services (target resolution, queues, staging, persistence) run against
// PGlite.
const nativeMock = vi.hoisted(() => ({
  checkSession: vi.fn(),
  runSandbox: vi.fn(),
  readArtifact: vi.fn(),
  flushTelemetry: vi.fn(),
}));
vi.mock("@archestra/sandbox-rs", () => nativeMock);

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
  const originalDagger = config.daggerRuntime.enabled;

  beforeAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
    (config.daggerRuntime as { enabled: boolean }).enabled = true;
  });

  afterAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalEnabled;
    (config.daggerRuntime as { enabled: boolean }).enabled = originalDagger;
  });

  beforeEach(() => {
    // full reset (not just call history) so a test's mockRejectedValue /
    // readArtifact stub cannot leak into the next test.
    for (const mock of Object.values(nativeMock)) {
      mock.mockReset();
    }
    nativeMock.checkSession.mockResolvedValue(undefined);
    nativeMock.runSandbox.mockResolvedValue({
      stdout: "hi\n",
      stderr: "",
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      truncated: false,
    });
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

  async function makeConversationCtx(): Promise<ArchestraContext> {
    const conversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: agent.id,
      title: "Test",
    });
    return { ...context, conversationId: conversation.id };
  }

  describe("run_command", () => {
    test("lazily creates the conversation default sandbox and runs in it", async () => {
      const ctx = await makeConversationCtx();
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

      // ...the command reached the engine in that sandbox's cwd with an empty
      // replay (fresh sandbox)...
      expect(nativeMock.runSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "echo hi",
          cwd: "/home/sandbox",
          replayEntries: [],
        }),
      );

      // ...the engine result came back to the model...
      const structured = structuredOf<{
        sandboxId: string;
        stdout: string;
        exitCode: number;
      }>(result);
      expect(structured.sandboxId).toBe(sandboxes[0].id);
      expect(structured.stdout).toBe("hi\n");
      expect(structured.exitCode).toBe(0);

      // ...and the command was appended to the durable replay log.
      const log = await SkillSandboxReplayEventModel.listBySandbox(
        sandboxes[0].id,
      );
      expect(log).toHaveLength(1);
      expect(log[0].kind).toBe("command");
    });

    test("reuses the same default sandbox across calls in a conversation", async () => {
      const ctx = await makeConversationCtx();

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

      // the second run replayed the first command before executing.
      const lastCall = nativeMock.runSandbox.mock.calls.at(-1)?.[0] as {
        replayEntries: Array<{ kind: string }>;
      };
      expect(lastCall.replayEntries).toHaveLength(1);
      expect(lastCall.replayEntries[0].kind).toBe("command");
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

      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { fresh: true } },
        ctx,
      );
      expect(result.isError).toBe(false);

      const sandboxes = await SkillSandboxModel.listForConversation({
        conversationId: ctx.conversationId as string,
        organizationId,
      });
      expect(sandboxes).toHaveLength(1);
      expect(sandboxes[0].isDefault).toBe(false);
      expect(structuredOf<{ sandboxId: string }>(result).sandboxId).toBe(
        sandboxes[0].id,
      );
    });

    test("target {id} from a different conversation is rejected", async () => {
      const ctxA = await makeConversationCtx();
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

    test("surfaces engine failures to the model as readable text", async () => {
      const ctx = await makeConversationCtx();
      nativeMock.runSandbox.mockRejectedValue(
        Object.assign(new Error("exit status 153"), {
          code: "ARCHESTRA_COMMAND_FAILED",
        }),
      );
      const result = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        "a setup or replay command in this sandbox failed: exit status 153",
      );
    });
  });

  describe("headless executions (isolation key, no conversation)", () => {
    function headlessCtx(): ArchestraContext {
      return { ...context, isolationKey: crypto.randomUUID() };
    }

    function sandboxIdOf(result: { structuredContent?: unknown }): string {
      return structuredOf<{ sandboxId: string }>(result).sandboxId;
    }

    test("default target creates one conversation-less sandbox and reuses it", async () => {
      const ctx = headlessCtx();

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

      const sandboxId = sandboxIdOf(first);
      expect(sandboxIdOf(second)).toBe(sandboxId);

      // never a fake conversation id, never default-flagged (the partial
      // unique index cannot protect null-conversation defaults).
      const row = await SkillSandboxModel.findById(sandboxId);
      expect(row?.conversationId).toBeNull();
      expect(row?.isDefault).toBe(false);
    });

    test("concurrent first calls share a single sandbox", async () => {
      const ctx = headlessCtx();

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
      expect(sandboxIdOf(first)).toBe(sandboxIdOf(second));
    });

    test("explicit {id} is scoped to the owning execution", async () => {
      const ctxA = headlessCtx();
      const created = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctxA,
      );
      const sandboxId = sandboxIdOf(created);

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
      const created = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi", target: { fresh: true } },
        ctx,
      );
      const sandboxId = sandboxIdOf(created);
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
      const first = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      const before = sandboxIdOf(first);

      executionSandboxRegistry.release(ctx.isolationKey as string);

      const second = await executeArchestraTool(
        TOOL_RUN_COMMAND_FULL_NAME,
        { command: "echo hi" },
        ctx,
      );
      expect(sandboxIdOf(second)).not.toBe(before);
    });
  });

  describe("download_file", () => {
    test("exports the file, persists it as an artifact, and returns fileId + downloadUrl", async () => {
      const ctx = await makeConversationCtx();
      const bytes = Buffer.from("hello from the sandbox\n", "utf8");
      nativeMock.readArtifact.mockResolvedValue({
        dataBase64: bytes.toString("base64"),
        sizeBytes: bytes.byteLength,
      });

      const result = await executeArchestraTool(
        TOOL_DOWNLOAD_FILE_FULL_NAME,
        { path: "out/file.txt", mimeType: "text/plain" },
        ctx,
      );
      expect(result.isError).toBe(false);

      // the relative path resolved against the sandbox cwd at the engine boundary
      expect(nativeMock.readArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/home/sandbox/out/file.txt" }),
      );

      const structured = structuredOf<{
        fileId: string;
        path: string;
        mimeType: string;
        sizeBytes: number;
        downloadUrl: string;
      }>(result);
      expect(structured.path).toBe("/home/sandbox/out/file.txt");
      expect(structured.mimeType).toBe("text/plain");
      expect(structured.sizeBytes).toBe(bytes.byteLength);
      expect(structured.downloadUrl).toBe(
        `/api/skill-sandbox/artifacts/${structured.fileId}`,
      );

      // the bytes were persisted durably as an artifact row
      const row = await SkillSandboxFileModel.findArtifactById(
        structured.fileId,
      );
      expect(row?.data.toString("utf8")).toBe(bytes.toString("utf8"));

      // text-only — bytes flow sandbox -> DB -> UI via the URL, never via the
      // MCP content array (which the chat layer would stringify into context).
      const contentTypes = (result.content as Array<{ type: string }>).map(
        (c) => c.type,
      );
      expect(contentTypes).toEqual(["text"]);
    });

    test("never attaches inline image content even for small raster files", async () => {
      const ctx = await makeConversationCtx();
      // real PNG signature so the byte sniffer classifies it as an image
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
      ]);
      nativeMock.readArtifact.mockResolvedValue({
        dataBase64: png.toString("base64"),
        sizeBytes: png.byteLength,
      });

      const result = await executeArchestraTool(
        TOOL_DOWNLOAD_FILE_FULL_NAME,
        { path: "preview.png", mimeType: "image/png" },
        ctx,
      );
      expect(result.isError).toBe(false);
      expect(structuredOf<{ mimeType: string }>(result).mimeType).toBe(
        "image/png",
      );
      const contents = result.content as Array<{ type: string }>;
      expect(contents.map((c) => c.type)).toEqual(["text"]);
    });
  });

  describe("upload_file", () => {
    test("enumerates the source variants when the discriminator is missing", async () => {
      const ctx = await makeConversationCtx();
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
      // input validation fails before the handler runs, so nothing is created.
      const sandboxes = await SkillSandboxModel.listForConversation({
        conversationId: ctx.conversationId as string,
        organizationId,
      });
      expect(sandboxes).toHaveLength(0);
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

      // the foreign bytes never became part of any sandbox recipe.
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

    // uploadFile does no Dagger work — these exercise the real persistence +
    // validation path against PGlite end to end.
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
        uploadId: string;
        sandboxId: string;
        path: string;
        mimeType: string;
        sizeBytes: number;
      }>(result);
      // default cwd is /home/sandbox, so a relative path resolves there.
      expect(structured.path).toBe("/home/sandbox/data/input.csv");
      expect(structured.sizeBytes).toBe(bytes.byteLength);
      expect(structured.mimeType).toBe("text/csv");
      expect(structured.uploadId).toBeTruthy();

      const log = await SkillSandboxReplayEventModel.listBySandbox(
        structured.sandboxId,
      );
      const uploads = log.filter((e) => e.kind === "upload");
      expect(uploads).toHaveLength(1);
      const [only] = uploads;
      if (only.kind !== "upload") throw new Error("expected an upload event");
      expect(only.upload.data.toString("utf8")).toBe(bytes.toString("utf8"));
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

  describe("revocation gate", () => {
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
      // fail-closed means no engine call was made for this sandbox.
      expect(nativeMock.runSandbox).not.toHaveBeenCalled();
    });
  });
});
