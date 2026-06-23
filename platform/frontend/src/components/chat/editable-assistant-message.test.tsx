import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditableAssistantMessage } from "./editable-assistant-message";

const baseProps = {
  messageId: "message-1",
  partIndex: 0,
  partKey: "part-1",
  text: "original",
  showActions: false,
  onStartEdit: vi.fn(),
  onCancelEdit: vi.fn(),
};

describe("EditableAssistantMessage edit mode", () => {
  it("renders the Save button and Info banner copy", () => {
    render(
      <EditableAssistantMessage
        {...baseProps}
        isEditing
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(
      screen.getByText(/Edit to correct errors or refine the context/),
    ).toBeInTheDocument();
  });

  it("saves on Enter", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableAssistantMessage {...baseProps} isEditing onSave={onSave} />,
    );

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("message-1", 0, "original");
  });

  it("does not save on Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableAssistantMessage {...baseProps} isEditing onSave={onSave} />,
    );

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(onSave).not.toHaveBeenCalled();
  });

  it("cancels on Escape", async () => {
    const user = userEvent.setup();
    const onCancelEdit = vi.fn();
    render(
      <EditableAssistantMessage
        {...baseProps}
        isEditing
        onCancelEdit={onCancelEdit}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.keyboard("{Escape}");

    expect(onCancelEdit).toHaveBeenCalledOnce();
  });

  it("does not save when text is empty", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditableAssistantMessage
        {...baseProps}
        text=""
        isEditing
        onSave={onSave}
      />,
    );

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.keyboard("{Enter}");

    expect(onSave).not.toHaveBeenCalled();
  });
});
