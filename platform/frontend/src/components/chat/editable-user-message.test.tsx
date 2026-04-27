import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditableUserMessage } from "./editable-user-message";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <span>
      {children}
      <button type="button" onClick={() => onOpenChange?.(true)}>
        Open tooltip
      </button>
    </span>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({
    children,
    className,
    noArrow,
    side,
    sideOffset,
  }: {
    children: React.ReactNode;
    className?: string;
    noArrow?: boolean;
    side?: string;
    sideOffset?: number;
  }) => (
    <div
      data-no-arrow={noArrow ? "true" : "false"}
      data-side={side}
      data-side-offset={sideOffset}
      className={className}
    >
      {children}
    </div>
  ),
}));

describe("EditableUserMessage", () => {
  it("renders user text with the assistant-style secondary bubble", () => {
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

    const messageContent = screen.getByText("User message").parentElement;

    expect(messageContent).toHaveClass(
      "group-[.is-user]:bg-secondary",
      "group-[.is-user]:text-secondary-foreground",
    );
    expect(messageContent).not.toHaveClass("group-[.is-user]:bg-primary");
  });

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
    const actionTray = copyButton.closest("[data-message-actions]");
    const focusSurface = actionTray?.closest("[data-message-focus-surface]");

    expect(actionTray).toHaveClass("opacity-0", "pointer-events-none");
    expect(actionTray).toHaveClass("bottom-0", "-right-1.5", "px-4", "py-0");
    expect(actionTray).not.toHaveClass(
      "border",
      "bg-background/95",
      "shadow-sm",
    );
    expect(actionTray).not.toHaveClass("translate-y-full");
    expect(focusSurface).toHaveClass("pb-9");
    expect(actionTray).toHaveClass(
      "group-hover/message:opacity-100",
      "group-hover/message:pointer-events-auto",
      "group-focus-within/message:opacity-100",
      "group-focus-within/message:pointer-events-auto",
    );

    const tooltipContent = screen
      .getAllByText("Copy")
      .find((element) => element.getAttribute("data-no-arrow") === "true");
    expect(tooltipContent).toHaveAttribute("data-no-arrow", "true");
    expect(tooltipContent).toHaveAttribute("data-side", "bottom");
    expect(tooltipContent).toHaveAttribute("data-side-offset", "4");
    expect(tooltipContent).toHaveClass(
      "animate-none",
      "data-[state=closed]:animate-none",
      "pointer-events-none",
    );
  });

  it("keeps message actions visible while an action tooltip is open", async () => {
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

    const copyButton = screen.getByRole("button", { name: "Copy" });
    const actionTray = copyButton.closest("[data-message-actions]");

    expect(actionTray).toHaveClass("opacity-0", "pointer-events-none");

    await user.click(
      screen.getAllByRole("button", { name: "Open tooltip" })[0],
    );

    expect(actionTray).toHaveClass("opacity-100", "pointer-events-auto");
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
    const actionTray = confirmButton.closest("[data-message-actions]");

    expect(confirmButton).toBeInTheDocument();
    expect(actionTray).toHaveClass("opacity-100", "pointer-events-auto");
  });
});
