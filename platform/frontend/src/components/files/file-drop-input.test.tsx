import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { FileDropInput } from "./file-drop-input";

test("the whole file drop area opens the picker and still accepts dropped files", () => {
  const onFiles = vi.fn();
  render(
    <FileDropInput accept=".txt" typesLabel="Text files" onFiles={onFiles} />,
  );

  const input = screen.getByLabelText("Choose documents to upload");
  const openPicker = vi.spyOn(input, "click");
  fireEvent.click(screen.getByText("Text files"));
  expect(openPicker).toHaveBeenCalledOnce();

  const file = new File(["notes"], "notes.txt", { type: "text/plain" });
  fireEvent.drop(screen.getByRole("button"), {
    dataTransfer: { files: [file] },
  });
  expect(onFiles).toHaveBeenCalledWith([file]);
});
