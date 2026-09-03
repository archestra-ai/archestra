import config from "@/config";
import { afterEach, describe, expect, test } from "@/test";
import type { AgentRuntime } from "@/types";
import { extractFinalAnswer, resolveAgentRuntime } from "./pod-run";

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

  test("falls back to the transcript when the fence has nothing after it", () => {
    // The runtime died mid-write; a partial recording beats an empty answer.
    const transcript = "some output\n===ARCHESTRA-FINAL-ANSWER===\n";
    expect(extractFinalAnswer(transcript)).toBe(transcript);
  });
});
