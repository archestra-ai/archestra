import config from "@/config";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { afterEach, describe, expect, test, vi } from "@/test";
import type { AgentRuntime } from "@/types";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import {
  extractFinalAnswer,
  resolveAgentRuntime,
  resumeAgentRun,
} from "./pod-run";

const originalEnabled = config.agentRuntime.enabled;

afterEach(() => {
  config.agentRuntime.enabled = originalEnabled;
});

describe("resolveAgentRuntime", () => {
  test("does not change foreground delegation while Agent Runtime is disabled", () => {
    config.agentRuntime.enabled = false;

    expect(resolveAgentRuntime(agentWithRuntime)).toBeNull();
  });

  test("resolves the Agent runtime after the independent feature is enabled", () => {
    config.agentRuntime.enabled = true;

    expect(resolveAgentRuntime(agentWithRuntime)).toEqual({
      ...runtime,
      agentId: "agent-1",
      organizationId: "organization-1",
      environmentId: "environment-1",
      secretId: "secret-1",
    });
  });
});

const runtime = {
  image: "example.com/coding-agent:latest",
  command: null,
  inferenceProtocol: "openai_responses",
  backend: "kubernetes",
  steerMode: "pipe",
  privileged: false,
  resources: null,
  environment: null,
  credentials: null,
  ttlHours: null,
  idleTimeoutMinutes: null,
} satisfies AgentRuntime;

const agentWithRuntime = {
  id: "agent-1",
  organizationId: "organization-1",
  environmentId: "environment-1",
  runtime,
  runtimeSecretId: "secret-1",
};

test.for([
  true,
  false,
])("recovery requires the original volatile files (available: %s)", async (available, {
  makeAgent,
  makeUser,
}) => {
  const user = await makeUser();
  const agent = await makeAgent();
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  const session = await AgentRunModel.create({
    organizationId: agent.organizationId,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    backend: "kubernetes",
    runtimeScope: "test-runtime",
    workloadName: `recovery-${task.id}`,
    completionTarget: {
      type: "chatops",
      bindingId: crypto.randomUUID(),
      threadId: "1780000000.000001",
      ephemeralFiles: true,
    },
  });
  await AgentWorkspaceModel.create({
    organizationId: agent.organizationId,
    agentId: agent.id,
    actorKind: "user",
    actorId: user.id,
    backend: "kubernetes",
    runtimeScope: session.runtimeScope,
    workloadName: session.workloadName,
    state: "active",
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  const availability = vi
    .spyOn(backend, "assertThreadFilesAvailable")
    .mockImplementation(async () => {
      if (!available)
        throw new Error("Temporary files are unavailable; fetch them again");
    });
  const recover = vi.spyOn(backend, "recoverRun").mockResolvedValue();
  const stage = vi.spyOn(backend, "stageInputs").mockResolvedValue();
  const cleanup = vi.spyOn(backend, "cleanupThreadFiles").mockResolvedValue();
  vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
  vi.spyOn(backend, "streamOutput").mockImplementation(
    async ({ destination }) => {
      destination.end("Recovered answer");
    },
  );
  vi.spyOn(backend, "snapshotOutput").mockImplementation(
    async ({ destination }) => {
      destination.end("Recovered answer");
    },
  );
  vi.spyOn(backend, "waitForCompletion").mockResolvedValue({
    outcome: "succeeded",
  });
  vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);
  vi.spyOn(backend, "releaseRun").mockResolvedValue();
  if (available) {
    expect((await resumeAgentRun({ session })).text).toBe("Recovered answer");
    expect(recover).toHaveBeenCalledTimes(1);
  } else {
    await expect(resumeAgentRun({ session })).rejects.toThrow(
      "Temporary files are unavailable",
    );
    expect(recover).not.toHaveBeenCalled();
  }
  expect(availability).toHaveBeenCalledTimes(1);
  expect(stage).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect((await AgentRunModel.findByTaskId(task.id))?.endedAt).not.toBeNull();
});

describe("extractFinalAnswer", () => {
  test("returns the whole transcript when no runtime fenced an answer", () => {
    // Every one-shot runtime, and any image predating the fence.
    expect(extractFinalAnswer("the whole answer\n")).toBe("the whole answer\n");
  });

  test("keeps only what the runtime fenced, dropping the TUI recording", () => {
    const transcript = [
      "\u001b[2J\u001b[H╭─ Claude Code ─╮",
      "│ working...    │",
      "",
      "===ARCHESTRA-FINAL-ANSWER===",
      "Fixed the divider and opened PR #7.",
    ].join("\n");
    expect(extractFinalAnswer(transcript)).toBe(
      "Fixed the divider and opened PR #7.",
    );
  });

  test("takes the last fence when a TUI scrolled an earlier one back", () => {
    const transcript =
      "===ARCHESTRA-FINAL-ANSWER===\nstale redraw\n===ARCHESTRA-FINAL-ANSWER===\nthe real answer";
    expect(extractFinalAnswer(transcript)).toBe("the real answer");
  });

  test("stops at the end fence before the preserved final TUI frame", () => {
    const transcript = [
      "===ARCHESTRA-FINAL-ANSWER===",
      "the durable answer",
      "===ARCHESTRA-FINAL-ANSWER-END===",
      "\u001b[2J\u001b[H╭─ Codex ─╮",
      "│ completed │",
    ].join("\n");
    expect(extractFinalAnswer(transcript)).toBe("the durable answer\n");
  });

  test("falls back to the transcript when the fence has nothing after it", () => {
    // The runtime died mid-write; a partial recording beats an empty answer.
    const transcript = "some output\n===ARCHESTRA-FINAL-ANSWER===\n";
    expect(extractFinalAnswer(transcript)).toBe(transcript);
  });
});
