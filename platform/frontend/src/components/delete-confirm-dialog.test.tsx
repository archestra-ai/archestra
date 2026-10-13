import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";

describe("DeleteConfirmDialog", () => {
  it("confirms only once the confirmation phrase is typed", () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Remove Slack bot"
        description="It stops answering."
        isPending={false}
        onConfirm={onConfirm}
        confirmLabel="Remove"
        confirmationPhrase="my_assistant"
      />,
    );

    const remove = screen.getByRole("button", { name: "Remove" });
    const input = screen.getByRole("textbox");
    expect(remove).toBeDisabled();

    fireEvent.change(input, { target: { value: "my_assist" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(remove).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "my_assistant" } });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
