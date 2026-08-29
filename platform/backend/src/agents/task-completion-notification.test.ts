import { describe, expect, test } from "vitest";
import { buildTaskCompletionNotification } from "./task-completion-notification";

describe("buildTaskCompletionNotification", () => {
  test("does not announce a PR URL before the background run is terminal", () => {
    expect(
      buildTaskCompletionNotification({
        state: "TASK_STATE_WORKING",
        statusReason: null,
        output:
          "[tool] archestra__run_tool\nDone: https://github.com/example/project/pull/42\n[waiting for direction]",
      }),
    ).toBeNull();
  });

  test("posts a concise PR update after the background run completes", () => {
    expect(
      buildTaskCompletionNotification({
        state: "TASK_STATE_COMPLETED",
        statusReason: null,
        output:
          "[tool] archestra__run_tool\nDone: https://github.com/example/project/pull/42\n[waiting for direction]",
      }),
    ).toBe("PR ready: https://github.com/example/project/pull/42");
  });

  test("does not narrate a working task before it has a useful result", () => {
    expect(
      buildTaskCompletionNotification({
        state: "TASK_STATE_WORKING",
        statusReason: null,
        output: "[tool] archestra__search_tools",
      }),
    ).toBeNull();
  });

  test("keeps terminal failures brief", () => {
    expect(
      buildTaskCompletionNotification({
        state: "TASK_STATE_FAILED",
        statusReason: "The deployment could not start.",
        output: "",
      }),
    ).toBe("Task failed. The deployment could not start.");
  });

  test("does not mistake a PR URL in failed-task output for success", () => {
    expect(
      buildTaskCompletionNotification({
        state: "TASK_STATE_FAILED",
        statusReason: "The coding agent exited before finishing.",
        output:
          "Review https://github.com/example/project/pull/42 and fix any issues.",
      }),
    ).toBe("Task failed. The coding agent exited before finishing.");
  });

  test("removes runtime boilerplate from a completed task", () => {
    expect(
      buildTaskCompletionNotification({
        state: "TASK_STATE_COMPLETED",
        statusReason: null,
        output: [
          "Background execution run for Coding Agent (agent-1)",
          "Model example-model via the proxy.",
          "4 tools available.",
          "Finished the requested work.",
          "[waiting for direction]",
        ].join("\n"),
      }),
    ).toBe("Finished the requested work.");
  });

  test("keeps native execution transcripts in the execution console", () => {
    expect(
      buildTaskCompletionNotification({
        state: "TASK_STATE_COMPLETED",
        statusReason: null,
        output:
          "Initializing agent...\n[tool output spanning many lines]\n[archestra] agent session exited",
      }),
    ).toBe("Task finished.");
  });
});
