import { describe, expect, it } from "vitest";
import { RuntimeAgentConfigError, readConfig } from "./config.js";

const COMPLETE = {
  ARCHESTRA_AGENT_RUNTIME_AGENT_ID: "agent-1",
  ARCHESTRA_AGENT_RUNTIME_TASK_ID: "task-1",
  ARCHESTRA_LLM_PROXY_URL: "http://archestra:9000/v1/model-router/agent-1",
  ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
  ARCHESTRA_VIRTUAL_KEY: "arch_key",
  ARCHESTRA_MCP_GATEWAY_URL: "http://archestra:9000/v1/mcp/agent-1",
  ARCHESTRA_MCP_GATEWAY_TOKEN: "arch_token",
};

describe("readConfig", () => {
  it("names the variable that is missing", () => {
    // A pod started wrong should say which value it lacked; anything vaguer
    // turns a one-line fix into an investigation.
    const { ARCHESTRA_VIRTUAL_KEY: _omitted, ...incomplete } = COMPLETE;
    expect(() => readConfig(incomplete)).toThrow(RuntimeAgentConfigError);
    expect(() => readConfig(incomplete)).toThrow(/ARCHESTRA_VIRTUAL_KEY/);
  });

  it("rejects an unknown proxy protocol instead of choosing the wrong wire format", () => {
    expect(() =>
      readConfig({
        ...COMPLETE,
        ARCHESTRA_LLM_PROXY_PROTOCOL: "custom",
      }),
    ).toThrow(/must be openai_responses, openai_chat, or anthropic/);
  });

  it("strips trailing slashes so URLs concatenate predictably", () => {
    const config = readConfig({
      ...COMPLETE,
      ARCHESTRA_LLM_PROXY_URL: "http://archestra:9000/v1/anthropic/agent-1///",
    });
    expect(config.proxyBaseUrl).toBe(
      "http://archestra:9000/v1/anthropic/agent-1",
    );
  });

  it("treats a blank task as no task rather than an empty instruction", () => {
    expect(
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_TASK: "   ",
      }).task,
    ).toBeNull();
  });

  it("carries the Agent system prompt into Agent Runtime", () => {
    expect(
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT:
          "Complete coding tasks with the available tools.",
      }).systemPrompt,
    ).toBe("Complete coding tasks with the available tools.");
    expect(readConfig(COMPLETE).systemPrompt).toBeNull();
  });

  it("falls back on a non-numeric step cap instead of disabling the limit", () => {
    expect(
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_MAX_STEPS: "lots",
      }).maxSteps,
    ).toBe(500);
    expect(
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_MAX_STEPS: "0",
      }).maxSteps,
    ).toBe(500);
    expect(
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_MAX_STEPS: "25",
      }).maxSteps,
    ).toBe(25);
  });

  it("parses the idle timeout while allowing an indefinite wait", () => {
    expect(readConfig(COMPLETE).idleTimeoutMs).toBeNull();
    expect(
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_IDLE_TIMEOUT_SECONDS: "15",
      }).idleTimeoutMs,
    ).toBe(15_000);
    expect(
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_IDLE_TIMEOUT_SECONDS: "invalid",
      }).idleTimeoutMs,
    ).toBeNull();
  });

  it("defaults unattended work to one-shot and accepts interactive Chat terminals", () => {
    expect(readConfig(COMPLETE).runMode).toBe("one_shot");
    expect(
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
      }).runMode,
    ).toBe("interactive");
    expect(() =>
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_MODE: "forever-ish",
      }),
    ).toThrow(/must be interactive or one_shot/);
  });

  it("carries the platform-rendered terminal banner without inventing a brand", () => {
    expect(
      readConfig({
        ...COMPLETE,
        ARCHESTRA_AGENT_RUNTIME_BANNER: "Acme AI\nSecure tools",
      }).banner,
    ).toBe("Acme AI\nSecure tools");
    expect(readConfig(COMPLETE).banner).toBeNull();
  });
});
