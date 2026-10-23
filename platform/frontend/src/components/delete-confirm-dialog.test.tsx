import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("holds the confirm button for the cooldown after opening", () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      render(
        <DeleteConfirmDialog
          open
          onOpenChange={vi.fn()}
          title="Delete API Key"
          description="The virtual key below will be deleted too."
          isPending={false}
          onConfirm={onConfirm}
          confirmLabel="Delete API Key"
          confirmDelayMs={3000}
        />,
      );

      const confirm = screen.getByRole("button", { name: "Delete API Key" });
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      expect(onConfirm).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2999);
      });
      expect(confirm).toBeDisabled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
