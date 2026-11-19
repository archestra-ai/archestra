import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog";
import { MultiSelectCombobox } from "./multi-select-combobox";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Guards the dialog scroll fix against switching dialog popovers to Radix
// modal mode, which hid and blocked the anchored input.
it("keeps an anchored input accessible and editable while its dialog popover is open", async () => {
  const user = userEvent.setup();
  render(<PickerDialog />);
  await user.click(screen.getByRole("textbox", { name: "Search options" }));
  await screen.findByRole("option", { name: "Image" });
  const input = screen.getByRole("textbox", { name: "Search options" });
  expect(input).toHaveFocus();

  await user.type(input, "Image");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await user.click(screen.getByRole("option", { name: "Image" }));
  expect(input).toHaveFocus();
  expect(input).toHaveValue("");
  await user.click(
    screen.getByRole("button", { name: "Remove selected option" }),
  );
  expect(
    screen.queryByRole("button", { name: "Remove selected option" }),
  ).not.toBeInTheDocument();

  await user.click(input);
  await user.type(input, "Video");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: "Video" })).toBeVisible();
});

function PickerDialog() {
  const [value, setValue] = useState<string[]>([]);
  return (
    <Dialog defaultOpen>
      <DialogContent>
        <DialogTitle>Choose modalities</DialogTitle>
        <DialogDescription>Choose accepted formats.</DialogDescription>
        <MultiSelectCombobox
          options={[
            { value: "image", label: "Image" },
            { value: "video", label: "Video" },
          ]}
          value={value}
          onChange={setValue}
        />
      </DialogContent>
    </Dialog>
  );
}
