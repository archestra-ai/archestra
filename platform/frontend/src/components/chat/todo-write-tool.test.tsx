import { fireEvent, render, screen } from "@testing-library/react";
import type { ToolUIPart } from "ai";
import { describe, expect, it, vi } from "vitest";
import { TodoWriteTool } from "./todo-write-tool";

describe("TodoWriteTool", () => {
  it("does not render when there are no todos, errors, or result", () => {
    render(
      <TodoWriteTool
        part={makeTodoPart({ todos: [] })}
        toolResultPart={null}
      />,
    );

    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
  });

  it("renders expanded when a todo is pending", () => {
    render(
      <TodoWriteTool
        part={makeTodoPart({
          todos: [{ id: 1, content: "Plan the change", status: "pending" }],
        })}
        toolResultPart={{ output: { ok: true } } as ToolUIPart}
      />,
    );

    expect(screen.getByText("0/1")).toBeInTheDocument();
    expect(screen.getByText("Plan the change")).toBeInTheDocument();
  });

  it("renders collapsed when all todos are completed", () => {
    render(
      <TodoWriteTool
        part={makeTodoPart({
          todos: [{ id: 1, content: "Ship the change", status: "completed" }],
        })}
        toolResultPart={{ output: { ok: true } } as ToolUIPart}
      />,
    );

    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.queryByText("Ship the change")).not.toBeInTheDocument();
  });

  it("allows the user to toggle the panel", () => {
    render(
      <TodoWriteTool
        part={makeTodoPart({
          todos: [{ id: 1, content: "Toggle me", status: "pending" }],
        })}
        toolResultPart={{ output: { ok: true } } as ToolUIPart}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Tasks/i }));

    expect(screen.queryByText("Toggle me")).not.toBeInTheDocument();
  });

  it("recalculates open state when a newer todo state arrives", () => {
    const { rerender } = render(
      <TodoWriteTool
        part={makeTodoPart({
          toolCallId: "call_1",
          todos: [{ id: 1, content: "First task", status: "pending" }],
        })}
        toolResultPart={{ output: { ok: true } } as ToolUIPart}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Tasks/i }));
    expect(screen.queryByText("First task")).not.toBeInTheDocument();

    rerender(
      <TodoWriteTool
        part={makeTodoPart({
          toolCallId: "call_2",
          todos: [{ id: 1, content: "Second task", status: "in_progress" }],
        })}
        toolResultPart={{ output: { ok: true } } as ToolUIPart}
      />,
    );

    expect(screen.getByText("Second task")).toBeInTheDocument();
  });

  it("sends approval responses when approval is requested", () => {
    const onToolApprovalResponse = vi.fn();
    render(
      <TodoWriteTool
        part={
          {
            ...makeTodoPart({
              todos: [{ id: 1, content: "Approve me", status: "pending" }],
            }),
            state: "approval-requested",
            approval: { id: "approval_1" },
          } as ToolUIPart
        }
        toolResultPart={null}
        onToolApprovalResponse={onToolApprovalResponse}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onToolApprovalResponse).toHaveBeenCalledWith({
      id: "approval_1",
      approved: true,
    });
  });
});

function makeTodoPart(params: {
  toolCallId?: string;
  todos: Array<{
    id: number;
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}): ToolUIPart {
  return {
    type: "tool-archestra__todo_write",
    toolCallId: params.toolCallId ?? "call_1",
    state: "output-available",
    input: { todos: params.todos },
    output: { ok: true },
  } as ToolUIPart;
}
