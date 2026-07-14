import type { UIMessage } from "@ai-sdk/react";
import {
  getArchestraToolShortName,
  SUBAGENT_TOOL_CALL_PART_TYPE,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  collectBrowserToolCallIds,
  collectSubagentToolCalls,
  deriveAppsFromMessages,
  extractFileAttachments,
  extractOwnedAppRender,
  filterOptimisticToolCalls,
  hasTextPart,
  identifyCompactToolGroups,
  isBlankAssistantTextPart,
  isBlankReasoningPart,
  mcpToolLabel,
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

describe("mcpToolLabel", () => {
  it("shows the raw server and tool name from a prefixed name", () => {
    expect(mcpToolLabel("Archestra PM__show_board")).toBe(
      "Archestra PM / show_board",
    );
  });

  it("preserves the raw tool name's separators", () => {
    expect(mcpToolLabel("weather__get_forecast")).toBe(
      "weather / get_forecast",
    );
  });

  it("returns a bare tool name with no server prefix unchanged", () => {
    expect(mcpToolLabel("render_app")).toBe("render_app");
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
        label: "pm / show_board",
        uiResourceUri: "ui://pm/board",
        appId: null,
        mcpServerId: null,
        toolName: "pm__show_board",
        rawOutput: { _meta: { ui: { resourceUri: "ui://pm/board" } } },
        toolInput: null,
        version: null,
        createdAt: Date.parse("2026-05-29T18:13:52.000Z"),
      },
    ]);
  });

  it("captures the concrete install from _meta.ui.mcpServerId (server-scoped deep link)", () => {
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
            output: {
              _meta: {
                ui: { resourceUri: "ui://pm/board", mcpServerId: "srv-1" },
              },
            },
          },
        ],
      },
    ] as never;

    expect(deriveAppsFromMessages(messages, {}, getToolShortName)).toEqual([
      {
        toolCallId: "call_1",
        label: "pm / show_board",
        uiResourceUri: "ui://pm/board",
        appId: null,
        mcpServerId: "srv-1",
        toolName: "pm__show_board",
        rawOutput: {
          _meta: { ui: { resourceUri: "ui://pm/board", mcpServerId: "srv-1" } },
        },
        toolInput: null,
        version: null,
        createdAt: Date.parse("2026-05-29T18:13:52.000Z"),
      },
    ]);
  });

  it("carries the tool result as rawOutput so a panel render can seed its iframe", () => {
    const output = {
      _meta: { ui: { resourceUri: "ui://pm/board" } },
      structuredContent: { applicants: [{ id: 24 }] },
    };
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "pm__show_board",
            toolCallId: "call_1",
            state: "output-available",
            input: { limit: 5 },
            output,
          },
        ],
      },
    ] as never;

    const apps = deriveAppsFromMessages(messages, {}, getToolShortName);
    expect(apps[0].rawOutput).toEqual(output);
    expect(apps[0].toolInput).toEqual({ limit: 5 });
  });

  it("stores the run_tool-unwrapped target name so the server prefix matches inline", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-archestra__run_tool",
            toolCallId: "call_1",
            state: "output-available",
            input: { tool_name: "pm__show_board", tool_args: { limit: 5 } },
            output: { _meta: { ui: { resourceUri: "ui://pm/board" } } },
          },
        ],
      },
    ] as never;

    const apps = deriveAppsFromMessages(messages, {}, getToolShortName);
    expect(apps[0].toolName).toBe("pm__show_board");
    // toolInput seeds the target tool's args, not the run_tool wrapper.
    expect(apps[0].toolInput).toEqual({ limit: 5 });
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
        label: "pm / show_board",
        uiResourceUri: "ui://pm/board",
        appId: null,
        mcpServerId: null,
        toolName: "pm__show_board",
        // No result yet (early UI-start), so no seed; the pending input is kept.
        toolInput: {},
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
      label: "pm / show_board",
    });
  });

  it("routes an owned-app __open render (ui://archestra-app URI) app-bound via appId", () => {
    const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-simple_todo__open",
            toolCallId: "call_open",
            state: "output-available",
            output: {
              _meta: { ui: { resourceUri: `ui://archestra-app/${APP_ID}` } },
            },
          },
        ],
      },
    ] as never;

    const apps = deriveAppsFromMessages(messages, {}, getToolShortName);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      toolCallId: "call_open",
      appId: APP_ID,
      uiResourceUri: `ui://archestra-app/${APP_ID}`,
    });
  });

  it("keeps a non-Archestra MCP-UI render un-app-bound (appId null)", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-excalidraw__draw",
            toolCallId: "call_ext",
            state: "output-available",
            output: { _meta: { ui: { resourceUri: "ui://excalidraw" } } },
          },
        ],
      },
    ] as never;

    const apps = deriveAppsFromMessages(messages, {}, getToolShortName);
    expect(apps[0]).toMatchObject({ toolCallId: "call_ext", appId: null });
  });

  it("returns an app labeled with the app name for an owned-app edit_app result", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-archestra__edit_app",
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
        uiResourceUri:
          "ui://archestra-app/947051c7-ea8e-48ed-8077-a3cc904d9d61",
        appId: "947051c7-ea8e-48ed-8077-a3cc904d9d61",
        toolName: "archestra__edit_app",
        version: 1,
        createdAt: 0,
      },
    ]);
  });

  it("keeps every owned-app render as its own entry (newest last), not deduped", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { createdAt: "2026-05-29T18:00:00.000Z" },
        parts: [
          {
            type: "tool-archestra__edit_app",
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

    const apps = deriveAppsFromMessages(messages, {}, getToolShortName);
    expect(apps.map((a) => a.toolCallId)).toEqual(["call_v1", "call_v3"]);
    expect(apps.map((a) => a.version)).toEqual([1, 3]);
  });

  it("keeps distinct owned apps as separate entries", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-archestra__edit_app",
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
            type: "tool-archestra__edit_app",
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

  it("ignores a foreign server's edit_app result", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-other__edit_app",
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

  it("keeps every external render of the same resourceUri as its own entry", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { createdAt: "2026-05-29T18:00:00.000Z" },
        parts: [
          {
            type: "tool-pm__show_board",
            toolCallId: "call_1",
            state: "output-available",
            output: { _meta: { ui: { resourceUri: "ui://pm/board" } } },
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        metadata: { createdAt: "2026-05-29T18:05:00.000Z" },
        parts: [
          {
            type: "tool-pm__show_board",
            toolCallId: "call_2",
            state: "output-available",
            output: { _meta: { ui: { resourceUri: "ui://pm/board" } } },
          },
        ],
      },
    ] as never;

    expect(deriveAppsFromMessages(messages, {}, getToolShortName)).toEqual([
      {
        toolCallId: "call_1",
        label: "pm / show_board",
        uiResourceUri: "ui://pm/board",
        appId: null,
        mcpServerId: null,
        toolName: "pm__show_board",
        rawOutput: { _meta: { ui: { resourceUri: "ui://pm/board" } } },
        toolInput: null,
        version: null,
        createdAt: Date.parse("2026-05-29T18:00:00.000Z"),
      },
      {
        toolCallId: "call_2",
        label: "pm / show_board",
        uiResourceUri: "ui://pm/board",
        appId: null,
        mcpServerId: null,
        toolName: "pm__show_board",
        rawOutput: { _meta: { ui: { resourceUri: "ui://pm/board" } } },
        toolInput: null,
        version: null,
        createdAt: Date.parse("2026-05-29T18:05:00.000Z"),
      },
    ]);
  });

  it("keeps non-owned renders with distinct resourceUris as separate entries", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-pm__show_board",
            toolCallId: "call_a",
            state: "output-available",
            output: { _meta: { ui: { resourceUri: "ui://pm/board-a" } } },
          },
          {
            type: "tool-pm__show_board",
            toolCallId: "call_b",
            state: "output-available",
            output: { _meta: { ui: { resourceUri: "ui://pm/board-b" } } },
          },
        ],
      },
    ] as never;

    const apps = deriveAppsFromMessages(messages, {}, getToolShortName);
    expect(apps.map((a) => a.toolCallId)).toEqual(["call_a", "call_b"]);
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
    "edit_app",
    "render_app",
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
    ["foreign server prefix", "other__edit_app", output],
    // scaffold_app seeds the boilerplate template — it is not a rendering tool,
    // so the chat never mounts a canvas for it (only the first edit_app does).
    ["non-rendering scaffold tool", "archestra__scaffold_app", output],
    ["non-rendering app tool", "archestra__list_apps", output],
    ["non-rendering delete tool", "archestra__delete_app", output],
    ["non-rendering read tool", "archestra__read_app", output],
    [
      "non-UUID id",
      "archestra__edit_app",
      { structuredContent: { id: "not-a-uuid" } },
    ],
    ["missing structuredContent", "archestra__edit_app", { content: "ok" }],
    ["plain string output", "archestra__edit_app", "Created app"],
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

  it("compacts a delegation call with surfaced subagent children alongside its siblings", () => {
    const parts = [
      {
        type: "tool-google__search",
        toolCallId: "call_1",
        state: "input-available",
        input: {},
      },
      {
        type: "tool-google__search",
        toolCallId: "call_1",
        state: "output-available",
        output: "ok",
      },
      {
        type: "tool-agent__child",
        toolCallId: "call_p",
        state: "input-available",
        input: {},
      },
      {
        type: "tool-agent__child",
        toolCallId: "call_p",
        state: "output-available",
        output: "done",
      },
      {
        type: "tool-google__maps",
        toolCallId: "call_2",
        state: "input-available",
        input: {},
      },
      {
        type: "tool-google__maps",
        toolCallId: "call_2",
        state: "output-available",
        output: "map",
      },
    ] as UIMessage["parts"];

    const { groupMap, consumedIndices } = identifyCompactToolGroups(parts, {
      getToolShortName: () => null,
    });

    expect(groupMap.size).toBe(1);
    expect(groupMap.get(0)?.entries).toHaveLength(3);
    expect(consumedIndices.has(2)).toBe(true);
    expect(consumedIndices.has(3)).toBe(true);
  });

  it("groups consecutive MCP-app renders and regular tools into one row", () => {
    const parts = [
      {
        type: "tool-slack__post_message",
        toolCallId: "call_app1",
        state: "output-available",
        input: {},
        output: {
          content: "ok",
          _meta: { ui: { resourceUri: "ui://slack/compose" } },
        },
      },
      {
        type: "tool-calendar__create_event",
        toolCallId: "call_app2",
        state: "output-available",
        input: {},
        output: {
          content: "ok",
          _meta: { ui: { resourceUri: "ui://calendar/event" } },
        },
      },
      {
        type: "tool-google__search",
        toolCallId: "call_3",
        state: "output-available",
        input: { q: "weather" },
        output: "sunny",
      },
    ] as UIMessage["parts"];

    const { groupMap, consumedIndices } = identifyCompactToolGroups(parts, {
      getToolShortName: () => null,
    });

    // One row: app pill, app pill, tool circle — not three separate blocks.
    expect(groupMap.size).toBe(1);
    expect(groupMap.get(0)?.entries.map((entry) => entry.kind)).toEqual([
      "app",
      "app",
      "tool",
    ]);
    expect(consumedIndices).toEqual(new Set([0, 1, 2]));
  });

  it("classifies an owned-app management call as an app entry even while pending", () => {
    const parts = [
      {
        type: "tool-archestra__edit_app",
        toolCallId: "call_edit",
        state: "input-streaming",
        input: {},
      },
    ] as UIMessage["parts"];

    const { groupMap } = identifyCompactToolGroups(parts, {
      getToolShortName: (toolName) =>
        toolName === "archestra__edit_app" ? "edit_app" : null,
    });

    expect(groupMap.get(0)?.entries.map((entry) => entry.kind)).toEqual([
      "app",
    ]);
  });

  it("keeps a failed app render out of the row so it renders the full card", () => {
    const parts = [
      {
        type: "tool-slack__post_message",
        toolCallId: "call_app1",
        state: "output-error",
        input: {},
        errorText: "boom",
        output: {
          content: "boom",
          _meta: { ui: { resourceUri: "ui://slack/compose" } },
        },
      },
    ] as unknown as UIMessage["parts"];

    const { groupMap, consumedIndices } = identifyCompactToolGroups(parts, {
      getToolShortName: () => null,
    });

    expect(groupMap.size).toBe(0);
    expect(consumedIndices.size).toBe(0);
  });
});

