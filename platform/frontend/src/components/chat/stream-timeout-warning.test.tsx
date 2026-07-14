import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamTimeoutWarning } from "./stream-timeout-warning";

describe("StreamTimeoutWarning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("prioritizes transport inactivity when neither clock advances", () => {
    render(
      <StreamTimeoutWarning
        status="streaming"
        transportActivitySequence={0}
        responseProgressSequence={0}
        thresholdSeconds={40}
      />,
    );

    act(() => vi.advanceTimersByTime(39_999));
    expect(screen.queryByText(/no stream activity/i)).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText(/no stream activity/i)).toHaveTextContent(
      "The connection may have stalled",
    );
    expect(screen.queryByText(/no response progress/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /learn more/i }),
    ).toBeInTheDocument();
  });

  it("keeps the transport alive on heartbeat while warning about stalled response progress", () => {
    const { rerender } = render(
      <StreamTimeoutWarning
        status="streaming"
        transportActivitySequence={0}
        responseProgressSequence={0}
        thresholdSeconds={10}
      />,
    );

    act(() => vi.advanceTimersByTime(5_000));
    rerender(
      <StreamTimeoutWarning
        status="streaming"
        transportActivitySequence={1}
        responseProgressSequence={0}
        thresholdSeconds={10}
      />,
    );

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText(/no response progress/i)).toHaveTextContent(
      "The upstream provider may still be processing or may have stalled",
    );
    expect(screen.queryByText(/no stream activity/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /learn more/i }),
    ).not.toBeInTheDocument();
  });

  it("clears the warning and restarts both clocks on substantive progress", () => {
    const { rerender } = render(
      <StreamTimeoutWarning
        status="streaming"
        transportActivitySequence={0}
        responseProgressSequence={0}
        thresholdSeconds={10}
      />,
    );

    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText(/no stream activity/i)).toBeInTheDocument();

    rerender(
      <StreamTimeoutWarning
        status="streaming"
        transportActivitySequence={1}
        responseProgressSequence={1}
        thresholdSeconds={10}
      />,
    );
    expect(screen.queryByText(/no stream activity/i)).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(9_999));
    expect(screen.queryByText(/no stream activity/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no response progress/i)).not.toBeInTheDocument();
  });

  it("monitors submission before the first model chunk and clears when the request ends", () => {
    const { rerender } = render(
      <StreamTimeoutWarning
        status="submitted"
        transportActivitySequence={3}
        responseProgressSequence={2}
        thresholdSeconds={5}
      />,
    );

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText(/no stream activity/i)).toBeInTheDocument();

    rerender(
      <StreamTimeoutWarning
        status="streaming"
        transportActivitySequence={3}
        responseProgressSequence={2}
        thresholdSeconds={5}
      />,
    );
    expect(screen.queryByText(/no stream activity/i)).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText(/no stream activity/i)).toBeInTheDocument();

    rerender(
      <StreamTimeoutWarning
        status="ready"
        transportActivitySequence={3}
        responseProgressSequence={2}
        thresholdSeconds={5}
      />,
    );
    expect(screen.queryByText(/no stream activity/i)).not.toBeInTheDocument();
  });
});
