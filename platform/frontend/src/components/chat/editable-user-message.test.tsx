import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditableUserMessage } from "./editable-user-message";

vi.mock("@/components/chat/message-actions", () => ({
  MessageActions: () => null,
}));

vi.mock("@/components/chat/user-message-text", () => ({
  UserMessageText: ({ text }: { text: string }) => <div>{text}</div>,
}));

const attachment = {
  url: "/api/chat/attachments/11111111-1111-1111-1111-111111111111/content",
  mediaType: "text/plain",
  filename: "notes.txt",
};

describe("EditableUserMessage", () => {
  it("hides the Knowledge save action without create permission", () => {
    render(
      <EditableUserMessage
        messageId="message-1"
        partIndex={0}
        partKey="part-1"
        text="hello"
        isEditing={false}
        attachments={[attachment]}
        canPromoteAttachments={false}
        onStartEdit={vi.fn()}
        onCancelEdit={vi.fn()}
        onSave={vi.fn()}
        onPromoteAttachment={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Save to Knowledge" }),
    ).not.toBeInTheDocument();
  });

  it("shows the Knowledge save action for supported persisted attachments", async () => {
    const user = userEvent.setup();
    const onPromoteAttachment = vi.fn();

    render(
      <EditableUserMessage
        messageId="message-1"
        partIndex={0}
        partKey="part-1"
        text="hello"
        isEditing={false}
        attachments={[attachment]}
        canPromoteAttachments
        onStartEdit={vi.fn()}
        onCancelEdit={vi.fn()}
        onSave={vi.fn()}
        onPromoteAttachment={onPromoteAttachment}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save to Knowledge" }));

    expect(onPromoteAttachment).toHaveBeenCalledWith(attachment);
  });
});

const editProps = {
  messageId: "message-1",
  partIndex: 0,
  partKey: "part-1",
  text: "original",
  isEditing: true,
  onStartEdit: vi.fn(),
  onCancelEdit: vi.fn(),
};

describe("EditableUserMessage edit mode", () => {
  it("renders the Send button and regenerate-warning banner copy", () => {
    render(
      <EditableUserMessage
        {...editProps}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.getByText(/Editing this message will/)).toBeInTheDocument();
  });

  it("saves on Enter", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditableUserMessage {...editProps} onSave={onSave} />);

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("message-1", 0, "original");
  });

  it("does not save on Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditableUserMessage {...editProps} onSave={onSave} />);

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(onSave).not.toHaveBeenCalled();
  });

  it("cancels on Escape", async () => {
    const user = userEvent.setup();
    const onCancelEdit = vi.fn();
    render(
      <EditableUserMessage
        {...editProps}
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
    render(<EditableUserMessage {...editProps} text="" onSave={onSave} />);

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.keyboard("{Enter}");

    expect(onSave).not.toHaveBeenCalled();
  });
});
