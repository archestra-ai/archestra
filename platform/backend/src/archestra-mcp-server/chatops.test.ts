import { createHash, randomUUID } from "node:crypto";
import {
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_POST_RUN_FILE_FULL_NAME,
  TOOL_POST_THREAD_FILE_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
} from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import {
  type ThreadFileScope,
  threadFileStore,
} from "@/agents/chatops/thread-file-store";
import { CacheKey, cacheManager } from "@/cache-manager";
import {
  buildArchestraToolOutput,
  mcpToolToModelOutput,
} from "@/clients/chat-tool-builder";
import config from "@/config";
import { evaluatePolicies } from "@/guardrails/tool-invocation";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
  FileModel,
  OrganizationModel,
  SkillSandboxFileModel,
  ToolModel,
} from "@/models";
import { sandboxRuntimeService } from "@/sandbox-runtime/sandbox-runtime-service";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer as createMswServer } from "@/test/msw";
import { type ArchestraContext, executeArchestraTool } from ".";

vi.mock("@/cache-manager");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=",
  "base64",
);
const server = createMswServer();
let context: ArchestraContext;
let scope: ThreadFileScope;
let uploads: Buffer[];
let finalizations: URLSearchParams[];
let uploadRequests: URLSearchParams[];
let toolId: string;

beforeEach(
  async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    seedAndAssignArchestraTools,
  }) => {
    config.skillsSandbox.enabled = true;
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: user.id,
      scope: "org",
      agentType: "agent",
    });
    await seedAndAssignArchestraTools(agent.id);
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: organization.id,
      provider: "slack",
      channelId: "C_IMAGE_TEST",
      workspaceId: "T_IMAGE_TEST",
      agentId: agent.id,
    });
    scope = {
      organizationId: organization.id,
      userId: user.id,
      isolationKey: executionSandboxRegistry.openEphemeralExecution((key) =>
        threadFileStore.release(key),
      ),
      chatOpsBindingId: binding.id,
      chatOpsThreadId: "1780000000.000001",
    };
    context = {
      ...scope,
      chatOpsMessageId: "1780000000.000002",
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      contextIsTrusted: true,
    };
    [toolId] = await ToolModel.findBuiltInToolIdsByNames([
      TOOL_POST_THREAD_FILE_FULL_NAME,
    ]);
    uploads = [];
    finalizations = [];
    uploadRequests = [];
    server.use(
      http.post("https://slack.com/api/auth.test", () =>
        HttpResponse.json({ ok: true, team_id: "T_IMAGE_TEST" }),
      ),
      http.post("https://slack.com/api/conversations.list", () =>
        HttpResponse.json({
          ok: true,
          channels: [
            {
              id: "C_IMAGE_TEST",
              name: "images",
              is_member: true,
              is_private: true,
            },
          ],
        }),
      ),
      http.post(
        "https://slack.com/api/files.getUploadURLExternal",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer xoxb-image-test",
          );
          const body = new URLSearchParams(await request.text());
          uploadRequests.push(body);
          return HttpResponse.json({
            ok: true,
            file_id: "F_IMAGE_TEST",
            upload_url: "https://files.slack.com/upload/v1/image-test",
          });
        },
      ),
      http.post(
        "https://files.slack.com/upload/v1/image-test",
        async ({ request }) => {
          const body = (await request.formData()).get("body") as File;
          uploads.push(Buffer.from(await body.arrayBuffer()));
          return new HttpResponse("OK");
        },
      ),
      http.post(
        "https://slack.com/api/files.completeUploadExternal",
        async ({ request }) => {
          finalizations.push(new URLSearchParams(await request.text()));
          return HttpResponse.json({
            ok: true,
            files: [{ id: "F_IMAGE_TEST" }],
          });
        },
      ),
    );
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-image-test",
      signingSecret: "test-signing-secret",
      appId: "A_IMAGE_TEST",
      connectionMode: "webhook",
    });
    await chatOpsManager.initialize();
  },
);

afterEach(async () => {
  await chatOpsManager.cleanup();
  if (scope) {
    threadFileStore.release(scope.isolationKey);
    executionSandboxRegistry.release(scope.isolationKey);
  }
});

function retain(overrides: Partial<{ data: Buffer; filename: string }> = {}) {
  return threadFileStore.retain({
    scope,
    data: png,
    filename: "sample.png",
    ...overrides,
  });
}

