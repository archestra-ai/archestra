"use client";

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useConversationSearch } from "./use-conversation-search";

describe("useConversationSearch", () => {
  let originalPlatform: string;

  beforeEach(() => {
    originalPlatform = navigator.platform;
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
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    target?: EventTarget;
  }) {
    const event = new KeyboardEvent("keydown", {
      key: options.key,
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
