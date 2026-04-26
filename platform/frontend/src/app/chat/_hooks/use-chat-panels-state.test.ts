import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import { useChatPanelsState } from "./use-chat-panels-state";

describe("useChatPanelsState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("initializes the browser panel from localStorage", () => {
    localStorage.setItem("archestra-chat-browser-open", "true");

    const { result } = renderHook(() =>
      useChatPanelsState({
        conversationId: undefined,
        artifact: null,
        isLoadingConversation: false,
      }),
    );

    expect(result.current.isBrowserPanelOpen).toBe(true);
  });

  test("persists browser panel toggles", () => {
    const { result } = renderHook(() =>
      useChatPanelsState({
        conversationId: undefined,
        artifact: null,
        isLoadingConversation: false,
      }),
    );

    act(() => result.current.toggleBrowserPanel());

    expect(result.current.isBrowserPanelOpen).toBe(true);
    expect(localStorage.getItem("archestra-chat-browser-open")).toBe("true");
  });

  test("auto-opens artifact when a conversation first loads with an artifact", () => {
    const { result } = renderHook(() =>
      useChatPanelsState({
        conversationId: "conversation-1",
        artifact: "artifact",
        isLoadingConversation: false,
      }),
    );

    expect(result.current.isArtifactOpen).toBe(true);
    expect(
      localStorage.getItem(
        conversationStorageKeys("conversation-1").artifactOpen,
      ),
    ).toBe("true");
  });

  test("uses a stored artifact panel preference when present", () => {
    localStorage.setItem(
      conversationStorageKeys("conversation-1").artifactOpen,
      "false",
    );

    const { result } = renderHook(() =>
      useChatPanelsState({
        conversationId: "conversation-1",
        artifact: "artifact",
        isLoadingConversation: false,
      }),
    );

    expect(result.current.isArtifactOpen).toBe(false);
  });
});
