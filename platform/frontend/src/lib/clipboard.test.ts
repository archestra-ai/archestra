import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function setNavigatorClipboard(value: Clipboard | undefined) {
  Object.defineProperty(window.navigator, "clipboard", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  setNavigatorClipboard(originalClipboard);
  document.execCommand = originalExecCommand;
  vi.restoreAllMocks();
});

describe("copyToClipboard", () => {
  it("uses the async Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigatorClipboard({ writeText } as unknown as Clipboard);
    document.execCommand = vi.fn();

    await copyToClipboard("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when navigator.clipboard is unavailable (insecure context)", async () => {
    setNavigatorClipboard(undefined);
    let copiedText: string | undefined;
    document.execCommand = vi.fn((command: string) => {
      if (command === "copy") {
        copiedText = document.querySelector("textarea")?.value;
        return true;
      }
      return false;
    });

    await copyToClipboard("http://example.com/invite?id=123");

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(copiedText).toBe("http://example.com/invite?id=123");
    // The helper textarea must not be left in the DOM
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    setNavigatorClipboard({ writeText } as unknown as Clipboard);
    document.execCommand = vi.fn(() => true);

    await copyToClipboard("hello");

    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("rejects and cleans up when no copy mechanism works", async () => {
    setNavigatorClipboard(undefined);
    document.execCommand = vi.fn(() => false);

    await expect(copyToClipboard("hello")).rejects.toThrow();
    expect(document.querySelector("textarea")).toBeNull();
  });
});
