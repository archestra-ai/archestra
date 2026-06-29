import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

const histogramObserve = vi.fn();
const counterInc = vi.fn();
const gaugeSet = vi.fn();
const gaugeReset = vi.fn();
const registerRemoveSingleMetric = vi.fn();

vi.mock("prom-client", () => {
  return {
    default: {
      Histogram: class {
        observe(...args: unknown[]) {
          return histogramObserve(...args);
        }
      },
      Counter: class {
        inc(...args: unknown[]) {
          return counterInc(...args);
        }
      },
      Gauge: class {
        set(...args: unknown[]) {
          return gaugeSet(...args);
        }
        reset() {
          return gaugeReset();
        }
      },
      register: {
        removeSingleMetric: (...args: unknown[]) =>
          registerRemoveSingleMetric(...args),
      },
    },
  };
});

import {
  initializeMcpMetrics,
  reportMcpDeploymentStatuses,
  reportMcpToolCall,
} from "./mcp";

describe("initializeMcpMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("skips reinitialization when label keys haven't changed", () => {
    initializeMcpMetrics(["environment", "team"]);
    registerRemoveSingleMetric.mockClear();

    initializeMcpMetrics(["environment", "team"]);

    expect(registerRemoveSingleMetric).not.toHaveBeenCalled();
  });

  test("reinitializes metrics when label keys are added", () => {
    initializeMcpMetrics(["environment"]);
    registerRemoveSingleMetric.mockClear();

    initializeMcpMetrics(["environment", "team"]);

    expect(registerRemoveSingleMetric).toHaveBeenCalledWith(
      "mcp_tool_call_duration_seconds",
    );
    expect(registerRemoveSingleMetric).toHaveBeenCalledWith(
      "mcp_tool_calls_total",
    );
  });

  test("doesn't reinit if keys are the same but in different order", () => {
    initializeMcpMetrics(["team", "environment"]);
    registerRemoveSingleMetric.mockClear();

    initializeMcpMetrics(["environment", "team"]);

    expect(registerRemoveSingleMetric).not.toHaveBeenCalled();
  });
});

