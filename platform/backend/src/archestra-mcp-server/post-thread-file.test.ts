import {
  ADMIN_ROLE_NAME,
  TOOL_POST_THREAD_FILE_FULL_NAME,
} from "@archestra/shared";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import config from "@/config";
import { ConversationModel, SkillSandboxModel } from "@/models";
import {
  SandboxRuntimeError,
  sandboxRuntimeService,
} from "@/sandbox-runtime/sandbox-runtime-service";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

// Only the container and messaging-provider boundaries are stubbed. Tool
// admission, sandbox ownership, file limits and extraction run as production code.
describe("post_thread_file", () => {
  let context: ArchestraContext & { organizationId: string; userId: string };
  const bytes = Buffer.from([0, 255, 128, 42]);

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeMember,
      seedAndAssignArchestraTools,
    }) => {
      config.skillsSandbox.enabled = true;
      const agent = await makeAgent();
      const user = await makeUser();
      await makeMember(user.id, agent.organizationId, {
        role: ADMIN_ROLE_NAME,
      });
      await seedAndAssignArchestraTools(agent.id);
      context = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: agent.organizationId,
        userId: user.id,
        isolationKey: crypto.randomUUID(),
        chatOpsBindingId: crypto.randomUUID(),
        chatOpsThreadId: "1234567890.123456",
        chatOpsPinnedAgentId: agent.id,
      };
      vi.spyOn(sandboxRuntimeService, "isEnabled", "get").mockReturnValue(true);
      vi.spyOn(sandboxRuntimeService, "readArtifact").mockResolvedValue({
        dataBase64: bytes.toString("base64"),
        sizeBytes: bytes.length,
      });
      vi.spyOn(chatOpsManager, "uploadFileToBindingThread").mockResolvedValue();
    },
  );

  afterEach(() => {
    if (context.isolationKey)
      executionSandboxRegistry.release(context.isolationKey);
    vi.restoreAllMocks();
  });

  const post = (
    args: Record<string, unknown> = { path: "artifacts/demo.mp4" },
    ctx: ArchestraContext = context,
  ) => executeArchestraTool(TOOL_POST_THREAD_FILE_FULL_NAME, args, ctx);

  test("posts exact sandbox bytes to the trusted thread using the pinned agent bot", async () => {
    const result = await post({
      path: "artifacts/demo.mp4",
      comment: "Here is the recording.",
    });
    expect(result.isError).toBe(false);
    expect(
      chatOpsManager.uploadFileToBindingThread,
    ).toHaveBeenCalledExactlyOnceWith({
      bindingId: context.chatOpsBindingId,
      threadId: context.chatOpsThreadId,
      pinnedAgentId: context.chatOpsPinnedAgentId,
      filename: "demo.mp4",
      data: bytes,
      comment: "Here is the recording.",
    });
    expect(sandboxRuntimeService.readArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/home/sandbox/artifacts/demo.mp4",
        fileSizeLimitBytes: Math.min(
          config.skillsSandbox.artifactBytesLimit,
          40 * 1024 * 1024,
        ),
      }),
    );
    expect(result.structuredContent).toEqual({
      success: true,
      filename: "demo.mp4",
      sizeBytes: bytes.length,
    });
    expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
  });

  test("honors an upload filename without changing the source path", async () => {
    await post({ path: "artifacts/demo.mp4", filename: "walkthrough.mp4" });
    expect(chatOpsManager.uploadFileToBindingThread).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "walkthrough.mp4" }),
    );
    expect(sandboxRuntimeService.readArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/home/sandbox/artifacts/demo.mp4" }),
    );
  });

  test.each([
    "chatOpsBindingId",
    "chatOpsThreadId",
    "isolationKey",
  ] as const)("rejects missing %s before reading bytes", async (field) => {
    const result = await post(undefined, { ...context, [field]: undefined });
    expect(result.isError).toBe(true);
    expect(sandboxRuntimeService.readArtifact).not.toHaveBeenCalled();
    expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
  });

  test("rejects app callers even if they carry messaging context", async () => {
    expect(
      (await post(undefined, { ...context, appId: crypto.randomUUID() }))
        .isError,
    ).toBe(true);
    expect(sandboxRuntimeService.readArtifact).not.toHaveBeenCalled();
    expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
  });

  test("cannot select another channel through arguments", async () => {
    const result = await post({
      path: "demo.mp4",
      channel_id: "other-channel",
      thread_id: "other-thread",
    });
    expect(result.isError).toBe(true);
    expect(sandboxRuntimeService.readArtifact).not.toHaveBeenCalled();
    expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
  });

  test("can post from an explicitly selected sandbox in the current execution", async () => {
    const current = await executionSandboxRegistry.getOrCreateDefault({
      organizationId: context.organizationId,
      userId: context.userId,
      isolationKey: context.isolationKey as string,
      defaultCwd: "/home/sandbox",
    });
    expect(
      (await post({ path: "demo.mp4", target: { id: current.id } })).isError,
    ).toBe(false);
    expect(chatOpsManager.uploadFileToBindingThread).toHaveBeenCalledTimes(1);
  });

  test("stops before extraction when the sandbox feature is disabled", async () => {
    config.skillsSandbox.enabled = false;
    expect((await post()).isError).toBe(true);
    expect(sandboxRuntimeService.readArtifact).not.toHaveBeenCalled();
    expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
  });

  test("rejects a sandbox owned by another execution of the same user", async () => {
    const otherKey = crypto.randomUUID();
    const other = await executionSandboxRegistry.getOrCreateDefault({
      organizationId: context.organizationId,
      userId: context.userId,
      isolationKey: otherKey,
      defaultCwd: "/home/sandbox",
    });
    try {
      expect(
        (await post({ path: "demo.mp4", target: { id: other.id } })).isError,
      ).toBe(true);
      expect(sandboxRuntimeService.readArtifact).not.toHaveBeenCalled();
      expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
    } finally {
      executionSandboxRegistry.release(otherKey);
    }
  });

  test("rejects a sandbox from another conversation", async () => {
    const otherConversation = await ConversationModel.create({
      userId: context.userId,
      organizationId: context.organizationId,
      agentId: context.agent.id,
      title: "Other conversation",
    });
    const other = await SkillSandboxModel.findOrCreateDefault({
      organizationId: context.organizationId,
      userId: context.userId,
      conversationId: otherConversation.id,
      defaultCwd: "/home/sandbox",
    });
    expect(
      (await post({ path: "demo.mp4", target: { id: other.id } })).isError,
    ).toBe(true);
    expect(sandboxRuntimeService.readArtifact).not.toHaveBeenCalled();
    expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
  });

  test.each([
    "../secret",
    "/etc/passwd",
    "file\0.mp4",
  ])("rejects unsafe path %j before extraction", async (path) => {
    expect((await post({ path })).isError).toBe(true);
    expect(sandboxRuntimeService.readArtifact).not.toHaveBeenCalled();
    expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
  });

  test("enforces the deployment's lower byte limit without posting", async () => {
    config.skillsSandbox.artifactBytesLimit = bytes.length - 1;
    expect((await post()).isError).toBe(true);
    expect(sandboxRuntimeService.readArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ fileSizeLimitBytes: bytes.length - 1 }),
    );
    expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
  });

  test("refuses an empty file", async () => {
    vi.mocked(sandboxRuntimeService.readArtifact).mockResolvedValue({
      dataBase64: "",
      sizeBytes: 0,
    });
    expect((await post()).isError).toBe(true);
    expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
  });

  test("reports a missing file without posting", async () => {
    vi.mocked(sandboxRuntimeService.readArtifact).mockRejectedValue(
      new SandboxRuntimeError("File not found", "ARCHESTRA_ARTIFACT_NOT_FOUND"),
    );
    const result = await post();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("File not found");
    expect(chatOpsManager.uploadFileToBindingThread).not.toHaveBeenCalled();
  });

  test("does not report success or retry when the provider fails", async () => {
    vi.mocked(chatOpsManager.uploadFileToBindingThread).mockRejectedValue(
      new Error("Upload failed"),
    );
    const result = await post();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).not.toMatchObject({ success: true });
    expect(chatOpsManager.uploadFileToBindingThread).toHaveBeenCalledTimes(1);
  });
});
