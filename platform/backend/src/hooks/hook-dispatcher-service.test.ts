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
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { hookDispatcherService } from "./hook-dispatcher-service";

// The dispatcher's isEnabled gates on config.hooks.enabled (which itself folds
// in the agent-runtime requirement at config-load time).
const originalHooks = config.hooks.enabled;

describe("hookDispatcherService", () => {
  beforeEach(() => {
    (config.hooks as { enabled: boolean }).enabled = true;
    vi.mocked(skillSandboxRuntimeService.runCommand).mockReset();
  });
  afterEach(() => {
    (config.hooks as { enabled: boolean }).enabled = originalHooks;
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
        stdout: "",
        stderr: "tool not allowed",
        durationMs: 5,
        payload: {
          tool_name: "bash",
          tool_input: {},
          session_id: "conv-1",
          cwd: SKILL_SANDBOX_HOME,
          permission_mode: "default",
          hook_event_name: "PreToolUse",
        },
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
    // Both proceeded runs surface their stdout + received payload for debug.
    expect(result.runs).toHaveLength(2);
    expect(result.runs?.map((r) => r.stdout)).toEqual(["ctx-a\n", "ctx-b\n"]);
    expect(result.runs?.[0].payload).toMatchObject({
      hook_event_name: "PreToolUse",
      session_id: "conv-2",
    });
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
    // durationMs is wall-clock from the catch path, so match it loosely.
    expect(result.runs).toHaveLength(1);
    expect(result.runs?.[0]).toEqual({
      hookEventName: "PreToolUse",
      fileName: "flaky.py",
      outcome: "error",
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: expect.any(Number),
      payload: {
        tool_name: "bash",
        tool_input: {},
        session_id: "conv-3",
        cwd: SKILL_SANDBOX_HOME,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
      },
    });
  });

  // -----------------------------------------------------------------------
  // 5. Feature flag disabled → immediate proceed, no DB or sandbox calls
  // -----------------------------------------------------------------------
  test("feature flag disabled → immediate proceed, no DB or sandbox calls", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    (config.hooks as { enabled: boolean }).enabled = false;

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
      event: "session_start",
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
      event: "session_start",
      conversationId,
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
      fields: {},
    });

    expect(spyFind).toHaveBeenCalledWith({
      organizationId: org.id,
      userId: user.id,
      conversationId,
      defaultCwd: "/home/sandbox",
    });
  });
});
