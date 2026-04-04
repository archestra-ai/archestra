import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchableSelect } from "./searchable-select";

describe("SearchableSelect", () => {
  it("renders disabled checked items without allowing selection", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <SearchableSelect
        value=""
        onValueChange={onValueChange}
        placeholder="Select a user"
        items={[
          {
            value: "already-added",
            label: "Already Added",
            description: "already@example.com",
            disabled: true,
            checked: true,
          },
          {
            value: "available",
            label: "Available User",
            description: "available@example.com",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    const disabledItem = screen.getByRole("button", {
      name: /Already Added/i,
    });
    expect(disabledItem).toBeDisabled();

    await user.click(disabledItem);
    expect(onValueChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Available User/i }));
    expect(onValueChange).toHaveBeenCalledWith("available");
  });
});
