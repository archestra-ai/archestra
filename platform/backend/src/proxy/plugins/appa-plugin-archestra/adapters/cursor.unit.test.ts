import { describe, expect, test } from "vitest";
import { AppaCursorAdapter } from "./cursor";

const adapter = new AppaCursorAdapter();
const cursorHeaders = { "user-agent": "Cursor/2.3" };

describe("Cursor client match", () => {
  test.each([
    "Cursor/1.0",
    "Cursor/2.3",
    "cursor/3.9",
  ])("matches Cursor's User-Agent %s", (userAgent) => {
    expect(
      adapter.matches({
        headers: { "user-agent": userAgent },
        requestBody: {},
      }),
    ).toBe(true);
  });

  test.each([
    { "user-agent": "OpenAI/Python 1.0" },
    { "user-agent": "cursor-agent-bridge/1.0" },
    { "user-agent": "Mozilla/5.0 Cursor/2.3" },
    { "x-archestra-agent-id": "cursor" },
    {},
  ])("does not match another client: %j", (headers) => {
    expect(adapter.matches({ headers, requestBody: {} })).toBe(false);
  });
});

describe("Cursor session identity", () => {
  const identity = (requestBody: unknown) =>
    adapter.extractSessionIdentity({ headers: cursorHeaders, requestBody });
  const chat = (opening: string, extra: Record<string, unknown> = {}) => ({
    model: "gpt-6",
    user: "ff9d1da0167751c3",
    messages: [
      { role: "system", content: "You are Cursor. Time: 10:01" },
      { role: "user", content: opening },
    ],
    ...extra,
  });

  test("names a chat by its opening, under its own provenance", () => {
    expect(identity(chat("Fix the login bug"))).toEqual({
      sessionId: expect.stringMatching(/^cursor-chat-[A-Za-z0-9_-]{32}$/),
      provenance: "cursor-opening",
    });
  });

  test("a retry and a later turn before any tool call stay on the same chat", () => {
    const first = identity(chat("Fix the login bug"));
    // Cursor rebuilds the system prompt, and other fields, per request.
    const retry = identity({
      ...chat("Fix  the login\nbug"),
      messages: [
        { role: "system", content: "You are Cursor. Time: 10:02" },
        {
          role: "user",
          content: [{ type: "text", text: "Fix  the login\nbug" }],
        },
      ],
    });
    const later = identity({
      ...chat("Fix the login bug"),
      messages: [
        ...chat("Fix the login bug").messages,
        { role: "assistant", content: "Which file?" },
        { role: "user", content: "auth.ts" },
      ],
    });
    expect(retry).toEqual(first);
    expect(later).toEqual(first);
  });

  test("chats that open alike part ways once each has made a tool call", () => {
    const afterCall = (id: string, more: unknown[] = []) =>
      identity({
        ...chat("Fix the login bug"),
        messages: [
          ...chat("Fix the login bug").messages,
          {
            role: "assistant",
            content: [],
            tool_calls: [{ id, function: { name: "Read", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: id, content: "# README" },
          ...more,
        ],
      });
    const shared = identity(chat("Fix the login bug"));
    const one = afterCall("call_a");
    const two = afterCall("call_b");
    expect(one?.sessionId).toMatch(/^cursor-chat-/);
    expect(one?.provenance).toBe("cursor-opening");
    expect(one?.sessionId).not.toBe(shared?.sessionId);
    expect(two?.sessionId).not.toBe(shared?.sessionId);
    expect(one?.sessionId).not.toBe(two?.sessionId);

    // The chat keeps its name through its later calls.
    expect(
      afterCall("call_a", [
        {
          role: "assistant",
          content: [],
          tool_calls: [{ id: "call_c", function: { name: "Read" } }],
        },
        { role: "tool", tool_call_id: "call_c", content: "more" },
      ]),
    ).toEqual(one);

    // A claim on the conversation holds through that change.
    const conversation = (requestBody: unknown) =>
      adapter.conversationClaimId({ headers: cursorHeaders, requestBody });
    expect(conversation(chat("Fix the login bug"))).toBe(shared?.sessionId);
    expect(
      conversation({
        ...chat("Fix the login bug"),
        messages: [
          ...chat("Fix the login bug").messages,
          {
            role: "assistant",
            content: [],
            tool_calls: [{ id: "call_a", function: { name: "Read" } }],
          },
        ],
      }),
    ).toBe(shared?.sessionId);

    // The Responses wire carries a call as an item of its own.
    expect(
      identity({
        model: "gpt-6",
        input: [
          { role: "user", content: "Fix the login bug" },
          { type: "function_call", call_id: "call_a", name: "Read" },
        ],
      }),
    ).toEqual(one);
  });

  test("reads the opening on the Responses wire the same way", () => {
    expect(
      identity({
        model: "gpt-6",
        input: [{ role: "user", content: "Fix the login bug" }],
      }),
    ).toEqual(identity(chat("Fix the login bug")));
    expect(identity({ model: "gpt-6", input: "Fix the login bug" })).toEqual(
      identity(chat("Fix the login bug")),
    );
  });

  test("a different or edited opening is a different chat", () => {
    expect(identity(chat("Fix the signup bug"))).not.toEqual(
      identity(chat("Fix the login bug")),
    );
  });

  test("never reads the device id or unverified body fields as a session", () => {
    const base = identity(chat("Fix the login bug"));
    expect(
      identity(
        chat("Fix the login bug", {
          user: "another-device",
          prompt_cache_key: "a",
          metadata: { session_id: "b" },
          conversation: "c",
        }),
      ),
    ).toEqual(base);
    expect(
      identity({ user: "ff9d1da0167751c3", messages: [] }),
    ).toBeUndefined();
    expect(
      identity({ messages: [{ role: "user", content: "  " }] }),
    ).toBeUndefined();
    expect(identity(undefined)).toBeUndefined();
  });

  test("skips the generic body fallbacks", () => {
    expect(adapter.genericSessionFallback).toBe(false);
  });
});

describe("Cursor tool identity", () => {
  test("keeps Cursor's own tools local", () => {
    for (const name of [
      "Read",
      "ApplyPatch",
      "Shell",
      "Grep",
      "Glob",
      "TodoWrite",
    ]) {
      expect(adapter.classifyToolName(name)).toBe("local");
      expect(adapter.normalizeLocalToolName(name)).toBe(name);
    }
  });

  test("recognizes MCP tool spellings as gateway tools", () => {
    for (const name of [
      "mcp_archestra_archestra__get_remedy_plans",
      "mcp__archestra__archestra__ask_user",
      "archestra__ask_user",
      "github__create_issue",
    ]) {
      expect(adapter.classifyToolName(name)).toBe("gateway");
    }
    expect(adapter.classifyToolName("Read", "mcp__files")).toBe("gateway");
  });

  test("starts no delegated child and binds no child trajectory", () => {
    expect(adapter.isSpawnTool("Task")).toBe(false);
    expect(adapter.bindChildTrajectory()).toBeUndefined();
  });

  test("tells the user where to fix the gateway in Cursor", () => {
    expect(adapter.gatewayToolsHint("archestra")).toContain(
      "turn on archestra",
    );
  });
});
