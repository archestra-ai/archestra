import { describe, expect, it } from "vitest";
import { shouldShowMcpCardChatButton } from "./chat-button-visibility";

describe("shouldShowMcpCardChatButton", () => {
  it("hides when the catalog item has no discovered tools", () => {
    expect(
      shouldShowMcpCardChatButton({
        toolsCount: 0,
        isBuiltin: false,
        hasInstallation: true,
      }),
    ).toBe(false);
  });

  it("hides a non-builtin card with tools but no installation (the bug: tools persist after uninstall)", () => {
    // After every installation is removed the catalog's discovered tool rows
    // stay behind, so `toolsCount` is still > 0. The chat button must not show
    // because there is nothing reachable to chat with.
    expect(
      shouldShowMcpCardChatButton({
        toolsCount: 7,
        isBuiltin: false,
        hasInstallation: false,
      }),
    ).toBe(false);
  });

  it("shows a non-builtin card when an installation is reachable", () => {
    expect(
      shouldShowMcpCardChatButton({
        toolsCount: 7,
        isBuiltin: false,
        hasInstallation: true,
      }),
    ).toBe(true);
  });

  it("always shows a built-in (Archestra) card with tools, even with no installation", () => {
    // The built-in Archestra MCP server has no install rows; it is always
    // available, so it stays chat-enabled whenever it exposes tools.
    expect(
      shouldShowMcpCardChatButton({
        toolsCount: 12,
        isBuiltin: true,
        hasInstallation: false,
      }),
    ).toBe(true);
  });

  it("hides a built-in card that has no tools", () => {
    expect(
      shouldShowMcpCardChatButton({
        toolsCount: 0,
        isBuiltin: true,
        hasInstallation: false,
      }),
    ).toBe(false);
  });
});
