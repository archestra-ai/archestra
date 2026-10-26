import { ApiError } from "@archestra/shared/types";
import { describe, expect, test } from "vitest";
import {
  agentRunFailure,
  classifyAgentRunFailure,
  tagAgentRunFailure,
} from "./run-failure";

describe("classifyAgentRunFailure", () => {
  test("uses the tag from the place that knew the cause", () => {
    const error = tagAgentRunFailure(
      new ApiError(504, "did not start in time"),
      "launch.capacity_timeout",
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(504);
    expect(error.message).toBe("did not start in time");
    expect(classifyAgentRunFailure(error)).toEqual({
      code: "launch.capacity_timeout",
      retriable: true,
    });
  });

  test("finds a tag on a wrapped cause", () => {
    const cause = tagAgentRunFailure(new Error("pod failed"), "pod.evicted");
    expect(classifyAgentRunFailure(new Error("outer", { cause }))).toEqual({
      code: "pod.evicted",
      retriable: true,
    });
  });

  test("prefers the outermost tag", () => {
    const cause = tagAgentRunFailure(new Error("inner"), "pod.failed");
    const outer = tagAgentRunFailure(
      new Error("outer", { cause }),
      "launch.kubernetes_unavailable",
    );
    expect(classifyAgentRunFailure(outer).code).toBe(
      "launch.kubernetes_unavailable",
    );
  });

  test.each([
    new ApiError(
      409,
      "A personal Claude subscription requires a run acting as a signed-in user.",
    ),
    new ApiError(400, "The configured model is not available"),
  ])("an untagged client error from the start path is launch.misconfigured: %s", (error) => {
    expect(classifyAgentRunFailure(error)).toEqual({
      code: "launch.misconfigured",
      retriable: false,
    });
  });

  test.each([
    new Error("publication connection lost"),
    new ApiError(502, "upstream"),
    "a thrown string",
    undefined,
  ])("anything else is run.unknown and not retriable: %s", (error) => {
    expect(classifyAgentRunFailure(error)).toEqual({
      code: "run.unknown",
      retriable: false,
    });
  });

  test("a cyclic cause chain terminates", () => {
    const error = new Error("loop");
    (error as { cause?: unknown }).cause = error;
    expect(classifyAgentRunFailure(error).code).toBe("run.unknown");
  });
});

test.each([
  ["launch.kubernetes_unavailable", true],
  ["launch.controller_missing", false],
  ["pod.oom_killed", false],
  ["pod.image_pull", false],
  ["budget.exceeded", false],
  ["run.settings_changed", false],
] as const)("%s retriable=%s", (code, retriable) => {
  expect(agentRunFailure(code)).toEqual({ code, retriable });
});
