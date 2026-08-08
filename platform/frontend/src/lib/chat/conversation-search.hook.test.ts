"use client";

import { act, renderHook } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationSearch } from "@/lib/chat/conversation-search.hook";
import { useFeature } from "@/lib/config/config.query";

vi.mock("next/navigation");

vi.mock("@/lib/config/config.query");

describe("useConversationSearch", () => {
  let originalPlatform: string;
  let mockRouterPush: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalPlatform = navigator.platform;
    mockRouterPush = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
    } as unknown as ReturnType<typeof useRouter>);
    // Incognito chats are on by default, matching the shipped default.
    vi.mocked(useFeature).mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(navigator, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  function mockPlatform(platform: string) {
    Object.defineProperty(navigator, "platform", {
      value: platform,
      writable: true,
    });
  }

  function dispatchKeydown(options: {
    key: string;
    code?: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    target?: EventTarget;
  }) {
    const event = new KeyboardEvent("keydown", {
      key: options.key,
      code: options.code ?? "",
      metaKey: options.metaKey ?? false,
      ctrlKey: options.ctrlKey ?? false,
      shiftKey: options.shiftKey ?? false,
      altKey: options.altKey ?? false,
      bubbles: true,
      cancelable: true,
    });

    if (options.target) {
      Object.defineProperty(event, "target", {
        value: options.target,
        writable: false,
      });
    }

    window.dispatchEvent(event);
    return event;
  }

  it("should start with isOpen = false", () => {
    const { result } = renderHook(() => useConversationSearch());
    expect(result.current.isOpen).toBe(false);
  });

  it("should open on Cmd+K on Mac", () => {
    mockPlatform("MacIntel");
    const { result } = renderHook(() => useConversationSearch());

    act(() => {
      dispatchKeydown({ key: "k", metaKey: true });
    });

    expect(result.current.isOpen).toBe(true);
  });

  it("should open on Ctrl+K on Windows/Linux", () => {
    mockPlatform("Win32");
    const { result } = renderHook(() => useConversationSearch());

    act(() => {
      dispatchKeydown({ key: "k", ctrlKey: true });
    });

    expect(result.current.isOpen).toBe(true);
  });

  it("should toggle open state on repeated Cmd+K", () => {
    mockPlatform("MacIntel");
    const { result } = renderHook(() => useConversationSearch());

    act(() => {
      dispatchKeydown({ key: "k", metaKey: true });
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      dispatchKeydown({ key: "k", metaKey: true });
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("should not open on K without modifier", () => {
    const { result } = renderHook(() => useConversationSearch());

    act(() => {
      dispatchKeydown({ key: "k" });
    });

    expect(result.current.isOpen).toBe(false);
  });

  it("should not open on Cmd+K+Shift", () => {
    mockPlatform("MacIntel");
    const { result } = renderHook(() => useConversationSearch());

    act(() => {
      dispatchKeydown({ key: "k", metaKey: true, shiftKey: true });
    });

    expect(result.current.isOpen).toBe(false);
  });

  it("should not open on Cmd+K+Alt", () => {
    mockPlatform("MacIntel");
    const { result } = renderHook(() => useConversationSearch());

    act(() => {
      dispatchKeydown({ key: "k", metaKey: true, altKey: true });
    });

    expect(result.current.isOpen).toBe(false);
  });

  it("should work when event target is an input element", () => {
    mockPlatform("MacIntel");
    const { result } = renderHook(() => useConversationSearch());

    const inputElement = document.createElement("input");
    document.body.appendChild(inputElement);

    act(() => {
      dispatchKeydown({ key: "k", metaKey: true, target: inputElement });
    });

    expect(result.current.isOpen).toBe(true);
    document.body.removeChild(inputElement);
  });

  it("should work when event target is a textarea", () => {
    mockPlatform("MacIntel");
    const { result } = renderHook(() => useConversationSearch());

    const textareaElement = document.createElement("textarea");
    document.body.appendChild(textareaElement);

    act(() => {
      dispatchKeydown({ key: "k", metaKey: true, target: textareaElement });
    });

    expect(result.current.isOpen).toBe(true);
    document.body.removeChild(textareaElement);
  });

  it("should work when event target is contenteditable", () => {
    mockPlatform("MacIntel");
    const { result } = renderHook(() => useConversationSearch());

    const editableDiv = document.createElement("div");
    editableDiv.contentEditable = "true";
    document.body.appendChild(editableDiv);

    act(() => {
      dispatchKeydown({ key: "k", metaKey: true, target: editableDiv });
    });

    expect(result.current.isOpen).toBe(true);
    document.body.removeChild(editableDiv);
  });

  it("should open via custom event", () => {
    const { result } = renderHook(() => useConversationSearch());

    act(() => {
      window.dispatchEvent(new CustomEvent("open-conversation-search"));
    });

    expect(result.current.isOpen).toBe(true);
  });

  it("starts a new incognito chat on Alt+I", () => {
    mockPlatform("MacIntel");
    renderHook(() => useConversationSearch());

    act(() => {
      // macOS turns Option+I into a dead key, so the handler matches on
      // `code` rather than `key` — dispatch what the browser really sends.
      dispatchKeydown({ key: "Dead", code: "KeyI", altKey: true });
    });

    expect(mockRouterPush).toHaveBeenCalledWith("/chat?incognito=1");
  });

  it("ignores Alt+I when incognito chats are disabled", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    mockPlatform("MacIntel");
    renderHook(() => useConversationSearch());

    act(() => {
      dispatchKeydown({ key: "Dead", code: "KeyI", altKey: true });
    });

    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("requires the Alt modifier to start an incognito chat", () => {
    mockPlatform("MacIntel");
    renderHook(() => useConversationSearch());

    act(() => {
      dispatchKeydown({ key: "i", code: "KeyI" });
    });

    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("should allow programmatic control via setIsOpen", () => {
    const { result } = renderHook(() => useConversationSearch());

    act(() => {
      result.current.setIsOpen(true);
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.setIsOpen(false);
    });
    expect(result.current.isOpen).toBe(false);
  });
});
