import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentExecutionState } from "@/components/agent-execution-state";

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));

describe("AgentExecutionState", () => {
  it("opens copyable failure details from the compact status", async () => {
    const user = userEvent.setup();
    render(
      <AgentExecutionState
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
    expect(dialog).toHaveTextContent("Execution failed");
    expect(dialog).toHaveTextContent("HTTP-Code: 403 Message: Access denied");
    expect(dialog.querySelector("pre")).toHaveTextContent(
      /"kind": "Status"[\s\S]*"code": 403/,
    );
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeEnabled();
  });

  it("renders a non-interactive status when no details were recorded", () => {
    render(<AgentExecutionState state="TASK_STATE_FAILED" compact />);

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /view failed details/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps an icon-only history status accessible", () => {
    render(
      <AgentExecutionState
        state="TASK_STATE_INPUT_REQUIRED"
        compact
        iconOnly
      />,
    );

    expect(screen.getByRole("img", { name: "Needs input" })).toBeVisible();
    expect(screen.queryByText("Needs input")).not.toBeInTheDocument();
  });
});
