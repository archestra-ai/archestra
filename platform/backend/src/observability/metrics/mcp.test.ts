import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

const histogramObserve = vi.fn();
const counterInc = vi.fn();
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
      register: {
        removeSingleMetric: (...args: unknown[]) =>
          registerRemoveSingleMetric(...args),
      },
    },
  };
});

import { initializeMcpMetrics, reportMcpToolCall } from "./mcp";

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
      profileName: "My Profile",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 1.5,
      isError: false,
    });

    expect(counterInc).toHaveBeenCalledWith({
      profile_name: "My Profile",
      mcp_server_name: "github",
      tool_name: "github__list_repos",
      status: "success",
    });

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        profile_name: "My Profile",
        mcp_server_name: "github",
        tool_name: "github__list_repos",
        status: "success",
      },
      1.5,
    );
  });

  test("reports failed tool call", () => {
    reportMcpToolCall({
      profileName: "My Profile",
      mcpServerName: "slack",
      toolName: "slack__send_message",
      durationSeconds: 0.3,
      isError: true,
    });

    expect(counterInc).toHaveBeenCalledWith({
      profile_name: "My Profile",
      mcp_server_name: "slack",
      tool_name: "slack__send_message",
      status: "error",
    });

    expect(histogramObserve).toHaveBeenCalledWith(
      {
        profile_name: "My Profile",
        mcp_server_name: "slack",
        tool_name: "slack__send_message",
        status: "error",
      },
      0.3,
    );
  });

  test("skips duration observation for zero duration", () => {
    reportMcpToolCall({
      profileName: "My Profile",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 0,
      isError: false,
    });

    expect(counterInc).toHaveBeenCalled();
    expect(histogramObserve).not.toHaveBeenCalled();
  });

  test("includes profile labels in metrics", () => {
    initializeMcpMetrics(["environment"]);

    reportMcpToolCall({
      profileName: "My Profile",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 2.0,
      isError: false,
      profileLabels: [{ key: "environment", value: "production" }],
    });

    expect(counterInc).toHaveBeenCalledWith({
      profile_name: "My Profile",
      mcp_server_name: "github",
      tool_name: "github__list_repos",
      status: "success",
      environment: "production",
    });
  });

  test("sets empty string for missing profile labels", () => {
    initializeMcpMetrics(["environment", "team"]);

    reportMcpToolCall({
      profileName: "My Profile",
      mcpServerName: "github",
      toolName: "github__list_repos",
      durationSeconds: 1.0,
      isError: false,
      profileLabels: [{ key: "environment", value: "staging" }],
    });

    expect(counterInc).toHaveBeenCalledWith({
      profile_name: "My Profile",
      mcp_server_name: "github",
      tool_name: "github__list_repos",
      status: "success",
      environment: "staging",
      team: "",
    });
  });
});
