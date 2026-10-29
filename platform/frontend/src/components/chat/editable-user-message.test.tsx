import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditableUserMessage } from "./editable-user-message";

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

describe("EditableUserMessage actions", () => {
  const viewProps = {
    messageId: "message-1",
    partIndex: 0,
    partKey: "part-1",
    text: "original",
    isEditing: false,
    onCancelEdit: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
  };

  it("offers edit and regenerate on the owner's transcript", () => {
    render(<EditableUserMessage {...viewProps} onStartEdit={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Regenerate" }),
    ).toBeInTheDocument();
  });

  it("offers only copy on a read-only transcript", () => {
    render(<EditableUserMessage {...viewProps} />);

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
  });
});

describe("EditableUserMessage attachments", () => {
  const viewProps = {
    messageId: "message-1",
    partIndex: 0,
    partKey: "part-1",
    text: "What does this say?",
    isEditing: false,
    onCancelEdit: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
  };

  it("keeps one image per attachment when identical files swap to their saved url", () => {
    // The same image attached twice: identical inline urls while sending, then
    // one shared stored-attachment url once the saved message merges in.
    const inline = {
      url: "data:image/png;base64,iVBORw0KGgo=",
      mediaType: "image/png",
    };
    const saved = {
      url: "/api/chat/attachments/11111111-1111-4111-8111-111111111111",
      mediaType: "image/png",
    };
    const { rerender } = render(
      <EditableUserMessage {...viewProps} attachments={[inline, inline]} />,
    );
    expect(screen.getAllByRole("img")).toHaveLength(2);

    rerender(
      <EditableUserMessage {...viewProps} attachments={[saved, saved]} />,
    );

    expect(screen.getAllByRole("img")).toHaveLength(2);
  });
});
