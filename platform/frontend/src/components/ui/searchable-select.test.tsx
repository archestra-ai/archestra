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

    const disabledItem = screen.getByRole("option", {
      name: /Already Added/i,
    });
    expect(disabledItem).toBeDisabled();

    await user.click(disabledItem);
    expect(onValueChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("option", { name: /Available User/i }));
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
      screen.getByRole("option", { name: /Lovelace, Ada M./i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Babbage, Charles/i }),
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
      screen.queryByRole("option", { name: /Lovelace, Ada M./i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Babbage, Charles/i }),
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
  it("selects the first enabled match with Arrow Down then Enter", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <SearchableSelect
        value=""
        onValueChange={onValueChange}
        placeholder="Select a model"
        items={[
          {
            value: "legacy-haiku",
            label: "Claude Haiku Legacy",
            disabled: true,
          },
          { value: "haiku", label: "Claude Haiku" },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search..."), "haiku");
    await user.keyboard("{ArrowDown}");

    expect(screen.getByPlaceholderText("Search...")).toHaveFocus();
    expect(screen.getByPlaceholderText("Search...")).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Claude Haiku" }).id,
    );

    await user.keyboard("{Enter}");

    expect(onValueChange).toHaveBeenCalledWith("haiku");
  });
});
