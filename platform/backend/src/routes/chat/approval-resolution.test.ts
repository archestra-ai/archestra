// biome-ignore-all lint/suspicious/noExplicitAny: synthetic UIMessage shapes for unit tests
import { describe, expect, test } from "vitest";
import type { ChatMessage } from "@/types";
import { collectResolvedApprovalToolCallIds } from "./approval-resolution";

const message = (parts: Array<Record<string, unknown>>): ChatMessage =>
  ({
    id: "m1",
    role: "assistant",
    parts,
  }) as any;

describe("collectResolvedApprovalToolCallIds", () => {
  test("returns toolCallIds whose state is approval-responded", () => {
    const messages = [
      message([
        {
          type: "tool-x",
          state: "approval-responded",
          approval: { id: "a1", approved: true },
          toolCallId: "tc-1",
        },
      ]),
    ];
    expect(collectResolvedApprovalToolCallIds(messages)).toEqual(
      new Set(["tc-1"]),
    );
  });

  test("returns toolCallIds in output-available, output-error, output-denied states", () => {
    const messages = [
      message([
        {
          type: "tool-a",
          state: "output-available",
          approval: { id: "a1", approved: true },
          toolCallId: "tc-1",
        },
        {
          type: "tool-b",
          state: "output-error",
          approval: { id: "a2", approved: true },
          toolCallId: "tc-2",
          errorText: "boom",
        },
        {
          type: "tool-c",
          state: "output-denied",
          approval: { id: "a3", approved: false },
          toolCallId: "tc-3",
        },
      ]),
    ];
    expect(collectResolvedApprovalToolCallIds(messages)).toEqual(
      new Set(["tc-1", "tc-2", "tc-3"]),
    );
  });

  test("ignores approval-requested and non-approval states", () => {
    const messages = [
      message([
        {
          type: "tool-x",
          state: "approval-requested",
          approval: { id: "a1" },
          toolCallId: "tc-1",
        },
        { type: "tool-y", state: "input-available", toolCallId: "tc-2" },
      ]),
    ];
    expect(collectResolvedApprovalToolCallIds(messages)).toEqual(new Set());
  });

  test("ignores parts whose state is terminal but missing approval object (non-approval-flow tool calls)", () => {
    const messages = [
      message([
        { type: "tool-x", state: "output-available", toolCallId: "tc-1" },
      ]),
    ];
    expect(collectResolvedApprovalToolCallIds(messages)).toEqual(new Set());
  });
});
