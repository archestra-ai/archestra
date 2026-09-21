import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStateIcon } from "@/components/chat/run-state-icon";

describe("RunStateIcon", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the machine and the wait when a working run goes quiet", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    const { rerender } = render(
      <RunStateIcon
        state="TASK_STATE_WORKING"
        startedAt="2026-09-03T11:00:00.000Z"
        endedAt={null}
        lastModelActivityAt="2026-09-03T11:58:00.000Z"
      />,
    );
    expect(screen.getByLabelText("Running")).toBeInTheDocument();

    rerender(
      <RunStateIcon
        state="TASK_STATE_WORKING"
        startedAt="2026-09-03T11:00:00.000Z"
        endedAt={null}
        lastModelActivityAt="2026-09-03T11:40:00.000Z"
      />,
    );
    expect(
      screen.getByLabelText("Running · quiet for 20m"),
    ).toBeInTheDocument();
  });

  it("keeps a completed turn's session live while it still calls the model", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    const { rerender } = render(
      <RunStateIcon
        state="TASK_STATE_COMPLETED"
        startedAt="2026-09-03T11:00:00.000Z"
        endedAt="2026-09-03T11:20:00.000Z"
        lastModelActivityAt="2026-09-03T11:58:00.000Z"
      />,
    );
    expect(
      screen.getByLabelText("Session active · turn completed"),
    ).toBeInTheDocument();
    rerender(
      <RunStateIcon
        state="TASK_STATE_COMPLETED"
        startedAt="2026-09-03T11:00:00.000Z"
        endedAt="2026-09-03T11:20:00.000Z"
        lastModelActivityAt="2026-09-03T11:30:00.000Z"
      />,
    );
    expect(screen.getByLabelText("Completed")).toBeInTheDocument();
  });

  it.each([
    ["TASK_STATE_AUTH_REQUIRED", "Running · Needs sign-in"],
    ["TASK_STATE_COMPLETED", "Completed"],
    ["TASK_STATE_FAILED", "Ended · Failed"],
    ["TASK_STATE_CANCELED", "Canceled"],
  ] as const)("maps %s to %s", (state, label) => {
    render(<RunStateIcon state={state} />);
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it("uses the native runtime attention signal without changing task lifecycle", () => {
    render(
      <RunStateIcon
        state="TASK_STATE_WORKING"
        attentionState="input_required"
      />,
    );
    expect(
      screen.getByLabelText("Running · Needs your input"),
    ).toBeInTheDocument();
  });

  it("explains the compact status on hover", async () => {
    const user = userEvent.setup();
    render(<RunStateIcon state="TASK_STATE_WORKING" />);

    await user.hover(screen.getByLabelText("Running"));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Running");
  });

  it("reads as stopping once the hard deadline has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    render(
      <RunStateIcon
        state="TASK_STATE_WORKING"
        startedAt="2026-09-03T11:58:00.000Z"
        endedAt={null}
        hardDeadlineAt="2026-09-03T11:59:00.000Z"
        lastModelActivityAt="2026-09-03T11:58:00.000Z"
      />,
    );

    expect(screen.getByLabelText("Stopping")).toBeInTheDocument();
  });
});
