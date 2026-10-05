import { describe, expect, test } from "vitest";
import { AppaClaudeCodeAdapter } from "./claude-code";

const ENFORCE =
  "[handback-send-enforce] Your report has not been delivered. Call SubagentHandback({message: <your full report>}) now; the call ends your run.";
const TASK =
  "Return only the marker string. Do not call any other tools.\n\nYour final report is delivered through SubagentHandback.";

const handbackTool = {
  name: "SubagentHandback",
  description: "Deliver the report",
  input_schema: { type: "object", properties: { message: { type: "string" } } },
};

describe("Claude Code native handback", () => {
  const adapter = new AppaClaudeCodeAdapter();

  test("binds an unnamed asynchronous agent receipt to its actual spawn call", () => {
    const request = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "spawn-1",
              name: "Agent",
              input: { prompt: "Read the sample" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "spawn-1",
              content: "Async agent launched successfully.\nagentId: worker-1",
            },
          ],
        },
      ],
    };
    expect(adapter.teammateLaunches(request).get("worker-1")).toEqual({
      childNativeId: "worker-1",
      spawnCallId: "spawn-1",
    });
    Object.assign(request.messages[0].content[0], { name: "Read" });
    expect(adapter.teammateLaunches(request).size).toBe(0);
  });

  test("requires the native handback only when the request declares it", () => {
    expect(adapter.requiresNativeChildHandback({ tools: [handbackTool] })).toBe(
      true,
    );
    expect(
      adapter.requiresNativeChildHandback({ tools: [{ name: "Read" }] }),
    ).toBe(false);
    expect(adapter.requiresNativeChildHandback({ messages: [ENFORCE] })).toBe(
      false,
    );
    expect(adapter.isChildHandbackTool("SubagentHandback")).toBe(true);
  });

  test("states the native transport rule without choosing a tool", () => {
    const guidance = adapter.nativeHandbackGuidance();

    expect(adapter.nativeHandbackGuidance()).toBe(guidance);
    expect(guidance).toContain("does not forbid");
    expect(guidance).toContain("parent return policy");
    expect(guidance).not.toContain("tool_choice");
    expect(guidance).not.toContain(ENFORCE);
    expect(guidance).not.toContain(TASK);
  });
});
