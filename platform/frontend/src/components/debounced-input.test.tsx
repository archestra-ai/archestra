import { fireEvent, render, screen } from "@testing-library/react";
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
});
