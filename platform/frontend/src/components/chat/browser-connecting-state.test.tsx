import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserConnectingState } from "./browser-connecting-state";

describe("BrowserConnectingState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances through the connecting messages and holds on the last one", () => {
    render(<BrowserConnectingState />);

    expect(screen.getByText("Connecting to the browser…")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2200);
    });
    expect(
      screen.getByText("Opening an isolated browser session…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Connecting to the browser…"),
    ).not.toBeInTheDocument();

    // Each message schedules the next after it renders, so step one interval at a time.
    for (let step = 0; step < 20; step++) {
      act(() => {
        vi.advanceTimersByTime(2200);
      });
    }
    expect(screen.getByText("Still working…")).toBeInTheDocument();
  });

  it("exposes a stable accessible status while the message rotates", () => {
    render(<BrowserConnectingState />);

    act(() => {
      vi.advanceTimersByTime(2200);
    });

    expect(
      screen.getByRole("status", { name: "Connecting to the browser" }),
    ).toBeInTheDocument();
  });
});
