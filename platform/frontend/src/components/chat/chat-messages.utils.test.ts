import type { UIMessage } from "@ai-sdk/react";
import { getArchestraToolShortName } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  collectBrowserToolCallIds,
  deriveAppsFromMessages,
  extractFileAttachments,
  extractOwnedAppRender,
  filterOptimisticToolCalls,
  hasTextPart,
  identifyCompactToolGroups,
} from "./chat-messages.utils";

const getToolShortName = (toolName: string) =>
  getArchestraToolShortName(toolName, { includeDefaultPrefix: true });

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

describe("collectBrowserToolCallIds", () => {
  it("collects Playwright browser tool calls from messages and optimistic calls", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-microsoft__playwright-mcp__browser_navigate",
            toolCallId: "call_1",
            state: "input-available",
            input: { url: "https://example.com" },
          },
          {
            type: "dynamic-tool",
            toolName: "github__search",
            toolCallId: "call_2",
            state: "input-available",
            input: { q: "example" },
          },
        ],
      },
    ] as never;

    expect(
      Array.from(
        collectBrowserToolCallIds({
          messages,
          optimisticToolCalls: [
            {
              toolCallId: "call_3",
              toolName: "browser_click",
              input: {},
            },
            {
              toolCallId: "call_4",
              toolName: "github__create_issue",
              input: {},
            },
          ],
        }),
      ),
    ).toEqual(["call_1", "call_3"]);
  });
});

describe("deriveAppsFromMessages", () => {
  it("returns an app for a tool call whose output carries _meta.ui.resourceUri", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { createdAt: "2026-05-29T18:13:52.000Z" },
        parts: [
          {
            type: "dynamic-tool",
            toolName: "pm__show_board",
            toolCallId: "call_1",
            state: "output-available",
            output: { _meta: { ui: { resourceUri: "ui://pm/board" } } },
          },
        ],
      },
    ] as never;

    expect(deriveAppsFromMessages(messages, {}, getToolShortName)).toEqual([
      {
        toolCallId: "call_1",
        label: "show_board",
        appId: null,
        version: null,
        createdAt: Date.parse("2026-05-29T18:13:52.000Z"),
      },
    ]);
  });

  it("returns an app from early UI-start data before the result arrives", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "pm__show_board",
            toolCallId: "call_1",
            state: "input-available",
            input: {},
          },
        ],
      },
    ] as never;

    expect(
      deriveAppsFromMessages(
        messages,
        {
          call_1: {
            uiResourceUri: "ui://pm/board",
            toolName: "pm__show_board",
          },
        },
        getToolShortName,
      ),
    ).toEqual([
      {
        toolCallId: "call_1",
        label: "show_board",
        appId: null,
        version: null,
        createdAt: 0,
      },
    ]);
  });

  it("ignores tool calls without a UI resource and de-dupes by toolCallId", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-google__search",
            toolCallId: "call_plain",
            state: "output-available",
            output: { content: "no ui here" },
          },
          {
            type: "tool-pm__show_board",
            toolCallId: "call_1",
            state: "input-available",
            input: {},
          },
          {
            type: "tool-pm__show_board",
            toolCallId: "call_1",
            state: "output-available",
            output: { _meta: { ui: { resourceUri: "ui://pm/board" } } },
          },
        ],
      },
    ] as never;

    const apps = deriveAppsFromMessages(messages, {}, getToolShortName);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      toolCallId: "call_1",
      label: "show_board",
    });
  });

  it("returns an app labeled with the app name for an owned-app scaffold_app result", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-archestra__scaffold_app",
            toolCallId: "call_app",
            state: "output-available",
            output: {
              content: "Created app",
              structuredContent: {
                id: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
                name: "To Do App",
                latestVersion: 1,
              },
            },
          },
        ],
      },
    ] as never;

    expect(deriveAppsFromMessages(messages, {}, getToolShortName)).toEqual([
      {
        toolCallId: "call_app",
        label: "To Do App",
        appId: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
        version: 1,
        createdAt: 0,
      },
    ]);
  });

  it("de-dupes owned-app renders by appId, keeping the latest render and version", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { createdAt: "2026-05-29T18:00:00.000Z" },
        parts: [
          {
            type: "tool-archestra__scaffold_app",
            toolCallId: "call_v1",
            state: "output-available",
            output: {
              structuredContent: {
                id: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
                name: "To Do App",
                latestVersion: 1,
              },
            },
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        metadata: { createdAt: "2026-05-29T18:05:00.000Z" },
        parts: [
          {
            type: "tool-archestra__edit_app",
            toolCallId: "call_v3",
            state: "output-available",
            output: {
              structuredContent: {
                id: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
                name: "To Do App",
                latestVersion: 3,
              },
            },
          },
        ],
      },
    ] as never;

    expect(deriveAppsFromMessages(messages, {}, getToolShortName)).toEqual([
      {
        toolCallId: "call_v3",
        label: "To Do App",
        appId: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
        version: 3,
        createdAt: Date.parse("2026-05-29T18:05:00.000Z"),
      },
    ]);
  });

  it("keeps distinct owned apps as separate entries", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-archestra__scaffold_app",
            toolCallId: "call_a",
            state: "output-available",
            output: {
              structuredContent: {
                id: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
                name: "App A",
                latestVersion: 1,
              },
            },
          },
          {
            type: "tool-archestra__scaffold_app",
            toolCallId: "call_b",
            state: "output-available",
            output: {
              structuredContent: {
                id: "11111111-ea8e-48ed-8077-a3cc904d9d61",
                name: "App B",
                latestVersion: 1,
              },
            },
          },
        ],
      },
    ] as never;

    const apps = deriveAppsFromMessages(messages, {}, getToolShortName);
    expect(apps.map((a) => a.toolCallId)).toEqual(["call_a", "call_b"]);
  });

  it("ignores a foreign server's scaffold_app result", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-other__scaffold_app",
            toolCallId: "call_foreign",
            state: "output-available",
            output: {
              structuredContent: {
                id: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
              },
            },
          },
        ],
      },
    ] as never;

    expect(deriveAppsFromMessages(messages, {}, getToolShortName)).toEqual([]);
  });
});

