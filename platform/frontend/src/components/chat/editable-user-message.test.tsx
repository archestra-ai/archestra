import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditableUserMessage } from "./editable-user-message";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe("EditableUserMessage", () => {
  it("keeps the action tray hidden by default and configured to reveal on hover or focus within", () => {
    render(
      <EditableUserMessage
        messageId="user-1"
        partIndex={0}
        partKey="user-1-0"
        text="User message"
        isEditing={false}
        onStartEdit={vi.fn()}
        onCancelEdit={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const copyButton = screen.getByRole("button", { name: "Copy" });
    const actionTray = copyButton.closest("div.shadow-sm");

    expect(actionTray).toHaveClass("opacity-0", "pointer-events-none");
    expect(actionTray).toHaveClass(
      "group-hover/message:opacity-100",
      "group-hover/message:pointer-events-auto",
      "group-focus-within/message:opacity-100",
      "group-focus-within/message:pointer-events-auto",
    );
  });

  it("keeps message actions reachable by keyboard tab navigation", async () => {
    const user = userEvent.setup();

    render(
      <EditableUserMessage
        messageId="user-1"
        partIndex={0}
        partKey="user-1-0"
        text="User message"
        isEditing={false}
        onStartEdit={vi.fn()}
        onCancelEdit={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    await user.tab();

    expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();
  });

  it("keeps regenerate confirmation actions visible", async () => {
    const user = userEvent.setup();

    render(
      <EditableUserMessage
        messageId="user-1"
        partIndex={0}
        partKey="user-1-0"
        text="User message"
        isEditing={false}
        onStartEdit={vi.fn()}
        onCancelEdit={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Regenerate" }));

    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    const actionTray = confirmButton.closest("div.shadow-sm");

    expect(confirmButton).toBeInTheDocument();
    expect(actionTray).toHaveClass("opacity-100", "pointer-events-auto");
  });
});
