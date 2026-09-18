import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunState } from "@/components/agent-run-state";

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));

describe("AgentRunState", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens copyable failure details from the failure chip", async () => {
    const user = userEvent.setup();
    render(
      <AgentRunState
        state="TASK_STATE_FAILED"
        statusReason={
          'HTTP-Code: 403 Message: Access denied Body: "{\\"kind\\":\\"Status\\",\\"code\\":403}"'
        }
        compact
      />,
    );

    expect(screen.getByText("Details")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "View failed details" }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Run failed");
    expect(dialog).toHaveTextContent("HTTP-Code: 403 Message: Access denied");
    expect(dialog.querySelector("pre")).toHaveTextContent(
      /"kind": "Status"[\s\S]*"code": 403/,
    );
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeEnabled();
  });

  it("renders a non-interactive failure chip when no details were recorded", () => {
    render(<AgentRunState state="TASK_STATE_FAILED" compact />);

    expect(screen.getByText("Ended")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /view failed details/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps an icon-only history status accessible", () => {
    render(
      <AgentRunState
        state="TASK_STATE_WORKING"
        attentionState="input_required"
        endedAt={null}
        compact
        iconOnly
      />,
    );

    expect(
      screen.getByRole("img", { name: "Running · Needs your input" }),
    ).toBeVisible();
    expect(screen.queryByText("Needs your input")).not.toBeInTheDocument();
  });

  it("reports a completed turn as an active session while it still calls the model", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    const { rerender } = render(
      <AgentRunState
        state="TASK_STATE_COMPLETED"
        lastModelActivityAt="2026-09-03T11:58:00.000Z"
        startedAt="2026-09-03T10:00:00.000Z"
        endedAt="2026-09-03T11:20:00.000Z"
        compact
      />,
    );
    expect(screen.getByText("Session active")).toBeInTheDocument();
    expect(screen.getByText("· turn completed")).toBeInTheDocument();

    rerender(
      <AgentRunState
        state="TASK_STATE_COMPLETED"
        lastModelActivityAt="2026-09-03T11:30:00.000Z"
        startedAt="2026-09-03T10:00:00.000Z"
        endedAt="2026-09-03T11:20:00.000Z"
        compact
      />,
    );
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("keeps a quiet run green and moves the wait into words", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");

    render(
      <AgentRunState
        state="TASK_STATE_WORKING"
        lastModelActivityAt="2026-09-03T11:30:00.000Z"
        startedAt="2026-09-03T10:00:00.000Z"
        endedAt={null}
        compact
      />,
    );

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("· quiet for 30m")).toBeInTheDocument();
  });
});
