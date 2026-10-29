import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTranscriptWindow } from "./transcript-window";

const messages = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => ({
    kind: "message",
    message: { id: `m${from + index}` },
  }));

describe("useTranscriptWindow", () => {
  it("opens on the end and keeps its first message when the history arrives in front", () => {
    // The conversation's end, as the first screen loads it.
    const { result, rerender } = renderHook(
      ({ items }) => useTranscriptWindow(items),
      { initialProps: { items: messages(60, 100) } },
    );
    const firstShown = (items: ReturnType<typeof messages>) =>
      items[result.current.start]?.message.id;
    expect(result.current.start).toBe(10);
    expect(firstShown(messages(60, 100))).toBe("m70");

    // The earlier 60 messages arrive: the same messages stay mounted.
    const full = messages(0, 100);
    rerender({ items: full });
    expect(result.current.start).toBe(70);
    expect(firstShown(full)).toBe("m70");

    // A new message is appended, not pushing the window's start.
    const longer = messages(0, 101);
    rerender({ items: longer });
    expect(firstShown(longer)).toBe("m70");

    // Scrolling up mounts the previous step of the full history.
    act(() => result.current.showEarlier());
    expect(result.current.start).toBe(40);
  });

  it("fills up to its opening size when the end shown first was short", () => {
    const { result, rerender } = renderHook(
      ({ items }) => useTranscriptWindow(items),
      { initialProps: { items: messages(4, 6) } },
    );
    expect(result.current.start).toBe(0);

    // All of a short history mounts; of a long one, the opening window's
    // worth ending on what was shown.
    rerender({ items: messages(0, 6) });
    expect(result.current.start).toBe(0);
    rerender({ items: messages(-44, 6) });
    expect(result.current.start).toBe(20);
  });
});
