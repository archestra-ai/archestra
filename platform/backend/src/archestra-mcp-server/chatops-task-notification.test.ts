import { describe, expect, test } from "vitest";
import { buildChatOpsTaskNotification } from "./chatops-task-notification";

describe("buildChatOpsTaskNotification", () => {
  test("posts a concise PR update while a background run remains attachable", () => {
    expect(
      buildChatOpsTaskNotification({
        taskId: "task-1",
        state: "TASK_STATE_WORKING",
        statusReason: null,
        output:
          "[tool] archestra__run_tool\nDone: https://github.com/example/project/pull/42\n[waiting for direction]",
      }),
    ).toBe("🦀 PR ready: https://github.com/example/project/pull/42");
  });

  test("does not narrate a working task before it has a useful result", () => {
    expect(
      buildChatOpsTaskNotification({
        taskId: "task-1",
        state: "TASK_STATE_WORKING",
        statusReason: null,
        output: "[tool] archestra__search_tools",
      }),
    ).toBeNull();
  });

  test("keeps terminal failures brief", () => {
    expect(
      buildChatOpsTaskNotification({
        taskId: "task-1",
        state: "TASK_STATE_FAILED",
        statusReason: "The deployment could not start.",
        output: "",
      }),
    ).toBe("🦀 Task `task-1` failed. The deployment could not start.");
  });

  test("removes runtime boilerplate from a completed task", () => {
    expect(
      buildChatOpsTaskNotification({
        taskId: "task-1",
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
    ).toBe("🦀 Task `task-1` finished.\n\nFinished the requested work.");
  });
});
