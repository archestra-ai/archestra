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
