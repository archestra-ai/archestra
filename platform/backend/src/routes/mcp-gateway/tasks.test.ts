import { vi } from "vitest";
import logger from "@/logging";
import { McpGatewayTaskModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { runToolCallMaybeTask } from "./tasks";

vi.mock("@/logging");

/**
 * The detached continuation runs after the client already has its task handle,
 * so nothing awaits it. These pin the two ways that can go wrong: a write
 * failure must not be mistaken for the tool failing, and no rejection may
 * escape the chain (Node's default policy turns that into a process crash).
 */
describe("runToolCallMaybeTask - detached continuation", () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Detach immediately, then let the tool succeed a moment later. */
  async function detachSucceedingCall(agentId: string) {
    return runToolCallMaybeTask({
      eligible: true,
      agentId,
      principal: "user:continuation-test",
      toolName: "slow_tool",
      thresholdMs: 1,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { content: [{ type: "text", text: "done" }] };
      },
    });
  }

  test("a failed outcome write is logged, never recorded as a tool failure", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const completeSpy = vi
      .spyOn(McpGatewayTaskModel, "completeIfWorking")
      .mockRejectedValue(new Error("connection terminated unexpectedly"));
    const failSpy = vi.spyOn(McpGatewayTaskModel, "failIfWorking");

    const result = await detachSucceedingCall(agent.id);
    expect(result.resultType).toBe("task");

    await vi.waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1),
    );

    // The tool itself succeeded. Recording a failure here would tell the
    // client the opposite of what happened.
    expect(failSpy).not.toHaveBeenCalled();
  });

  test("no rejection escapes when every outcome write fails", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", collect);

    try {
      const completeSpy = vi
        .spyOn(McpGatewayTaskModel, "completeIfWorking")
        .mockRejectedValue(new Error("write failed"));
      vi.spyOn(McpGatewayTaskModel, "failIfWorking").mockRejectedValue(
        new Error("write failed"),
      );

      await detachSucceedingCall(agent.id);
      await vi.waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));

      // Give Node a turn to surface anything the chain let through.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", collect);
    }
  });
});
