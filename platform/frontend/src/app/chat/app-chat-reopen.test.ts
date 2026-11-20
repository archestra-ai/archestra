import { describe, expect, it } from "vitest";
import type { PanelApp } from "@/components/chat/apps-context";
import { appToReopenAsEncryptedChat } from "./app-chat-reopen";

const appChat = { origin: "app_open", encryptedChat: false };
const seededRender = [{ role: "assistant" }, { role: "assistant" }];

const ownedApp: PanelApp = {
  toolCallId: "call-1",
  label: "Budget",
  uiResourceUri: "ui://archestra-app/0b1d6a3e-2c43-4c38-9d33-6f1b8b0f5a11",
  appId: "0b1d6a3e-2c43-4c38-9d33-6f1b8b0f5a11",
  createdAt: 1,
};

const externalApp: PanelApp = {
  toolCallId: "call-2",
  label: "Excalidraw",
  uiResourceUri: "ui://excalidraw/canvas",
  appId: null,
  mcpServerId: "5f0c2a1e-8d7b-4e6a-9c3f-1a2b3c4d5e6f",
  createdAt: 1,
};

describe("appToReopenAsEncryptedChat", () => {
  it("reopens an owned app chat nobody has written in", () => {
    expect(
      appToReopenAsEncryptedChat({
        conversation: appChat,
        messages: seededRender,
        apps: [ownedApp],
      }),
    ).toEqual({ source: "owned", id: ownedApp.appId });
  });

  it("reopens an external app against the same install and resource", () => {
    expect(
      appToReopenAsEncryptedChat({
        conversation: appChat,
        messages: seededRender,
        apps: [externalApp],
      }),
    ).toEqual({
      source: "external",
      mcpServerId: externalApp.mcpServerId,
      resourceUri: externalApp.uiResourceUri,
      name: externalApp.label,
    });
  });

  it("keeps a chat the user has written in", () => {
    expect(
      appToReopenAsEncryptedChat({
        conversation: appChat,
        messages: [...seededRender, { role: "user" }],
        apps: [ownedApp],
      }),
    ).toBeNull();
  });

  it("does not offer it for a chat that is already encrypted", () => {
    expect(
      appToReopenAsEncryptedChat({
        conversation: { origin: "app_open", encryptedChat: true },
        messages: seededRender,
        apps: [ownedApp],
      }),
    ).toBeNull();
  });

  it("does not offer it for an ordinary chat that rendered an app", () => {
    expect(
      appToReopenAsEncryptedChat({
        conversation: { origin: "user", encryptedChat: false },
        messages: seededRender,
        apps: [ownedApp],
      }),
    ).toBeNull();
  });

  it("does not offer it before the app render has loaded", () => {
    expect(
      appToReopenAsEncryptedChat({
        conversation: appChat,
        messages: [],
        apps: [],
      }),
    ).toBeNull();
  });
});