describe("extractOwnedAppRender", () => {
  const output = {
    structuredContent: {
      id: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
      name: "To Do App",
      latestVersion: 3,
    },
  };

  it.each([
    "scaffold_app",
    "edit_app",
    "render_app",
  ])("matches archestra__%s with a UUID structuredContent.id", (shortName) => {
    expect(
      extractOwnedAppRender({
        toolName: `archestra__${shortName}`,
        output,
        getToolShortName,
      }),
    ).toEqual({
      appId: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
      appName: "To Do App",
      latestVersion: 3,
    });
  });

  it.each([
    "scaffold_app",
    "edit_app",
  ])("matches a bare %s name (run_tool accepts bare archestra short names)", (shortName) => {
    expect(
      extractOwnedAppRender({
        toolName: shortName,
        output,
        getToolShortName,
      }),
    ).toEqual({
      appId: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
      appName: "To Do App",
      latestVersion: 3,
    });
  });

  it.each([
    ["foreign server prefix", "other__scaffold_app", output],
    ["non-rendering app tool", "archestra__list_apps", output],
    ["non-rendering delete tool", "archestra__delete_app", output],
    ["non-rendering read tool", "archestra__read_app", output],
    [
      "non-UUID id",
      "archestra__scaffold_app",
      { structuredContent: { id: "not-a-uuid" } },
    ],
    ["missing structuredContent", "archestra__scaffold_app", { content: "ok" }],
    ["plain string output", "archestra__scaffold_app", "Created app"],
  ])("returns null for %s", (_label, toolName, toolOutput) => {
    expect(
      extractOwnedAppRender({
        toolName,
        output: toolOutput,
        getToolShortName,
      }),
    ).toBeNull();
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
    expect(
      group?.entries.map((entry) =>
        entry.kind === "tool" ? entry.toolName : entry.kind,
      ),
    ).toEqual(["google__search", "google__maps"]);
  });

  it("includes hook-run parts in the row bracketing the tool they apply to", () => {
    const parts = [
      {
        type: "data-hook-run",
        data: {
          hookEventName: "PreToolUse",
          fileName: "guard.py",
          outcome: "proceeded",
          exitCode: 0,
        },
      },
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
        type: "data-hook-run",
        data: {
          hookEventName: "PostToolUse",
          fileName: "audit.py",
          outcome: "proceeded",
          exitCode: 0,
        },
      },
    ] as UIMessage["parts"];

    const { groupMap, consumedIndices } = identifyCompactToolGroups(parts, {
      getToolShortName: () => null,
    });
    const group = groupMap.get(0);

    expect(groupMap.size).toBe(1);
    expect(group?.entries.map((entry) => entry.kind)).toEqual([
      "hook",
      "tool",
      "hook",
    ]);
    expect(consumedIndices).toEqual(new Set([0, 1, 2, 3]));
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
