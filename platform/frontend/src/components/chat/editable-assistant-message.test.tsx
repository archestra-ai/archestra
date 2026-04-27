import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditableAssistantMessage } from "./editable-assistant-message";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ai-elements/response", () => ({
  Response: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/chat/knowledge-graph-citations", () => ({
  KnowledgeGraphCitations: () => null,
}));

describe("EditableAssistantMessage", () => {
  it("keeps the action tray hidden by default and configured to reveal on hover or focus within", () => {
    render(
      <EditableAssistantMessage
        messageId="assistant-1"
        partIndex={0}
        partKey="assistant-1-0"
        text="Assistant reply"
        isEditing={false}
        showActions={true}
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
      <EditableAssistantMessage
        messageId="assistant-1"
        partIndex={0}
        partKey="assistant-1-0"
        text="Assistant reply"
        isEditing={false}
        showActions={true}
        onStartEdit={vi.fn()}
        onCancelEdit={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    await user.tab();

    expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();
  });
});
