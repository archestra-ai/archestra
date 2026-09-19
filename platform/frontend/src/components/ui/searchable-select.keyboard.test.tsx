import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SearchableMultiSelect } from "@/components/searchable-multi-select";
import { useListboxNavigation } from "@/lib/hooks/use-listbox-navigation";
import { SearchableSelect } from "./searchable-select";

const items = [
  { value: "alpha", label: "Alpha" },
  { value: "blocked", label: "Blocked", disabled: true },
  { value: "beta", label: "Beta" },
];

function Picker({
  multiple,
  choices = items,
  onChange = () => {},
}: {
  multiple: boolean;
  choices?: typeof items;
  onChange?: (value: string | string[]) => void;
}) {
  const [single, setSingle] = useState("");
  const [multi, setMulti] = useState<string[]>([]);
  return multiple ? (
    <SearchableMultiSelect
      ariaLabel="Picker"
      items={choices}
      value={multi}
      onValueChange={(value) => {
        setMulti(value);
        onChange(value);
      }}
    />
  ) : (
    <SearchableSelect
      ariaLabel="Picker"
      items={choices}
      value={single}
      onValueChange={(value) => {
        setSingle(value);
        onChange(value);
      }}
    />
  );
}

function expectActive(name: string) {
  expect(screen.getByRole("combobox", { name: "Search..." })).toHaveAttribute(
    "aria-activedescendant",
    screen.getByRole("option", { name }).id,
  );
}

describe.each([
  false,
  true,
])("searchable keyboard navigation (multiple=%s)", (multiple) => {
  it("wraps both ways, skips disabled choices, and selects once without losing search focus", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picker multiple={multiple} onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "Picker" });
    await user.click(trigger);
    await user.keyboard("{ArrowUp}");
    expectActive("Beta");
    await user.keyboard("{ArrowDown}");
    expectActive("Alpha");
    await user.keyboard("{ArrowDown}");
    expectActive("Beta");
    await user.keyboard("{ArrowUp}");
    expectActive("Alpha");
    expect(screen.getByPlaceholderText("Search...")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      multiple ? ["alpha"] : "alpha",
    );
    if (multiple) {
      expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await user.keyboard("{Enter}");
      expect(onChange).toHaveBeenLastCalledWith([]);
      expect(screen.getByPlaceholderText("Search...")).toHaveFocus();
      await user.keyboard("{Escape}");
    }
    expect(trigger).toHaveFocus();
  });

  it("keeps typing after navigating, and replaces a stale highlight with a matching result", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picker multiple={multiple} onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: "Picker" }));
    await user.keyboard("{ArrowDown}beta");
    expect(screen.getByPlaceholderText("Search...")).toHaveValue("beta");
    expectActive("Beta");
    expect(
      screen.queryByRole("option", { name: "Alpha" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      multiple ? ["beta"] : "beta",
    );
  });

  it.each([
    { choices: [] },
    { choices: [items[1]] },
  ])("handles no enabled options: %j", async ({ choices }) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Picker multiple={multiple} choices={choices} onChange={onChange} />,
    );
    await user.click(screen.getByRole("combobox", { name: "Picker" }));
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Search...")).not.toHaveAttribute(
      "aria-activedescendant",
    );
  });

  it("recovers when async results disable or remove the highlighted option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <Picker multiple={multiple} onChange={onChange} />,
    );
    await user.click(screen.getByRole("combobox", { name: "Picker" }));
    await user.keyboard("{ArrowDown}");
    expectActive("Alpha");
    rerender(
      <Picker
        multiple={multiple}
        choices={[{ ...items[0], disabled: true }, items[2]]}
        onChange={onChange}
      />,
    );
    expectActive("Beta");
    rerender(<Picker multiple={multiple} choices={[]} onChange={onChange} />);
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    rerender(
      <Picker multiple={multiple} choices={[items[2]]} onChange={onChange} />,
    );
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      multiple ? ["beta"] : "beta",
    );
  });

  it("opens with arrow keys and ignores IME confirmation and modifier shortcuts", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picker multiple={multiple} onChange={onChange} />);
    screen.getByRole("combobox", { name: "Picker" }).focus();
    await user.keyboard("{ArrowUp}");
    expectActive("Beta");
    const search = screen.getByPlaceholderText("Search...");
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    fireEvent.keyDown(search, { key: "ArrowDown", isComposing: true });
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onChange).not.toHaveBeenCalled();
    expectActive("Beta");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("combobox", { name: "Picker" })).toHaveFocus();
  });
});

it("includes pinned choices while navigating filtered results", async () => {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(
    <SearchableSelect
      value=""
      items={items}
      pinnedItems={[{ value: "none", label: "Unassigned" }]}
      onValueChange={onValueChange}
    />,
  );
  await user.click(screen.getByRole("combobox"));
  await user.keyboard("beta{ArrowDown}");
  expectActive("Unassigned");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith("beta");
});

it("navigates without a search field, including Home/End and Space", async () => {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(
    <SearchableSelect
      value="alpha"
      items={items}
      showSearch={false}
      onValueChange={onValueChange}
    />,
  );
  await user.click(screen.getByRole("combobox"));
  const list = screen.getByRole("listbox");
  expect(list).toHaveFocus();
  await user.keyboard("{End}{Home}{ArrowDown} ");
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith("beta");
});

it.each([
  true,
  false,
])("handles custom text versus a navigated existing choice: %s", async (navigate) => {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(
    <SearchableSelect
      value="alpha"
      items={items}
      allowCustom
      onValueChange={onValueChange}
    />,
  );
  await user.click(screen.getByRole("combobox"));
  await user.keyboard("alp");
  if (navigate) await user.keyboard("{ArrowDown}");
  await user.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith(
    navigate ? "alpha" : "alp",
  );
});

it("respects min/max selections and skips newly disabled choices", async () => {
  const user = userEvent.setup();
  function LimitedPicker() {
    const [value, setValue] = useState(["alpha"]);
    return (
      <SearchableMultiSelect
        value={value}
        onValueChange={setValue}
        items={items}
        minSelected={1}
        maxSelected={2}
      />
    );
  }
  render(<LimitedPicker />);
  await user.click(screen.getByRole("combobox"));
  expect(screen.getByRole("option", { name: "Alpha" })).toBeDisabled();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(screen.getByRole("option", { name: "Beta" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.keyboard("{ArrowUp}{Enter}");
  expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  expect(screen.getByRole("option", { name: "Beta" })).toBeDisabled();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("does not turn ancillary row buttons into keyboard-selectable options", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const onEdit = vi.fn();
  function PickerWithActions() {
    const navigation = useListboxNavigation({
      open: true,
      onOpenChange: vi.fn(),
      values: ["alpha", "beta"],
      onSelect,
    });
    return (
      <>
        <input aria-label="Search" {...navigation.inputProps} />
        <div {...navigation.listboxProps} role="listbox" aria-label="Choices">
          {["alpha", "beta"].map((value) => (
            <div key={value}>
              <button
                {...navigation.getOptionProps(value)}
                type="button"
                role="option"
                aria-selected={false}
              >
                {value}
              </button>
              <button type="button" onClick={onEdit}>
                Edit {value}
              </button>
            </div>
          ))}
        </div>
      </>
    );
  }
  render(<PickerWithActions />);
  screen.getByRole("combobox", { name: "Search" }).focus();
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("beta");
  await user.tab();
  expect(screen.getByRole("button", { name: "Edit alpha" })).toHaveFocus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onEdit).toHaveBeenCalledExactlyOnceWith(expect.anything());
  expect(onSelect).toHaveBeenCalledTimes(1);
});
