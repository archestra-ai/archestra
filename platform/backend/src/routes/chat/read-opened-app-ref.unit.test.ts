import type { ChatMessage } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { readOpenedAppRef } from "./read-opened-app-ref";

const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";
const MCP_SERVER_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

function userMessage(metadata?: unknown): ChatMessage {
  return {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function assistantMessage(metadata?: unknown): ChatMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "hello" }],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("readOpenedAppRef", () => {
  test("reads an owned app from the last user message", () => {
    // No reported display state on the message → null, not undefined.
    expect(
      readOpenedAppRef([userMessage({ openedApp: { appId: APP_ID } })]),
    ).toEqual({ appId: APP_ID, appMcpServerId: null, modelContext: null });
  });

  test("passes the app-reported display state through with an owned app", () => {
    expect(
      readOpenedAppRef([
        userMessage({
          openedApp: { appId: APP_ID, modelContext: "Viewing receipts.csv" },
        }),
      ]),
    ).toEqual({
      appId: APP_ID,
      appMcpServerId: null,
      modelContext: "Viewing receipts.csv",
    });
  });

  test("reads an external app from the last user message", () => {
    expect(
      readOpenedAppRef([
        userMessage({ openedApp: { appMcpServerId: MCP_SERVER_ID } }),
      ]),
    ).toEqual({
      appId: null,
      appMcpServerId: MCP_SERVER_ID,
      modelContext: null,
    });
  });

  test("drops a display state reported alongside an external app", () => {
    // The metadata schema's external variant has no modelContext field, so the
    // union parse strips it: the reference survives, the state does not.
    expect(
      readOpenedAppRef([
        userMessage({
          openedApp: {
            appMcpServerId: MCP_SERVER_ID,
            modelContext: "Viewing receipts.csv",
          },
        }),
      ]),
    ).toEqual({
      appId: null,
      appMcpServerId: MCP_SERVER_ID,
      modelContext: null,
    });
  });

  test("reads the latest user message, not an earlier one", () => {
    // The open app tracks the turn being sent, so an earlier report must not
    // shadow the current message's.
    expect(
      readOpenedAppRef([
        userMessage({ openedApp: { appId: APP_ID } }),
        assistantMessage(),
        userMessage({ openedApp: { appMcpServerId: MCP_SERVER_ID } }),
      ]),
    ).toEqual({
      appId: null,
      appMcpServerId: MCP_SERVER_ID,
      modelContext: null,
    });
  });

  test("ignores an open app reported on an assistant message", () => {
    expect(
      readOpenedAppRef([
        assistantMessage({ openedApp: { appId: APP_ID } }),
        userMessage(),
      ]),
    ).toBeUndefined();
  });

  test("returns undefined when no app is open", () => {
    expect(readOpenedAppRef([userMessage()])).toBeUndefined();
    expect(
      readOpenedAppRef([userMessage({ createdAt: "now" })]),
    ).toBeUndefined();
  });

  test("tolerates missing and malformed metadata", () => {
    expect(readOpenedAppRef([])).toBeUndefined();
    expect(
      readOpenedAppRef([userMessage({ openedApp: { appId: 42 } })]),
    ).toBeUndefined();
    expect(
      readOpenedAppRef([userMessage({ openedApp: "nonsense" })]),
    ).toBeUndefined();
  });
});
