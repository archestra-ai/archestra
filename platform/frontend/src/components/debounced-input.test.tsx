import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebouncedInput } from "./debounced-input";

describe("DebouncedInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function typeInInput(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
  }

  it("renders with initial value", () => {
    render(<DebouncedInput initialValue="hello" onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toHaveValue("hello");
  });

  it("calls onChange after debounce delay", () => {
    const onChange = vi.fn();
    render(
      <DebouncedInput initialValue="" onChange={onChange} debounceMs={400} />,
    );

    typeInInput(screen.getByRole("textbox"), "test");
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(onChange).toHaveBeenCalledWith("test");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not call onChange on initial render", () => {
    const onChange = vi.fn();
    render(<DebouncedInput initialValue="initial" onChange={onChange} />);

    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("syncs value when initialValue changes externally", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DebouncedInput initialValue="first" onChange={onChange} />,
    );

    expect(screen.getByRole("textbox")).toHaveValue("first");

    rerender(<DebouncedInput initialValue="second" onChange={onChange} />);

    expect(screen.getByRole("textbox")).toHaveValue("second");
  });

  it("does not eat characters typed during debounce", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DebouncedInput initialValue="" onChange={onChange} debounceMs={400} />,
    );

    const input = screen.getByRole("textbox");

    // Type "hello"
    typeInInput(input, "hello");

    // Debounce fires with "hello"
    vi.advanceTimersByTime(400);
    expect(onChange).toHaveBeenCalledWith("hello");

    // Type extra "d" immediately after
    typeInInput(input, "hellod");

    // Simulate the URL update propagating back (initialValue changes to "hello")
    // This happens because router.push is async and the URL update arrives late
    rerender(
      <DebouncedInput
        initialValue="hello"
        onChange={onChange}
        debounceMs={400}
      />,
    );

    // The input should still show "hellod", not be reset to "hello"
    expect(screen.getByRole("textbox")).toHaveValue("hellod");

    // After debounce, onChange should fire with "hellod"
    vi.advanceTimersByTime(400);
    expect(onChange).toHaveBeenCalledWith("hellod");
  });

  it("uses custom debounce delay", () => {
    const onChange = vi.fn();
    render(
      <DebouncedInput initialValue="" onChange={onChange} debounceMs={200} />,
    );

    typeInInput(screen.getByRole("textbox"), "fast");

    vi.advanceTimersByTime(199);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledWith("fast");
  });

  it("resets debounce timer on each keystroke", () => {
    const onChange = vi.fn();
    render(
      <DebouncedInput initialValue="" onChange={onChange} debounceMs={400} />,
    );

    const input = screen.getByRole("textbox");

    typeInInput(input, "h");
    vi.advanceTimersByTime(200);
    typeInInput(input, "he");
    vi.advanceTimersByTime(200);
    typeInInput(input, "hel");
    vi.advanceTimersByTime(200);

    // Should not have fired yet (timer keeps resetting)
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    // Now it should fire with the latest value
    expect(onChange).toHaveBeenCalledWith("hel");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  /**
   * The pending window drives the search box's spinner. Every case below is a
   * way that indicator has to behave: start at the keystroke, survive the
   * hand-off to whatever the commit triggers, and never stick on.
   */
  describe("pending window", () => {
    const lastPending = (onPendingChange: ReturnType<typeof vi.fn>) =>
      onPendingChange.mock.lastCall?.[0];

    it("opens on the keystroke rather than when the debounce fires", () => {
      const onPendingChange = vi.fn();
      render(
        <DebouncedInput
          initialValue=""
          onChange={() => {}}
          debounceMs={400}
          onPendingChange={onPendingChange}
        />,
      );

      act(() => typeInInput(screen.getByRole("textbox"), "no"));

      // The whole point: the gap being covered starts at the keystroke, not
      // 400ms later once the request goes out.
      expect(lastPending(onPendingChange)).toBe(true);
    });

    it("stays open across the commit until the caller takes the new value", () => {
      const onPendingChange = vi.fn();
      const { rerender } = render(
        <DebouncedInput
          initialValue=""
          onChange={() => {}}
          debounceMs={400}
          onPendingChange={onPendingChange}
        />,
      );

      act(() => typeInInput(screen.getByRole("textbox"), "notion"));
      act(() => void vi.advanceTimersByTime(400));

      // Closing here would blink the indicator off in the gap between the
      // commit and the request it triggers.
      expect(lastPending(onPendingChange)).toBe(true);

      rerender(
        <DebouncedInput
          initialValue="notion"
          onChange={() => {}}
          debounceMs={400}
          onPendingChange={onPendingChange}
        />,
      );

      expect(lastPending(onPendingChange)).toBe(false);
    });

    it("closes on its own when the caller never commits the value back", () => {
      const onPendingChange = vi.fn();
      render(
        <DebouncedInput
          initialValue=""
          onChange={() => {}}
          debounceMs={400}
          onPendingChange={onPendingChange}
        />,
      );

      act(() => typeInInput(screen.getByRole("textbox"), "notion"));
      act(() => void vi.advanceTimersByTime(400));
      expect(lastPending(onPendingChange)).toBe(true);

      // A caller that keeps the query somewhere other than `initialValue`
      // never closes the window, so the bound has to.
      act(() => void vi.advanceTimersByTime(1000));
      expect(lastPending(onPendingChange)).toBe(false);
    });

    it("never opens for an edit that lands back on the committed value", () => {
      const onPendingChange = vi.fn();
      render(
        <DebouncedInput
          initialValue="notion"
          onChange={() => {}}
          debounceMs={400}
          onPendingChange={onPendingChange}
        />,
      );

      const input = screen.getByRole("textbox");
      act(() => typeInInput(input, "notio"));
      expect(lastPending(onPendingChange)).toBe(true);

      // Nothing will change, so nothing should claim to be loading.
      act(() => typeInInput(input, "notion"));
      expect(lastPending(onPendingChange)).toBe(false);

      act(() => void vi.advanceTimersByTime(400));
      expect(lastPending(onPendingChange)).toBe(false);
    });
  });
});
