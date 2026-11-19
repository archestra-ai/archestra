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

describe("EditableAssistantMessage actions", () => {
  it("hides edit on a read-only transcript", () => {
    const { onStartEdit: _onStartEdit, ...readOnlyProps } = baseProps;
    render(
      <EditableAssistantMessage
        {...readOnlyProps}
        showActions
        isEditing={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

describe("EditableAssistantMessage policy previews", () => {
  const text = "Explanation.\n\n```diff\n-old\n+new\n```";
  const policyDiffReferences = [
    {
      before: "old",
      after: "new",
      path: "organization.appa.toml",
      changes: JSON.stringify(["-old", "+new"]),
    },
  ];

  it("shows the explanation once and retains the original diff when editing", () => {
    const props = {
      ...baseProps,
      text,
      policyDiffReferences,
      onSave: vi.fn(),
    };
    const { rerender } = render(
      <EditableAssistantMessage {...props} isEditing={false} />,
    );
    expect(screen.getByText("Explanation.")).toBeInTheDocument();
    expect(screen.queryByText(/-old/)).toBeNull();

    rerender(<EditableAssistantMessage {...props} isEditing />);
    expect(screen.getByRole("textbox")).toHaveValue(text);
  });

  it("does not leave an empty bubble when the whole part repeats a preview", () => {
    const { container } = render(
      <EditableAssistantMessage
        {...baseProps}
        text={"```diff\n-old\n+new\n```"}
        policyDiffReferences={policyDiffReferences}
        isEditing={false}
        onSave={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps copy, edit and feedback reachable when the final part repeats a preview", async () => {
    const user = userEvent.setup();
    const rawText = "```diff\n-old\n+new\n```";
    const onStartEdit = vi.fn();
    const onFeedbackChange = vi.fn();
    const props = {
      ...baseProps,
      text: rawText,
      policyDiffReferences,
      showActions: true,
      onStartEdit,
      onFeedbackChange,
      onSave: vi.fn(),
    };
    const { rerender } = render(
      <EditableAssistantMessage {...props} isEditing={false} />,
    );
    expect(screen.queryByText(/-old/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(rawText);
    await user.click(screen.getByRole("button", { name: "Good response" }));
    expect(onFeedbackChange).toHaveBeenCalledWith("message-1", "up");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onStartEdit).toHaveBeenCalledWith("part-1");
    rerender(<EditableAssistantMessage {...props} isEditing />);
    expect(screen.getByRole("textbox")).toHaveValue(rawText);
  });
});
