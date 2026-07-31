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

  it("finds an item whose stored order differs from the typed one", async () => {
    const user = userEvent.setup();

    render(
      <SearchableSelect
        value=""
        onValueChange={vi.fn()}
        placeholder="Select a user"
        items={[
          {
            value: "u-ada",
            label: "Lovelace, Ada M.",
            searchText: "Lovelace, Ada M. ada@example.com",
          },
          {
            value: "u-charles",
            label: "Babbage, Charles",
            searchText: "Babbage, Charles charles@example.com",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search..."), "Ada Lovelace");

    expect(
      screen.getByRole("button", { name: /Lovelace, Ada M./i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Babbage, Charles/i }),
    ).not.toBeInTheDocument();
  });

  it("narrows rather than widens when another token is typed", async () => {
    const user = userEvent.setup();

    render(
      <SearchableSelect
        value=""
        onValueChange={vi.fn()}
        placeholder="Select a user"
        items={[
          { value: "u-ada", label: "Lovelace, Ada M." },
          { value: "u-charles", label: "Babbage, Charles" },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search..."), "Ada Babbage");

    expect(
      screen.queryByRole("button", { name: /Lovelace, Ada M./i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Babbage, Charles/i }),
    ).not.toBeInTheDocument();
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