function send(
  image: ReturnType<typeof retain>,
  indirect = false,
  caller = context,
) {
  const args = { file_id: image.fileId, sha256: image.sha256 };
  return indirect
    ? executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: TOOL_POST_THREAD_FILE_FULL_NAME, tool_args: args },
        caller,
      )
    : executeArchestraTool(TOOL_POST_THREAD_FILE_FULL_NAME, args, caller);
}

describe("post_thread_file", () => {
  test("uploads original bytes through Slack's authenticated binary API without a sandbox", async () => {
    config.skillsSandbox.enabled = false;
    const image = retain();
    const result = await send(image);
    expect(result.isError).toBe(false);
    expect(uploads).toEqual([png]);
    expect(uploadRequests[0].get("filename")).toBe("sample.png");
    expect(Number(uploadRequests[0].get("length"))).toBe(png.length);
    expect(finalizations[0].get("channel_id")).toBe("C_IMAGE_TEST");
    expect(finalizations[0].get("thread_ts")).toBe(scope.chatOpsThreadId);
    expect(result.structuredContent).toEqual({
      slack_file_id: "F_IMAGE_TEST",
      channel_id: "C_IMAGE_TEST",
      thread_ts: scope.chatOpsThreadId,
      sha256: image.sha256,
      already_sent: false,
    });
    expect(await executionSandboxRegistry.findDefault(scope)).toBeNull();
    expect(JSON.stringify(result)).not.toContain(png.toString("base64"));
    expect(JSON.stringify(result)).not.toContain("xoxb-");
  });

  test("does not start an upload if its execution closes during destination validation", async () => {
    const image = retain();
    const upload =
      chatOpsManager.uploadFileToBindingThread.bind(chatOpsManager);
    vi.spyOn(
      chatOpsManager,
      "uploadFileToBindingThread",
    ).mockImplementationOnce((params) => {
      // Run the real destination lookup, closing the scope while it awaits DB.
      const pending = upload(params);
      executionSandboxRegistry.release(scope.isolationKey);
      return pending;
    });

    expect((await send(image)).isError).toBe(true);
    expect(uploadRequests).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(finalizations).toHaveLength(0);
  });

  test("rejects unsupported providers and invalid Slack destinations before uploading", async () => {
    for (const overrides of [
      { provider: "telegram" as const },
      { provider: "ms-teams" as const },
      { isDm: true },
      { workspaceId: null },
      { workspaceId: "T_OTHER" },
      { threadId: "not-a-slack-thread" },
    ]) {
      const { threadId = scope.chatOpsThreadId, ...bindingOverrides } =
        overrides;
      const binding = await ChatOpsChannelBindingModel.create({
        organizationId: scope.organizationId,
        provider: "slack",
        channelId: `C_${randomUUID()}`,
        workspaceId: "T_IMAGE_TEST",
        agentId: context.agent.id,
        ...bindingOverrides,
      });
      const caller = {
        ...context,
        chatOpsBindingId: binding.id,
        chatOpsThreadId: threadId,
      };
      const file = threadFileStore.retain({
        scope: {
          ...scope,
          chatOpsBindingId: binding.id,
          chatOpsThreadId: threadId,
        },
        data: png,
        filename: "source.png",
      });
      expect((await send(file, false, caller)).isError).toBe(true);
    }
    expect(uploadRequests).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  test("replays a receipt and suppresses concurrent sends, including run_tool", async () => {
    const image = retain();
    const results = await Promise.all([send(image), send(image, true)]);
    expect(results.some((result) => !result.isError)).toBe(true);
    expect(uploads).toEqual([png]);
    const replay = await send(image, true);
    expect(replay.isError, JSON.stringify(replay)).toBe(false);
    expect(replay.structuredContent).toMatchObject({
      already_sent: true,
      slack_file_id: "F_IMAGE_TEST",
    });
    expect(uploads).toHaveLength(1);
    const freshTurn = await send(image, false, {
      ...context,
      chatOpsMessageId: "1780000000.000003",
    });
    expect(freshTurn.isError).toBe(false);
    expect(uploads).toHaveLength(2);
  });

  test("revalidates the authorized destination and network targets before sending", async () => {
    const binding = await ChatOpsChannelBindingModel.findById(
      scope.chatOpsBindingId,
    );
    if (!binding) throw new Error("Missing test binding");
    const expected = chatOpsManager.prepareThreadFileUpload({
      ...binding,
      threadId: scope.chatOpsThreadId,
    });
    for (const changed of [
      { organizationId: randomUUID() },
      { provider: "telegram" as const },
      { channelId: "C_OTHER" },
      { workspaceId: "T_OTHER" },
      { isDm: true },
      { threadId: "1780000000.000099" },
    ]) {
      await expect(
        chatOpsManager.uploadFileToBindingThread({
          bindingId: binding.id,
          threadId: scope.chatOpsThreadId,
          data: png,
          filename: "source.png",
          expectedUpload: {
            ...expected,
            destination: { ...expected.destination, ...changed },
          },
        }),
      ).rejects.toThrow("destination changed");
    }
    await expect(
      chatOpsManager.uploadFileToBindingThread({
        bindingId: binding.id,
        threadId: scope.chatOpsThreadId,
        data: png,
        filename: "source.png",
        expectedUpload: { ...expected, networkUrls: ["https://slack.com"] },
      }),
    ).rejects.toThrow("destination changed");
    expect(uploadRequests).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  test("uploads a non-image binary unchanged without a sandbox", async () => {
    const filename = "archive.zip";
    const data = Buffer.from([0x50, 0x4b, 3, 4, 0, 255]);
    config.skillsSandbox.enabled = false;
    const file = retain({ filename, data });
    const result = await send(file);
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(uploads).toEqual([data]);
    expect(uploadRequests[0].get("filename")).toBe(filename);
    expect(Number(uploadRequests[0].get("length"))).toBe(data.length);
    expect(finalizations[0].get("thread_ts")).toBe(scope.chatOpsThreadId);
    expect(await executionSandboxRegistry.findDefault(scope)).toBeNull();
  });

  test("checks document type and filename policies before uploading", async ({
    makeToolPolicy,
  }) => {
    await makeToolPolicy(toolId, {
      conditions: [
        { key: "mime_type", operator: "equal", value: "application/pdf" },
      ],
      action: "block_always",
      reason: "PDF delivery is restricted",
    });
    await makeToolPolicy(toolId, {
      conditions: [
        { key: "filename", operator: "equal", value: "private.csv" },
      ],
      action: "block_always",
      reason: "This report is restricted",
    });
    for (const file of [
      retain({
        filename: "mislabelled.txt",
        data: Buffer.from("%PDF-1.7\n%%EOF\n"),
      }),
      retain({
        filename: "private.csv",
        data: Buffer.from("item,count\nalpha,2\n"),
      }),
    ]) {
      for (const indirect of [false, true]) {
        const result = await send(file, indirect);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("restricted");
      }
    }
    expect(uploads).toHaveLength(0);
  });

  test("rejects empty, oversized, and invalidly named files before requesting an upload", async () => {
    for (const file of [
      retain({ filename: "empty.csv", data: Buffer.alloc(0) }),
      retain({
        filename: "large.bin",
        data: Buffer.alloc(20 * 1024 * 1024 + 1),
      }),
      retain({ filename: "../report.csv" }),
      retain({ filename: "report\n.csv" }),
    ]) {
      expect((await send(file)).isError).toBe(true);
    }
    expect(uploadRequests).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  test("does not repeat an upload after an ambiguous Slack error or lost receipt", async () => {
    server.use(
      http.post("https://slack.com/api/files.completeUploadExternal", () =>
        HttpResponse.json({ ok: false, error: "internal_error" }),
      ),
    );
    const image = retain();
    expect((await send(image)).isError).toBe(true);
    const replay = await send(image, true);
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay)).toContain("outcome is unknown");
    expect(uploads).toEqual([png]);
  });

  test("losing the receipt cache cannot reopen the durable upload claim", async () => {
    const image = retain();
    expect((await send(image)).isError).toBe(false);
    await cacheManager.deleteByPrefix(CacheKey.SlackFileDeliveryReceipt);
    expect((await send(image)).isError).toBe(true);
    expect(uploads).toEqual([png]);
  });

  test("checks resolved destination policies on direct and indirect calls", async ({
    makeToolPolicy,
  }) => {
    await makeToolPolicy(toolId, {
      conditions: [
        { key: "channel_id", operator: "equal", value: "C_IMAGE_TEST" },
      ],
      action: "block_always",
      reason: "This destination is restricted",
    });
    const image = retain();
    for (const indirect of [false, true]) {
      const result = await send(image, indirect);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        "This destination is restricted",
      );
    }
    expect(uploads).toHaveLength(0);
  });

  test("defers destination policies until execution resolves the private image and channel", async ({
    makeToolPolicy,
  }) => {
    await makeToolPolicy(toolId, { conditions: [], action: "block_always" });
    await makeToolPolicy(toolId, {
      conditions: [
        { key: "channel_id", operator: "equal", value: "C_IMAGE_TEST" },
      ],
      action: "allow_when_context_is_untrusted",
    });
    const image = retain();
    const upstream = await evaluatePolicies(
      [
        {
          toolCallName: TOOL_POST_THREAD_FILE_FULL_NAME,
          toolCallArgs: JSON.stringify({
            file_id: image.fileId,
            sha256: image.sha256,
          }),
        },
      ],
      context.agent.id,
      { teamIds: [] },
      false,
      new Set([TOOL_POST_THREAD_FILE_FULL_NAME]),
    );
    expect(upstream).toBeNull();
    expect(
      (await send(image, false, { ...context, contextIsTrusted: false }))
        .isError,
    ).toBe(false);
    expect(uploads).toEqual([png]);
  });

  test("fails closed for approval-required policies despite a general approval flag", async ({
    makeToolPolicy,
  }) => {
    await makeToolPolicy(toolId, {
      conditions: [],
      action: "require_approval",
    });
    const image = retain();
    for (const indirect of [false, true]) {
      const result = await send(image, indirect, {
        ...context,
        approvalRequiredPoliciesHandled: true,
      });
      expect(result.isError).toBe(true);
    }
    expect(uploads).toHaveLength(0);
  });

  test("rejects an untrusted or unknown context without an allowing policy", async () => {
    const image = retain();
    for (const contextIsTrusted of [false, undefined]) {
      expect(
        (await send(image, false, { ...context, contextIsTrusted })).isError,
      ).toBe(true);
    }
    expect(uploads).toHaveLength(0);
  });

  test.for([
    true,
    false,
  ])("requires approval when specific allow and approval rules overlap (allow first: %s)", async (allowFirst, {
    makeToolPolicy,
  }) => {
    for (const allow of [allowFirst, !allowFirst]) {
      await makeToolPolicy(toolId, {
        conditions: [
          {
            key: allow ? "mime_type" : "channel_id",
            operator: "equal",
            value: allow ? "image/png" : "C_IMAGE_TEST",
          },
        ],
        action: allow ? "allow_when_context_is_untrusted" : "require_approval",
      });
    }
    const image = retain();
    for (const indirect of [false, true]) {
      const result = await send(image, indirect, {
        ...context,
        contextIsTrusted: false,
        approvalRequiredPoliciesHandled: true,
      });
      expect(result.isError).toBe(true);
    }
    expect(uploads).toHaveLength(0);
  });

  test("cannot reuse a reference in a different execution, actor, organization, or thread", async () => {
    const image = retain();
    for (const override of [
      { isolationKey: randomUUID() },
      { userId: randomUUID() },
      { organizationId: randomUUID() },
      { chatOpsThreadId: "1780000000.000004" },
    ]) {
      expect(
        (await send(image, false, { ...context, ...override })).isError,
      ).toBe(true);
    }
    threadFileStore.release(scope.isolationKey);
    expect((await send(image)).isError).toBe(true);
    expect(uploads).toHaveLength(0);
  });

  test("rejects changed content and caller-supplied destinations", async () => {
    const image = retain();
    expect((await send({ ...image, sha256: "0".repeat(64) })).isError).toBe(
      true,
    );
    expect(
      (
        await executeArchestraTool(
          TOOL_POST_THREAD_FILE_FULL_NAME,
          {
            file_id: image.fileId,
            sha256: image.sha256,
            channel_id: "C_OTHER",
          },
          context,
        )
      ).isError,
    ).toBe(true);
    expect(uploads).toHaveLength(0);
  });

  test("respects environment egress restrictions before sending bytes", async () => {
    await OrganizationModel.patch(scope.organizationId, {
      defaultNetworkPolicy: {
        egressMode: "off",
        domainPreset: "none",
        allowedDomains: [],
        allowedCidrs: [],
      },
    });
    expect((await send(retain())).isError).toBe(true);
    expect(uploads).toHaveLength(0);
  });

  test.for([
    { filename: "sample.png", data: png },
    { filename: "report.csv", data: Buffer.from("item,count\nalpha,2\n") },
  ])("stages and posts generated $filename through direct and indirect calls", async ({
    filename,
    data,
  }) => {
    config.daggerRuntime.enabled = true;
    const original = retain({ filename, data });
    const uploaded = await executeArchestraTool(
      TOOL_UPLOAD_FILE_FULL_NAME,
      {
        path: `/home/sandbox/input-${filename}`,
        source: { type: "thread_file", fileId: original.fileId },
      },
      context,
    );
    expect(uploaded.isError, JSON.stringify(uploaded)).toBe(false);
    const uploadId = uploaded.structuredContent?.uploadId as string;
    const staged = await SkillSandboxFileModel.findUploadDataById(uploadId);
    expect(staged).toBeNull();
    vi.spyOn(sandboxRuntimeService, "readArtifact").mockResolvedValue({
      dataBase64: data.toString("base64"),
      sizeBytes: data.length,
    });
    const downloaded = await executeArchestraTool(
      TOOL_DOWNLOAD_FILE_FULL_NAME,
      { path: `/home/sandbox/${filename}` },
      context,
    );
    expect(downloaded.isError).toBe(false);
    const modelResult = mcpToolToModelOutput({
      output: await buildArchestraToolOutput({
        response: downloaded,
        toolName: TOOL_DOWNLOAD_FILE_FULL_NAME,
        toolArguments: { path: `/home/sandbox/${filename}` },
        agentId: context.agent.id,
        userId: scope.userId,
        organizationId: scope.organizationId,
      }),
    });
    const metadata = downloaded.structuredContent?.threadFile as ReturnType<
      typeof retain
    >;
    expect(metadata).toMatchObject({
      filename,
      sha256: original.sha256,
    });
    expect(JSON.stringify(modelResult)).toContain(metadata.fileId);
    expect(JSON.stringify(modelResult)).toContain(metadata.sha256);
    expect(JSON.stringify(modelResult)).not.toContain(data.toString("base64"));
    const indirectArguments = {
      tool_name: TOOL_DOWNLOAD_FILE_FULL_NAME,
      tool_args: { path: `/home/sandbox/${filename}` },
    };
    const indirectDownload = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      indirectArguments,
      context,
    );
    expect(indirectDownload.isError).toBe(false);
    const indirectMetadata = indirectDownload.structuredContent
      ?.threadFile as ReturnType<typeof retain>;
    const indirectModelResult = mcpToolToModelOutput({
      output: await buildArchestraToolOutput({
        response: indirectDownload,
        toolName: TOOL_RUN_TOOL_FULL_NAME,
        toolArguments: indirectArguments,
        agentId: context.agent.id,
        userId: scope.userId,
        organizationId: scope.organizationId,
      }),
    });
    expect(indirectMetadata.sha256).toBe(original.sha256);
    expect(JSON.stringify(indirectModelResult)).toContain(
      indirectMetadata.fileId,
    );
    expect(JSON.stringify(indirectModelResult)).toContain(
      indirectMetadata.sha256,
    );
    expect(JSON.stringify(indirectModelResult)).not.toContain(
      data.toString("base64"),
    );
    expect(downloaded.structuredContent?.fileId).toBeUndefined();
    expect(indirectDownload.structuredContent?.fileId).toBeUndefined();
    const stored = await FileModel.findOrphanByName({
      filename,
      organizationId: scope.organizationId,
      userId: scope.userId,
    });
    expect(stored).toBeNull();
    expect((await send(metadata)).isError).toBe(false);
    expect(uploads).toEqual([data]);
  });
});

describe("temporary runtime files", () => {
  async function runtimeTask() {
    const owner = await A2AContextModel.create({
      actorKind: "user",
      actorId: scope.userId,
    });
    const task = await A2ATaskModel.create({
      contextId: owner.id,
      agentId: context.agent.id,
      state: "TASK_STATE_WORKING",
    });
    const session = await AgentRunModel.create({
      organizationId: scope.organizationId,
      taskId: task.id,
      agentId: context.agent.id,
      actorKind: "user",
      actorId: scope.userId,
      actorUserId: scope.userId,
      workloadName: `test-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
      completionTarget: {
        type: "chatops",
        bindingId: scope.chatOpsBindingId,
        threadId: scope.chatOpsThreadId,
        ephemeralFiles: true,
      },
    });
    await AgentWorkspaceModel.create({
      id: task.id,
      organizationId: scope.organizationId,
      agentId: context.agent.id,
      actorKind: "user",
      actorId: scope.userId,
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName: session.workloadName,
      state: "active",
      activeTaskId: task.id,
      lastTaskId: task.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // The filesystem transport is a process boundary; its path/mount/bounds
    // checks are exercised separately against the actual helper and exec stream.
    vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
    const available = vi
      .spyOn(agentRuntimeManager, "assertThreadFilesAvailable")
      .mockResolvedValue();
    const capture = vi
      .spyOn(agentRuntimeManager, "readThreadFile")
      .mockResolvedValue(Buffer.from(png));
    const args = {
      task_id: task.id,
      path: "inputs/source.png",
      sha256: createHash("sha256").update(png).digest("hex"),
    };
    return { task, session, args, available, capture };
  }

  test("sends captured runtime bytes privately and deduplicates retries", async () => {
    const { args } = await runtimeTask();
    const first = await executeArchestraTool(
      TOOL_POST_RUN_FILE_FULL_NAME,
      args,
      context,
    );
    const second = await executeArchestraTool(
      TOOL_POST_RUN_FILE_FULL_NAME,
      args,
      context,
    );
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({
      sha256: args.sha256,
      already_sent: false,
      thread_ts: scope.chatOpsThreadId,
    });
    expect(second.structuredContent).toMatchObject({ already_sent: true });
    expect(uploads).toEqual([png]);
    expect(JSON.stringify(first)).not.toContain(png.toString("base64"));
  });

  test("rejects changed bytes and inline-body attempts without uploading", async () => {
    const { args } = await runtimeTask();
    for (const invalid of [
      { ...args, sha256: "0".repeat(64) },
      {
        task_id: args.task_id,
        filename: "source.png",
        content_base64: png.toString("base64"),
      },
      { ...args, content_base64: png.toString("base64") },
    ]) {
      expect(
        (
          await executeArchestraTool(
            TOOL_POST_RUN_FILE_FULL_NAME,
            invalid,
            context,
          )
        ).isError,
      ).toBe(true);
    }
    expect(uploads).toEqual([]);
  });

  test("another owner or agent cannot read a runtime file", async ({
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const { args, capture } = await runtimeTask();
    const other = await makeUser();
    await makeMember(other.id, scope.organizationId, { role: "admin" });
    const agent = await makeAgent({
      organizationId: scope.organizationId,
      authorId: scope.userId,
      agentType: "agent",
      scope: "org",
    });
    await seedAndAssignArchestraTools(agent.id);
    for (const caller of [
      { ...context, userId: other.id },
      {
        ...context,
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
      },
    ]) {
      expect(
        (await executeArchestraTool(TOOL_POST_RUN_FILE_FULL_NAME, args, caller))
          .isError,
      ).toBe(true);
    }
    expect(capture).not.toHaveBeenCalled();
    expect(uploads).toEqual([]);
  });

  test("compute loss and a task ending during capture prevent delivery", async () => {
    const { args, session, capture, available } = await runtimeTask();
    available.mockRejectedValueOnce(new Error("temporary volume missing"));
    expect(
      (await executeArchestraTool(TOOL_POST_RUN_FILE_FULL_NAME, args, context))
        .isError,
    ).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    capture.mockImplementationOnce(async () => {
      await AgentWorkspaceModel.release({
        workloadName: session.workloadName,
        taskId: session.taskId,
      });
      return Buffer.from(png);
    });
    expect(
      (await executeArchestraTool(TOOL_POST_RUN_FILE_FULL_NAME, args, context))
        .isError,
    ).toBe(true);
    expect(uploads).toEqual([]);
  });

  test("runtime uploads enforce the same resolved file policies", async ({
    makeToolPolicy,
  }) => {
    const { args } = await runtimeTask();
    const [runtimeToolId] = await ToolModel.findBuiltInToolIdsByNames([
      TOOL_POST_RUN_FILE_FULL_NAME,
    ]);
    await makeToolPolicy(runtimeToolId, {
      conditions: [{ key: "mime_type", operator: "equal", value: "image/png" }],
      action: "block_always",
    });
    expect(
      (await executeArchestraTool(TOOL_POST_RUN_FILE_FULL_NAME, args, context))
        .isError,
    ).toBe(true);
    expect(uploads).toEqual([]);
  });
});
