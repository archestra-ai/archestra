import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStateIcon } from "@/components/chat/run-state-icon";

describe("RunStateIcon", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("distinguishes recent model activity from a stalled working run", () => {
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
    expect(screen.getByLabelText("Run active")).toBeInTheDocument();

    rerender(
      <RunStateIcon
        state="TASK_STATE_WORKING"
        startedAt="2026-09-03T11:00:00.000Z"
        endedAt={null}
        lastModelActivityAt="2026-09-03T11:40:00.000Z"
      />,
    );
    expect(screen.getByLabelText("Run may be stalled")).toBeInTheDocument();
  });

  it.each([
    ["TASK_STATE_AUTH_REQUIRED", "Run authentication required"],
    ["TASK_STATE_COMPLETED", "Run completed"],
    ["TASK_STATE_FAILED", "Run failed"],
    ["TASK_STATE_CANCELED", "Run canceled"],
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
    expect(screen.getByLabelText("Run waiting for input")).toBeInTheDocument();
  });

  it("explains the compact status on hover", async () => {
    const user = userEvent.setup();
    render(<RunStateIcon state="TASK_STATE_WORKING" />);

    await user.hover(screen.getByLabelText("Run active"));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Run active");
  });

  it("prioritizes an overdue hard deadline while cleanup is pending", () => {
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

    expect(screen.getByLabelText("Run cleanup pending")).toBeInTheDocument();
  });
});