describe("collectSubagentToolCalls", () => {
  const subagentPart = (
    parentToolCallId: string,
    toolCallId: string,
    toolName = "web_search",
  ) =>
    ({
      type: SUBAGENT_TOOL_CALL_PART_TYPE,
      data: {
        parentToolCallId,
        toolCallId,
        toolName,
        state: "output-available",
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal part stub
    }) as any;

  const message = (parts: unknown[]): UIMessage =>
    ({ id: "m", role: "assistant", parts }) as UIMessage;

  it("returns an empty map when no subagent parts exist", () => {
    const map = collectSubagentToolCalls([
      message([{ type: "text", text: "hi" }]),
    ]);
    expect(map.size).toBe(0);
  });

  it("groups children by their parent delegation call and preserves the chain (P1->C1,C2; C2->G1)", () => {
    const map = collectSubagentToolCalls([
      message([
        { type: "tool-agent__child", toolCallId: "P1" },
        subagentPart("P1", "C1", "web_search"),
        subagentPart("P1", "C2", "agent__grandchild"),
        subagentPart("C2", "G1", "fetch"),
      ]),
    ]);

    expect(map.get("P1")?.map((e) => e.toolCallId)).toEqual(["C1", "C2"]);
    expect(map.get("C2")?.map((e) => e.toolCallId)).toEqual(["G1"]);
    // The nested delegation C2 is both a child of P1 and a parent of G1.
    expect(map.has("C2")).toBe(true);
    expect(map.get("P1")?.[0]).toMatchObject({
      toolCallId: "C1",
      toolName: "web_search",
      state: "output-available",
    });
  });

  it("collects across messages and dedupes a toolCallId present twice (live + persisted)", () => {
    const map = collectSubagentToolCalls([
      message([subagentPart("P1", "C1")]),
      message([subagentPart("P1", "C1")]),
    ]);
    expect(map.get("P1")?.length).toBe(1);
  });

  it("ignores malformed subagent parts (missing ids)", () => {
    const map = collectSubagentToolCalls([
      message([
        {
          type: SUBAGENT_TOOL_CALL_PART_TYPE,
          data: { toolName: "x" },
          // biome-ignore lint/suspicious/noExplicitAny: malformed stub
        } as any,
      ]),
    ]);
    expect(map.size).toBe(0);
  });

  it("carries input, output, and errorText onto the collected entry", () => {
    const richPart = {
      type: SUBAGENT_TOOL_CALL_PART_TYPE,
      data: {
        parentToolCallId: "P1",
        toolCallId: "C1",
        toolName: "fetch",
        input: { url: "x" },
        output: { status: 200 },
        errorText: "nope",
        state: "output-error",
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal part stub
    } as any;
    const map = collectSubagentToolCalls([message([richPart])]);
    expect(map.get("P1")?.[0]).toMatchObject({
      toolCallId: "C1",
      input: { url: "x" },
      output: { status: 200 },
      errorText: "nope",
      state: "output-error",
    });
  });

  it("skips a message that has no parts without throwing", () => {
    const map = collectSubagentToolCalls([
      { id: "m", role: "assistant" } as UIMessage,
    ]);
    expect(map.size).toBe(0);
  });
});

describe("isBlankAssistantTextPart", () => {
  const textPart = (text: string): UIMessage["parts"][number] => ({
    type: "text",
    text,
  });

  it.each([
    " ",
    "   ",
    "\n\n",
    "\t",
    "\n  \t ",
  ])("suppresses whitespace-only assistant text %j", (text) => {
    expect(isBlankAssistantTextPart(textPart(text), "assistant")).toBe(true);
  });

  it("suppresses an empty-string assistant text part", () => {
    expect(isBlankAssistantTextPart(textPart(""), "assistant")).toBe(true);
  });

  it("keeps assistant text that has real content", () => {
    expect(isBlankAssistantTextPart(textPart("  hello  "), "assistant")).toBe(
      false,
    );
  });

  it("never suppresses non-assistant (user) text, even when blank", () => {
    expect(isBlankAssistantTextPart(textPart("\n\n"), "user")).toBe(false);
  });

  it("ignores non-text parts", () => {
    expect(
      isBlankAssistantTextPart(
        { type: "step-start" } as UIMessage["parts"][number],
        "assistant",
      ),
    ).toBe(false);
  });
});

describe("isBlankReasoningPart", () => {
  const reasoningPart = (text?: string) => ({ type: "reasoning", text });

  it.each([
    "",
    " ",
    "   ",
    "\n\n",
    "\t",
    "\n  \t ",
  ])("suppresses a reasoning part with no readable text %j", (text) => {
    expect(isBlankReasoningPart(reasoningPart(text))).toBe(true);
  });

  it("suppresses a reasoning part with undefined text (redacted thinking)", () => {
    expect(isBlankReasoningPart(reasoningPart(undefined))).toBe(true);
  });

  it("keeps a reasoning part that has real content", () => {
    expect(isBlankReasoningPart(reasoningPart("  because X  "))).toBe(false);
  });

  it("ignores non-reasoning parts", () => {
    expect(isBlankReasoningPart({ type: "text", text: "" })).toBe(false);
  });
});
