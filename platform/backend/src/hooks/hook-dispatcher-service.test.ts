import { vi } from "vitest";

vi.mock("@/skills-sandbox/skill-sandbox-runtime-service", () => ({
  skillSandboxRuntimeService: {
    runCommand: vi.fn(),
    uploadFile: vi.fn(),
    isEnabled: true,
  },
}));

import config from "@/config";
import { HookFileModel, SkillSandboxModel } from "@/models";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { hookDispatcherService } from "./hook-dispatcher-service";

// The dispatcher's isEnabled gates only on config.skillsSandbox.enabled.
const originalSkills = config.skillsSandbox.enabled;

describe("hookDispatcherService", () => {
  beforeEach(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
    vi.mocked(skillSandboxRuntimeService.runCommand).mockReset();
  });
  afterEach(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalSkills;
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. No matching hooks → fast-path, no sandbox resolved, no run
  // -----------------------------------------------------------------------
  test("agent with NO hooks for the event → proceed, findOrCreateDefault + runCommand not called (fast-path)", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const spyFind = vi.spyOn(SkillSandboxModel, "findOrCreateDefault");

    const result = await hookDispatcherService.fire({
      event: "pre_tool_use",
      conversationId: crypto.randomUUID(),
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
      fields: { tool_name: "bash", tool_input: {} },
    });

    expect(result).toEqual({ decision: "proceed", runs: [] });
    expect(spyFind).not.toHaveBeenCalled();
    expect(skillSandboxRuntimeService.runCommand).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 2. Two hooks, first blocks (exit 2) → result blocked, second never runs
  // -----------------------------------------------------------------------
  test("first hook exits 2 → block result, second hook never runs", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    // fileName ordering: a_ sorts before b_, so a_first.py runs first
    await HookFileModel.create({
      organizationId: org.id,
      agentId: agent.id,
      event: "pre_tool_use",
      fileName: "a_first.py",
      content: "import sys; sys.exit(2)",
      requirements: [],
    });
    await HookFileModel.create({
      organizationId: org.id,
      agentId: agent.id,
      event: "pre_tool_use",
      fileName: "b_second.py",
      content: "import sys; sys.exit(0)",
      requirements: [],
    });

    vi.spyOn(SkillSandboxModel, "findOrCreateDefault").mockResolvedValue({
      id: crypto.randomUUID(),
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
      defaultCwd: "/home/sandbox",
      isDefault: true,
      nextReplaySequence: 0,
      createdAt: new Date(),
    });

    // First call → exit 2 (blocked); second call should never happen
    vi.mocked(skillSandboxRuntimeService.runCommand).mockResolvedValueOnce({
      commandId: "cmd-1",
      sandboxId: "s" as never,
      command: "",
      cwd: null,
      stdout: "",
      stderr: "tool not allowed",
      exitCode: 2,
      durationMs: 5,
      timedOut: false,
      truncated: false,
      stagingNotices: [],
    });

    const result = await hookDispatcherService.fire({
      event: "pre_tool_use",
      conversationId: "conv-1",
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
      fields: { tool_name: "bash", tool_input: {} },
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toBe("tool not allowed");
    // The blocking run is reported (mapped for inline display); the second
    // hook never ran, so it is absent.
    expect(result.runs).toEqual([
      {
        hookEventName: "PreToolUse",
        fileName: "a_first.py",
        outcome: "blocked",
        exitCode: 2,
      },
    ]);
    // Only one run — second hook was never invoked.
    expect(skillSandboxRuntimeService.runCommand).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 3. Two hooks both exit 0 with stdout → injectedContext joined by \n
  // -----------------------------------------------------------------------
  test("two hooks exit 0 with stdout → injectedContext joined by newline", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    await HookFileModel.create({
      organizationId: org.id,
      agentId: agent.id,
      event: "pre_tool_use",
      fileName: "a_hook.py",
      content: "print('ctx-a')",
      requirements: [],
    });
    await HookFileModel.create({
      organizationId: org.id,
      agentId: agent.id,
      event: "pre_tool_use",
      fileName: "b_hook.py",
      content: "print('ctx-b')",
      requirements: [],
    });

    vi.spyOn(SkillSandboxModel, "findOrCreateDefault").mockResolvedValue({
      id: crypto.randomUUID(),
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-2",
      defaultCwd: "/home/sandbox",
      isDefault: true,
      nextReplaySequence: 0,
      createdAt: new Date(),
    });

    vi.mocked(skillSandboxRuntimeService.runCommand)
      .mockResolvedValueOnce({
        commandId: "cmd-1",
        sandboxId: "s" as never,
        command: "",
        cwd: null,
        stdout: "ctx-a\n",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
        truncated: false,
        stagingNotices: [],
      })
      .mockResolvedValueOnce({
        commandId: "cmd-2",
        sandboxId: "s" as never,
        command: "",
        cwd: null,
        stdout: "ctx-b\n",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
        truncated: false,
        stagingNotices: [],
      });

    const result = await hookDispatcherService.fire({
      event: "pre_tool_use",
      conversationId: "conv-2",
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
      fields: { tool_name: "bash", tool_input: {} },
    });

    expect(result.decision).toBe("proceed");
    expect(result.injectedContext).toBe("ctx-a\nctx-b");
  });

  // -----------------------------------------------------------------------
  // 4. Hook whose run errors/times out → fail open (proceed)
  // -----------------------------------------------------------------------
  test("hook that errors (throws from runtime) → fail open → proceed", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    await HookFileModel.create({
      organizationId: org.id,
      agentId: agent.id,
      event: "pre_tool_use",
      fileName: "flaky.py",
      content: "raise RuntimeError('boom')",
      requirements: [],
    });

    vi.spyOn(SkillSandboxModel, "findOrCreateDefault").mockResolvedValue({
      id: crypto.randomUUID(),
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-3",
      defaultCwd: "/home/sandbox",
      isDefault: true,
      nextReplaySequence: 0,
      createdAt: new Date(),
    });

    // hook-runner wraps errors internally: runCommand throws, but runHookScript
    // catches it and returns outcome:"error". Dispatcher proceeds (fail open).
    vi.mocked(skillSandboxRuntimeService.runCommand).mockRejectedValueOnce(
      new Error("engine down"),
    );

    const result = await hookDispatcherService.fire({
      event: "pre_tool_use",
      conversationId: "conv-3",
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
      fields: { tool_name: "bash", tool_input: {} },
    });

    expect(result.decision).toBe("proceed");
    // fail-open still reports the run that errored, mapped for inline display.
    expect(result.runs).toEqual([
      {
        hookEventName: "PreToolUse",
        fileName: "flaky.py",
        outcome: "error",
        exitCode: null,
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // 5. Feature flag disabled → immediate proceed, no DB or sandbox calls
  // -----------------------------------------------------------------------
  test("feature flag disabled → immediate proceed, no DB or sandbox calls", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    (config.skillsSandbox as { enabled: boolean }).enabled = false;

    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const spyFind = vi.spyOn(SkillSandboxModel, "findOrCreateDefault");

    const result = await hookDispatcherService.fire({
      event: "pre_tool_use",
      conversationId: crypto.randomUUID(),
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
      fields: {},
    });

    expect(result).toEqual({ decision: "proceed", runs: [] });
    expect(spyFind).not.toHaveBeenCalled();
    expect(skillSandboxRuntimeService.runCommand).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 6. findOrCreateDefault called with correct params
  // -----------------------------------------------------------------------
  test("findOrCreateDefault called with correct organizationId, userId, conversationId", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversationId = crypto.randomUUID();

    await HookFileModel.create({
      organizationId: org.id,
      agentId: agent.id,
      event: "user_prompt_submit",
      fileName: "notify.py",
      content: "print('ok')",
      requirements: [],
    });

    const spyFind = vi
      .spyOn(SkillSandboxModel, "findOrCreateDefault")
      .mockResolvedValue({
        id: crypto.randomUUID(),
        organizationId: org.id,
        userId: user.id,
        conversationId,
        defaultCwd: "/home/sandbox",
        isDefault: true,
        nextReplaySequence: 0,
        createdAt: new Date(),
      });

    vi.mocked(skillSandboxRuntimeService.runCommand).mockResolvedValue({
      commandId: "cmd-1",
      sandboxId: "s" as never,
      command: "",
      cwd: null,
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
      truncated: false,
      stagingNotices: [],
    });

    await hookDispatcherService.fire({
      event: "user_prompt_submit",
      conversationId,
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
      fields: { prompt: "hello" },
    });

    expect(spyFind).toHaveBeenCalledWith({
      organizationId: org.id,
      userId: user.id,
      conversationId,
      defaultCwd: "/home/sandbox",
    });
  });

  // -----------------------------------------------------------------------
  // 7. Transcript: fire materializes a Claude-format transcript + path
  // -----------------------------------------------------------------------
  test("writes a Claude-format transcript to the sandbox from supplied messages", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversationId = crypto.randomUUID();

    await HookFileModel.create({
      organizationId: org.id,
      agentId: agent.id,
      event: "user_prompt_submit",
      fileName: "notify.py",
      content: "print('ok')",
      requirements: [],
    });

    vi.spyOn(SkillSandboxModel, "findOrCreateDefault").mockResolvedValue({
      id: crypto.randomUUID(),
      organizationId: org.id,
      userId: user.id,
      conversationId,
      defaultCwd: "/home/sandbox",
      isDefault: true,
      nextReplaySequence: 0,
      createdAt: new Date(),
    });
    vi.mocked(skillSandboxRuntimeService.runCommand).mockResolvedValue({
      commandId: "cmd-1",
      sandboxId: "s" as never,
      command: "",
      cwd: null,
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
      truncated: false,
      stagingNotices: [],
    });
    vi.mocked(skillSandboxRuntimeService.uploadFile).mockResolvedValue({
      uploadId: "up-1",
      sandboxId: "s" as never,
      path: "",
      mimeType: "application/json",
      sizeBytes: 0,
    });

    await hookDispatcherService.fire({
      event: "user_prompt_submit",
      conversationId,
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
      fields: { prompt: "hello" },
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
      ],
    });

    // The transcript is uploaded first (before the per-fire script/payload).
    const firstUpload = vi.mocked(skillSandboxRuntimeService.uploadFile).mock
      .calls[0][0];
    expect(firstUpload.path).toBe(
      `/home/sandbox/transcript/${conversationId}.jsonl`,
    );
    const transcript = (firstUpload.data as Buffer).toString("utf8");
    expect(JSON.parse(transcript.trim()).message).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });
});
