// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { PlainTextEditor } from "./plain-text-editor";

it("previews the unsaved Markdown draft and preserves it when returning to edit", async () => {
  const save = vi.fn();
  function Editor() {
    const [value, setValue] = useState("# Original");
    return (
      <PlainTextEditor
        markdown
        value={value}
        onChange={setValue}
        count={value.length}
        max={100}
        saving={false}
        onSave={() => save(value)}
        onCancel={() => {}}
      />
    );
  }
  render(<Editor />);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "# Unsaved heading\n\n**Draft text**" },
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Preview" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(
    await screen.findByRole("heading", { name: "Unsaved heading" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Edit" }), {
    button: 0,
    ctrlKey: false,
  });
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "# Unsaved heading\n\n**Draft text**",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith("# Unsaved heading\n\n**Draft text**");
});
