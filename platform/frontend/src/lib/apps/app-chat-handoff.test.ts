import { describe, expect, it } from "vitest";
import { buildAppChatHandoffUrl } from "./app-chat-handoff";

describe("buildAppChatHandoffUrl", () => {
  it("targets the /chat route", () => {
    const url = buildAppChatHandoffUrl({ appId: "app-1", appName: "Notes" });
    expect(url.startsWith("/chat?")).toBe(true);
  });

  it("auto-sends a prompt carrying both the app name and id so render_app can resolve it", () => {
    const url = buildAppChatHandoffUrl({
      appId: "11111111-2222-3333-4444-555555555555",
      appName: "Notes",
    });

    const prompt = new URLSearchParams(url.split("?")[1]).get("user_prompt");
    expect(prompt).toContain("Notes");
    expect(prompt).toContain("11111111-2222-3333-4444-555555555555");
  });

  it("round-trips an app name with special characters", () => {
    const url = buildAppChatHandoffUrl({
      appName: 'A & B? "C" #1',
      appId: "app-1",
    });

    const prompt = new URLSearchParams(url.split("?")[1]).get("user_prompt");
    expect(prompt).toContain('A & B? "C" #1');
  });
});
