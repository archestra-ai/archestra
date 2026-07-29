import { MCP_TASK_PART_TYPE, type McpTaskPartData } from "@archestra/shared";
import type { UIMessageChunk } from "ai";
import { vi } from "vitest";
import { createChatTaskBridge } from "@/clients/chat-task-bridge";
import { McpGatewayTaskModel } from "@/models";
import { describe, expect, test } from "@/test";

// The threshold derives from the one timeout knob: min(10s, timeout/2).
// 120ms ⇒ a 60ms threshold, so slow-vs-fast is deterministic.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    mcpGateway: { toolCallTimeoutMs: 120 },
  }),
);

describe("chat task bridge", () => {
  function bridgeWithWriter() {
    const chunks: McpTaskPartData[] = [];
    const bridge = createChatTaskBridge();
    bridge.setWriter({
      write: (chunk: UIMessageChunk) => {
        const typed = chunk as { type: string; data?: McpTaskPartData };
        if (typed.type === MCP_TASK_PART_TYPE && typed.data) {
          chunks.push(typed.data);
        }
      },
    });
    return { bridge, chunks };
  }

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test("a call that beats the threshold stays an ordinary tool call", async ({
    makeAgent,
    makeUser,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    const { bridge, chunks } = bridgeWithWriter();

    const result = await bridge.runMaybeTask({
      agentId: agent.id,
      userId: user.id,
      toolCallId: "call-1",
      toolName: "slow-lab__fast_ping",
      execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
    });

    expect(result).toEqual({ content: [{ type: "text", text: "pong" }] });
    // No card, and nothing durable to clean up.
    expect(chunks).toEqual([]);
    expect(bridge.collected()).toEqual([]);
  });

  test("a slow call detaches, streams its lifecycle, and still returns the tool's result", async ({
    makeAgent,
    makeUser,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    const { bridge, chunks } = bridgeWithWriter();

    const result = await bridge.runMaybeTask({
      agentId: agent.id,
      userId: user.id,
      toolCallId: "call-2",
      toolName: "slow-lab__slow_report",
      execute: async () => {
        await sleep(200);
        return { content: [{ type: "text", text: "report ready" }] };
      },
    });

    // The model sees exactly what the tool returned — a task is a UX and
    // durability layer, not a change to the tool's contract.
    expect(result).toEqual({
      content: [{ type: "text", text: "report ready" }],
    });

    expect(chunks.map((chunk) => chunk.status)).toEqual([
      "working",
      "completed",
    ]);
    expect(chunks[0]).toMatchObject({
      toolCallId: "call-2",
      toolName: "slow-lab__slow_report",
    });
    // One evolving card, not two entries.
    expect(bridge.collected()).toHaveLength(1);
  });

  test("a cancelled task comes back as a plain result, not an error or a throw", async ({
    makeAgent,
    makeUser,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    const { bridge, chunks } = bridgeWithWriter();

    const resultPromise = bridge.runMaybeTask({
      agentId: agent.id,
      userId: user.id,
      toolCallId: "call-3",
      toolName: "slow-lab__slow_report",
      execute: async (signal) => {
        await sleep(1000);
        if (signal.aborted) throw new Error("aborted");
        return { content: [{ type: "text", text: "never delivered" }] };
      },
    });

    // Wait for the card so we know the row exists, then cancel it.
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
    await McpGatewayTaskModel.cancelIfWorking(chunks[0].taskId);

    // The regression: throwing here aborts the whole chat run and paints a red
    // "unexpected error" panel over an answer the model already gave.
    const result = (await resultPromise) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    // The user asked for this, so it must not be styled as a tool failure.
    expect(result.isError).toBe(false);
    expect(result.content?.[0]?.text).toContain("cancelled");
    expect(chunks.at(-1)?.status).toBe("cancelled");
  });
});
