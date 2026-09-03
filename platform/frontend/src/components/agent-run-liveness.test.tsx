import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunLiveness } from "@/components/agent-run-liveness";
import type { AgentRun } from "@/lib/agent-runtime.query";

describe("AgentRunLiveness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the hard-stop countdown visible while model activity is recent", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    render(
      <AgentRunLiveness
        run={activeRun({
          lastModelActivityAt: "2026-09-03T11:58:00.000Z",
          hardDeadlineAt: "2026-09-06T12:00:00.000Z",
        })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Model active 2m ago");
    expect(screen.getByRole("status")).toHaveTextContent("Hard stop in 3d");
  });

  it("warns without claiming whether a quiet run is blocked or busy", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    render(
      <AgentRunLiveness
        run={activeRun({
          lastModelActivityAt: "2026-09-03T11:41:00.000Z",
          hardDeadlineAt: "2026-09-06T11:30:00.000Z",
        })}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("No model activity for 19m");
    expect(status).toHaveTextContent(
      "It may be running a long command or waiting at a terminal prompt.",
    );
    expect(status).toHaveTextContent("Hard stop in 2d 23h");
  });

  it("distinguishes a runtime that never made its first model request", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    render(
      <AgentRunLiveness
        run={activeRun({
          startedAt: "2026-09-03T11:30:00.000Z",
          lastModelActivityAt: null,
        })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "No model requests after 30m",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "The runtime may be blocked before its first model request.",
    );
  });

  it("prioritizes an explicit input-required state", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    render(
      <AgentRunLiveness
        run={activeRun({
          state: "TASK_STATE_INPUT_REQUIRED",
          lastModelActivityAt: "2026-09-03T10:00:00.000Z",
        })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Waiting for input");
    expect(screen.getByRole("status")).toHaveTextContent(
      "The agent reported that it needs a response to continue.",
    );
  });

  it("makes overdue cleanup explicit when the runtime is still open", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    render(
      <AgentRunLiveness
        run={activeRun({ hardDeadlineAt: "2026-09-03T11:45:00.000Z" })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Cleanup pending");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Deadline passed 15m ago",
    );
  });
});

function activeRun(
  overrides: Partial<
    Pick<
      AgentRun,
      | "endedAt"
      | "hardDeadlineAt"
      | "lastModelActivityAt"
      | "startedAt"
      | "state"
    >
  > = {},
) {
  return {
    attentionState: null,
    endedAt: null,
    hardDeadlineAt: "2026-09-06T12:00:00.000Z",
    lastModelActivityAt: "2026-09-03T11:58:00.000Z",
    startedAt: "2026-09-03T11:55:00.000Z",
    state: "TASK_STATE_WORKING" as const,
    ...overrides,
  };
}
