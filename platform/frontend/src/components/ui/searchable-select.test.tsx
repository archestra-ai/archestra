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

  it("respects a custom popover side", async () => {
    const user = userEvent.setup();

    render(
      <SearchableSelect
        value=""
        onValueChange={vi.fn()}
        placeholder="Select a model"
        contentSide="top"
        items={[
          {
            value: "model-a",
            label: "Model A",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(
      screen
        .getByPlaceholderText("Search...")
        .closest("[data-slot='popover-content']"),
    ).toHaveAttribute("data-side", "top");
  });

  it("respects a custom popover alignment", async () => {
    const user = userEvent.setup();

    render(
      <SearchableSelect
        value=""
        onValueChange={vi.fn()}
        placeholder="Select a model"
        contentAlign="end"
        items={[
          {
            value: "model-a",
            label: "Model A",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(
      screen
        .getByPlaceholderText("Search...")
        .closest("[data-slot='popover-content']"),
    ).toHaveAttribute("data-align", "end");
  });

  it("applies a custom list class", async () => {
    const user = userEvent.setup();

    render(
      <SearchableSelect
        value=""
        onValueChange={vi.fn()}
        placeholder="Select a model"
        listClassName="max-h-[220px]"
        items={[
          {
            value: "model-a",
            label: "Model A",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(
      screen.getByRole("button", { name: /Model A/i }).parentElement,
    ).toHaveClass("max-h-[220px]");
  });
});
