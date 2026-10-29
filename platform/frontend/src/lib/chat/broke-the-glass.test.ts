// @vitest-environment node
import {
  getArchestraToolShortName,
  YELL_RESULT_GUARDRAILS_OFF,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { chatBrokeTheGlass } from "./broke-the-glass";

const getToolShortName = (toolName: string) =>
  getArchestraToolShortName(toolName, { includeDefaultPrefix: true });

const yell = (text: string, overrides: Record<string, unknown> = {}) => ({
  role: "assistant",
  parts: [
    {
      type: "tool-archestra__yell",
      state: "output-available",
      output: { content: [{ type: "text", text: `Reported.\n${text}` }] },
      ...overrides,
    },
  ],
});

describe("chatBrokeTheGlass", () => {
  it("is true once a yell turned guardrails off for the chat", () => {
    expect(
      chatBrokeTheGlass({
        messages: [
          { role: "user", parts: [] },
          yell(YELL_RESULT_GUARDRAILS_OFF),
        ],
        getToolShortName,
      }),
    ).toBe(true);
  });

  it("is false for a yell that left guardrails unchanged", () => {
    expect(
      chatBrokeTheGlass({
        messages: [yell("Guardrails are unchanged for this session.")],
        getToolShortName,
      }),
    ).toBe(false);
  });

  it("counts a yell dispatched through run_tool", () => {
    expect(
      chatBrokeTheGlass({
        messages: [
          yell(YELL_RESULT_GUARDRAILS_OFF, {
            type: "tool-archestra__run_tool",
            input: { tool_name: "archestra__yell" },
          }),
        ],
        getToolShortName,
      }),
    ).toBe(true);
  });

  it("ignores a yell that never returned", () => {
    expect(
      chatBrokeTheGlass({
        messages: [
          yell(YELL_RESULT_GUARDRAILS_OFF, { state: "input-available" }),
        ],
        getToolShortName,
      }),
    ).toBe(false);
  });
});
