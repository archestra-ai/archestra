import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import {
  extractFileAttachments,
  filterOptimisticToolCalls,
  hasTextPart,
  identifyCompactToolGroups,
} from "./chat-messages.utils";

describe("extractFileAttachments", () => {
  it("should return undefined for undefined parts", () => {
    expect(extractFileAttachments(undefined)).toBeUndefined();
  });

  it("should return empty array for empty parts", () => {
    expect(extractFileAttachments([])).toEqual([]);
  });

  it("should return empty array when no file parts exist", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "Hello world" },
      { type: "reasoning", text: "Thinking..." },
    ];
    expect(extractFileAttachments(parts)).toEqual([]);
  });

  it("should extract single file attachment", () => {
    const parts: UIMessage["parts"] = [
      {
        type: "file",
        url: "blob:http://localhost/123",
        mediaType: "image/png",
        filename: "test.png",
      },
    ];

    expect(extractFileAttachments(parts)).toEqual([
      {
        url: "blob:http://localhost/123",
        mediaType: "image/png",
        filename: "test.png",
      },
    ]);
  });

  it("should extract multiple file attachments", () => {
    const parts: UIMessage["parts"] = [
      {
        type: "file",
        url: "blob:http://localhost/1",
        mediaType: "image/png",
        filename: "image1.png",
      },
      {
        type: "file",
        url: "blob:http://localhost/2",
        mediaType: "application/pdf",
        filename: "document.pdf",
      },
    ];

    expect(extractFileAttachments(parts)).toEqual([
      {
        url: "blob:http://localhost/1",
        mediaType: "image/png",
        filename: "image1.png",
      },
      {
        url: "blob:http://localhost/2",
        mediaType: "application/pdf",
        filename: "document.pdf",
      },
    ]);
  });

  it("should extract file attachments mixed with text parts", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "Here is a file" },
      {
        type: "file",
        url: "blob:http://localhost/123",
        mediaType: "image/jpeg",
        filename: "photo.jpg",
      },
    ];

    expect(extractFileAttachments(parts)).toEqual([
      {
        url: "blob:http://localhost/123",
        mediaType: "image/jpeg",
        filename: "photo.jpg",
      },
    ]);
  });

  it("should handle file parts without filename", () => {
    const parts: UIMessage["parts"] = [
      {
        type: "file",
        url: "blob:http://localhost/123",
        mediaType: "image/png",
      },
    ];

    expect(extractFileAttachments(parts)).toEqual([
      {
        url: "blob:http://localhost/123",
        mediaType: "image/png",
        filename: undefined,
      },
    ]);
  });
});

describe("hasTextPart", () => {
  it("should return false for undefined parts", () => {
    expect(hasTextPart(undefined)).toBe(false);
  });

  it("should return false for empty parts", () => {
    expect(hasTextPart([])).toBe(false);
  });

  it("should return true when text part exists", () => {
    const parts: UIMessage["parts"] = [{ type: "text", text: "Hello" }];
    expect(hasTextPart(parts)).toBe(true);
  });

  it("should return true when text part exists among other parts", () => {
    const parts: UIMessage["parts"] = [
      { type: "file", url: "blob:123", mediaType: "image/png" },
      { type: "text", text: "Hello" },
    ];
    expect(hasTextPart(parts)).toBe(true);
  });

  it("should return false when only file parts exist", () => {
    const parts: UIMessage["parts"] = [
      { type: "file", url: "blob:123", mediaType: "image/png" },
    ];
    expect(hasTextPart(parts)).toBe(false);
  });

  it("should return false when only reasoning parts exist", () => {
    const parts: UIMessage["parts"] = [
      { type: "reasoning", text: "Thinking..." },
    ];
    expect(hasTextPart(parts)).toBe(false);
  });
});

describe("filterOptimisticToolCalls", () => {
  it("keeps optimistic tool calls until a rendered part with the same toolCallId exists", () => {
    const optimisticToolCalls = [
      {
        toolCallId: "call_1",
        toolName: "google__search",
        input: { q: "weather" },
      },
      {
        toolCallId: "call_2",
        toolName: "google__maps",
        input: { location: "Toronto" },
      },
    ];

    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "google__search",
            toolCallId: "call_1",
            state: "input-available",
            input: { q: "weather" },
          },
        ],
      },
    ] as never;

    expect(filterOptimisticToolCalls(messages, optimisticToolCalls)).toEqual([
      optimisticToolCalls[1],
    ]);
  });
});

describe("identifyCompactToolGroups", () => {
  it("groups adjacent compact-eligible tool calls together", () => {
    const parts = [
      {
        type: "tool-google__search",
        toolCallId: "call_1",
        state: "input-available",
        input: { q: "weather" },
      },
      {
        type: "tool-google__search",
        toolCallId: "call_1",
        state: "output-available",
        output: "sunny",
      },
      {
        type: "tool-google__maps",
        toolCallId: "call_2",
        state: "input-available",
        input: { location: "Toronto" },
      },
      {
        type: "tool-google__maps",
        toolCallId: "call_2",
        state: "output-available",
        output: "map",
      },
    ] as UIMessage["parts"];

    const { groupMap } = identifyCompactToolGroups(parts, {
      getToolShortName: (toolName) => {
        if (toolName === "archestra__todo_write") {
          return "todo_write";
        }
        return null;
      },
    });
    const group = groupMap.get(0);

    expect(groupMap.size).toBe(1);
    expect(group?.entries).toHaveLength(2);
    expect(group?.entries.map((entry) => entry.toolName)).toEqual([
      "google__search",
      "google__maps",
    ]);
  });

  it("does not group across a non-compact-eligible tool call", () => {
    const parts = [
      {
        type: "tool-google__search",
        toolCallId: "call_1",
        state: "input-available",
        input: { q: "weather" },
      },
      {
        type: "tool-google__search",
        toolCallId: "call_1",
        state: "output-available",
        output: "sunny",
      },
      {
        type: "tool-archestra__todo_write",
        toolCallId: "call_2",
        state: "input-available",
        input: { todos: [] },
      },
      {
        type: "tool-archestra__todo_write",
        toolCallId: "call_2",
        state: "output-available",
        output: "ok",
      },
      {
        type: "tool-google__maps",
        toolCallId: "call_3",
        state: "input-available",
        input: { location: "Toronto" },
      },
      {
        type: "tool-google__maps",
        toolCallId: "call_3",
        state: "output-available",
        output: "map",
      },
    ] as UIMessage["parts"];

    const { groupMap } = identifyCompactToolGroups(parts, {
      getToolShortName: (toolName) => {
        if (toolName === "archestra__todo_write") {
          return "todo_write";
        }
        return null;
      },
    });

    expect(groupMap.size).toBe(2);
    expect(groupMap.get(0)?.entries).toHaveLength(1);
    expect(groupMap.get(4)?.entries).toHaveLength(1);
  });
});