describe("reportMcpToolCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeMcpMetrics([]);
  });

  test("reports successful tool call with duration", () => {
    reportMcpToolCall({
      agentId: "agent-1",
      agentName: "My Agent",
      agentType: "mcp_gateway",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 1.5,
      isError: false,
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        agent_id: "agent-1",
        agent_name: "My Agent",
        agent_type: "mcp_gateway",
        mcp_server_name: "github",
        tool_name: "github__list_repos",
        status: "success",
      },
      value: 1,
      exemplarLabels: expect.any(Object),
    });

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        agent_id: "agent-1",
        agent_name: "My Agent",
        agent_type: "mcp_gateway",
        mcp_server_name: "github",
        tool_name: "github__list_repos",
        status: "success",
      },
      value: 1.5,
      exemplarLabels: expect.any(Object),
    });
  });

  test("reports failed tool call", () => {
    reportMcpToolCall({
      agentId: "agent-1",
      agentName: "My Agent",
      agentType: "mcp_gateway",
      mcpServerName: "slack",
      toolName: "slack__send_message",
      durationSeconds: 0.3,
      isError: true,
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        agent_id: "agent-1",
        agent_name: "My Agent",
        agent_type: "mcp_gateway",
        mcp_server_name: "slack",
        tool_name: "slack__send_message",
        status: "error",
      },
      value: 1,
      exemplarLabels: expect.any(Object),
    });

    expect(histogramObserve).toHaveBeenCalledWith({
      labels: {
        agent_id: "agent-1",
        agent_name: "My Agent",
        agent_type: "mcp_gateway",
        mcp_server_name: "slack",
        tool_name: "slack__send_message",
        status: "error",
      },
      value: 0.3,
      exemplarLabels: expect.any(Object),
    });
  });

  test("skips duration observation for zero duration", () => {
    reportMcpToolCall({
      agentId: "agent-1",
      agentName: "My Agent",
      agentType: "mcp_gateway",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 0,
      isError: false,
    });

    expect(counterInc).toHaveBeenCalled();
    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("includes agent labels in metrics", () => {
    initializeMcpMetrics(["environment"]);

    reportMcpToolCall({
      agentId: "agent-1",
      agentName: "My Agent",
      agentType: "mcp_gateway",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 2.0,
      isError: false,
      agentLabels: [{ key: "environment", value: "production" }],
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        agent_id: "agent-1",
        agent_name: "My Agent",
        agent_type: "mcp_gateway",
        mcp_server_name: "github",
        tool_name: "github__list_repos",
        status: "success",
        environment: "production",
      },
      value: 1,
      exemplarLabels: expect.any(Object),
    });
  });

  test("sets empty string for missing agent labels", () => {
    initializeMcpMetrics(["environment", "team"]);

    reportMcpToolCall({
      agentId: "agent-1",
      agentName: "My Agent",
      agentType: "mcp_gateway",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 1.0,
      isError: false,
      agentLabels: [{ key: "environment", value: "staging" }],
    });

    expect(counterInc).toHaveBeenCalledWith({
      labels: {
        agent_id: "agent-1",
        agent_name: "My Agent",
        agent_type: "mcp_gateway",
        mcp_server_name: "github",
        tool_name: "github__list_repos",
        status: "success",
        environment: "staging",
        team: "",
      },
      value: 1,
      exemplarLabels: expect.any(Object),
    });
  });

  test("observes request and response size bytes", () => {
    reportMcpToolCall({
      agentId: "agent-1",
      agentName: "My Agent",
      agentType: "mcp_gateway",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 1.0,
      isError: false,
      requestSizeBytes: 256,
      responseSizeBytes: 4096,
    });

    const expectedLabels = {
      agent_id: "agent-1",
      agent_name: "My Agent",
      agent_type: "mcp_gateway",
      mcp_server_name: "github",
      tool_name: "github__list_repos",
      status: "success",
    };

    // duration (with exemplar) + request size + response size = 3 histogram observations
    expect(histogramObserve).toHaveBeenCalledTimes(3);
    expect(histogramObserve).toHaveBeenCalledWith({
      labels: expectedLabels,
      value: 1.0,
      exemplarLabels: expect.any(Object),
    });
    expect(histogramObserve).toHaveBeenCalledWith({
      labels: expectedLabels,
      value: 256,
      exemplarLabels: expect.any(Object),
    });
    expect(histogramObserve).toHaveBeenCalledWith({
      labels: expectedLabels,
      value: 4096,
      exemplarLabels: expect.any(Object),
    });
  });

  test("skips size observation when values are undefined", () => {
    reportMcpToolCall({
      agentId: "agent-1",
      agentName: "My Agent",
      agentType: "mcp_gateway",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 1.0,
      isError: false,
    });

    // Only duration histogram should be observed
    expect(histogramObserve).toHaveBeenCalledTimes(1);
  });

  test("skips size observation when values are zero", () => {
    reportMcpToolCall({
      agentId: "agent-1",
      agentName: "My Agent",
      agentType: "mcp_gateway",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 1.0,
      isError: false,
      requestSizeBytes: 0,
      responseSizeBytes: 0,
    });

    // Only duration histogram should be observed
    expect(histogramObserve).toHaveBeenCalledTimes(1);
  });
});

describe("reportMcpDeploymentStatuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("resets gauge and sets state=1 for active state, 0 for others", () => {
    reportMcpDeploymentStatuses({
      "server-1": { serverName: "github-server", state: "running" },
    });

    expect(gaugeReset).toHaveBeenCalledTimes(1);

    // Should set value=1 for running, 0 for all other states
    expect(gaugeSet).toHaveBeenCalledWith(
      { server_name: "github-server", state: "running" },
      1,
    );
    expect(gaugeSet).toHaveBeenCalledWith(
      { server_name: "github-server", state: "pending" },
      0,
    );
    expect(gaugeSet).toHaveBeenCalledWith(
      { server_name: "github-server", state: "failed" },
      0,
    );
    expect(gaugeSet).toHaveBeenCalledWith(
      { server_name: "github-server", state: "not_created" },
      0,
    );
    expect(gaugeSet).toHaveBeenCalledWith(
      { server_name: "github-server", state: "succeeded" },
      0,
    );
  });

  test("reports multiple servers with different states", () => {
    reportMcpDeploymentStatuses({
      "server-1": { serverName: "github-server", state: "running" },
      "server-2": { serverName: "slack-server", state: "failed" },
    });

    // 5 states per server * 2 servers = 10 calls
    expect(gaugeSet).toHaveBeenCalledTimes(10);

    expect(gaugeSet).toHaveBeenCalledWith(
      { server_name: "github-server", state: "running" },
      1,
    );
    expect(gaugeSet).toHaveBeenCalledWith(
      { server_name: "slack-server", state: "failed" },
      1,
    );
    expect(gaugeSet).toHaveBeenCalledWith(
      { server_name: "slack-server", state: "running" },
      0,
    );
  });

  test("handles empty statuses map", () => {
    reportMcpDeploymentStatuses({});

    expect(gaugeReset).toHaveBeenCalledTimes(1);
    expect(gaugeSet).not.toHaveBeenCalled();
  });
});
