import { describe, expect, it } from "vitest";
import { RunnerAgentConfigError, readConfig } from "./config.js";

const COMPLETE = {
  ARCHESTRA_RUNNER_ID: "runner-1",
  ARCHESTRA_LLM_PROXY_URL: "http://archestra:9000/v1/anthropic/agent-1",
  ANTHROPIC_API_KEY: "arch_key",
  ARCHESTRA_MCP_GATEWAY_URL: "http://archestra:9000/v1/mcp/agent-1",
  ARCHESTRA_MCP_GATEWAY_TOKEN: "arch_token",
};

describe("readConfig", () => {
  it("names the variable that is missing", () => {
    // A pod started wrong should say which value it lacked; anything vaguer
    // turns a one-line fix into an investigation.
    const { ANTHROPIC_API_KEY: _omitted, ...incomplete } = COMPLETE;
    expect(() => readConfig(incomplete)).toThrow(RunnerAgentConfigError);
    expect(() => readConfig(incomplete)).toThrow(/ANTHROPIC_API_KEY/);
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
      readConfig({ ...COMPLETE, ARCHESTRA_RUNNER_TASK: "   " }).task,
    ).toBeNull();
  });

  it("falls back on a non-numeric step cap instead of disabling the limit", () => {
    expect(
      readConfig({ ...COMPLETE, ARCHESTRA_RUNNER_MAX_STEPS: "lots" }).maxSteps,
    ).toBe(500);
    expect(
      readConfig({ ...COMPLETE, ARCHESTRA_RUNNER_MAX_STEPS: "0" }).maxSteps,
    ).toBe(500);
    expect(
      readConfig({ ...COMPLETE, ARCHESTRA_RUNNER_MAX_STEPS: "25" }).maxSteps,
    ).toBe(25);
  });
});
