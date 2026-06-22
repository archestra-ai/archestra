import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import { useRightPanel } from "./use-right-panel";

// Avoid pulling in TanStack Query; the hook only reads the generated-file count.
vi.mock("@/lib/chat/chat.query", () => ({
  useConversationFiles: () => ({ data: { generated: [] } }),
}));

const baseParams = {
  conversationId: "c1",
  artifact: null as string | null | undefined,
  isLoadingConversation: false,
  lastBrowserToolCallId: null as string | null,
  showBrowserButton: false,
  isPlaywrightSetupVisible: false,
};

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("useRightPanel", () => {
  it("defaults closed on the Files tab", () => {
    const { result } = renderHook(() => useRightPanel(baseParams));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.activeTab).toBe("files");
  });

  it("openTab opens the panel and switches the active tab", () => {
    const { result } = renderHook(() => useRightPanel(baseParams));

    act(() => result.current.openTab("canvas"));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTab).toBe("canvas");

    act(() => result.current.openTab("files"));
    expect(result.current.activeTab).toBe("files");
  });

  it("setActiveTab switches tabs without changing open state", () => {
    const { result } = renderHook(() => useRightPanel(baseParams));
    expect(result.current.isOpen).toBe(false);

    act(() => result.current.setActiveTab("canvas"));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.activeTab).toBe("canvas");
  });

  it("toggle closes and reopens without changing the active tab", () => {
    const { result } = renderHook(() => useRightPanel(baseParams));
    act(() => result.current.openTab("canvas"));

    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(false);

    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTab).toBe("canvas");
  });

  it("opens Files on mount when the conversation has an artifact", () => {
    const { result } = renderHook(() =>
      useRightPanel({ ...baseParams, artifact: "# hello" }),
    );
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTab).toBe("files");
  });

  it("restores the panel from a project-seeded open Files preference", () => {
    // A chat started from a project with files seeds these before navigation.
    localStorage.setItem(conversationStorageKeys("c1").rightPanelOpen, "true");
    localStorage.setItem(conversationStorageKeys("c1").rightPanelTab, "files");
    const { result } = renderHook(() => useRightPanel(baseParams));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTab).toBe("files");
  });

  it("auto-opens Browser only on a newly-arriving tool call", () => {
    const { result, rerender } = renderHook(
      (props: typeof baseParams) => useRightPanel(props),
      {
        // A call already present at mount must not auto-open (it's history).
        initialProps: {
          ...baseParams,
          showBrowserButton: true,
          lastBrowserToolCallId: "call-0",
        },
      },
    );
    expect(result.current.isOpen).toBe(false);

    rerender({
      ...baseParams,
      showBrowserButton: true,
      lastBrowserToolCallId: "call-1",
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTab).toBe("browser");
  });

  it("persists open/tab changes and restores them on remount", () => {
    const { result, unmount } = renderHook(() => useRightPanel(baseParams));

    act(() => result.current.openTab("canvas"));
    expect(
      localStorage.getItem(conversationStorageKeys("c1").rightPanelOpen),
    ).toBe("true");
    expect(
      localStorage.getItem(conversationStorageKeys("c1").rightPanelTab),
    ).toBe("canvas");
    unmount();

    // A fresh mount restores the persisted state instead of the default.
    const { result: restored } = renderHook(() => useRightPanel(baseParams));
    expect(restored.current.isOpen).toBe(true);
    expect(restored.current.activeTab).toBe("canvas");
  });

  it("a persisted closed state wins over the artifact auto-open default", () => {
    localStorage.setItem(conversationStorageKeys("c1").rightPanelOpen, "false");
    localStorage.setItem(conversationStorageKeys("c1").rightPanelTab, "files");
    const { result } = renderHook(() =>
      useRightPanel({ ...baseParams, artifact: "# hello" }),
    );
    expect(result.current.isOpen).toBe(false);
  });

  it("falls back to Files when the agent can no longer browse", () => {
    const { result, rerender } = renderHook(
      (props: typeof baseParams) => useRightPanel(props),
      { initialProps: { ...baseParams, showBrowserButton: true } },
    );
    act(() => result.current.openTab("browser"));
    expect(result.current.activeTab).toBe("browser");

    rerender({ ...baseParams, showBrowserButton: false });
    expect(result.current.activeTab).toBe("files");
  });
});
