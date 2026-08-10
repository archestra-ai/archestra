import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "./assignment-combobox";

// Radix Popper / floating-ui needs ResizeObserver as a real constructor
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix Popper needs getBoundingClientRect to return real values
const rectStub = () => ({
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  top: 0,
  right: 100,
  bottom: 20,
  left: 0,
  toJSON: () => {},
});
Element.prototype.getBoundingClientRect =
  Element.prototype.getBoundingClientRect ?? rectStub;

// DOMRect polyfill for floating-ui
if (typeof globalThis.DOMRect === "undefined") {
  globalThis.DOMRect = class DOMRect {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    top = 0;
    right = 0;
    bottom = 0;
    left = 0;
    toJSON() {}
    static fromRect() {
      return new DOMRect();
    }
  } as unknown as typeof globalThis.DOMRect;
}

const items: AssignmentComboboxItem[] = [
  { id: "a", name: "Alpha", description: "First server" },
  { id: "b", name: "Beta", description: "Second server" },
  { id: "c", name: "Gamma", badge: "3 tools" },
  {
    id: "d",
    name: "Disabled",
    disabled: true,
    disabledReason: "Not installed",
  },
];

async function openDropdown(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("button", { name: /add/i });
  await user.click(trigger);
}

describe("AssignmentCombobox", () => {
  describe("onItemAdded callback", () => {
    it("calls onItemAdded when toggling on an unselected item", async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();
      const onItemAdded = vi.fn();

      render(
        <AssignmentCombobox
          items={items}
          selectedIds={[]}
          onToggle={onToggle}
          onItemAdded={onItemAdded}
        />,
      );

      await openDropdown(user);

      const alphaItem = screen.getByRole("menuitemcheckbox", {
        name: /alpha/i,
      });
      await user.click(alphaItem);

      expect(onToggle).toHaveBeenCalledWith("a");
      expect(onItemAdded).toHaveBeenCalledWith("a");
    });

    it("does NOT call onItemAdded when toggling off an already-selected item", async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();
      const onItemAdded = vi.fn();

      render(
        <AssignmentCombobox
          items={items}
          selectedIds={["a"]}
          onToggle={onToggle}
          onItemAdded={onItemAdded}
        />,
      );

      await openDropdown(user);

      const alphaItem = screen.getByRole("menuitemcheckbox", {
        name: /alpha/i,
      });
      await user.click(alphaItem);

      expect(onToggle).toHaveBeenCalledWith("a");
      expect(onItemAdded).not.toHaveBeenCalled();
    });

    it("works without onItemAdded (optional callback)", async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();

      render(
        <AssignmentCombobox
          items={items}
          selectedIds={[]}
          onToggle={onToggle}
        />,
      );

      await openDropdown(user);

      const betaItem = screen.getByRole("menuitemcheckbox", {
        name: /beta/i,
      });
      await user.click(betaItem);

      expect(onToggle).toHaveBeenCalledWith("b");
    });
  });

  describe("dropdown close behavior", () => {
    it("closes dropdown after selecting a new item", async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();

      render(
        <AssignmentCombobox
          items={items}
          selectedIds={[]}
          onToggle={onToggle}
        />,
      );

      await openDropdown(user);

      // Dropdown should be open
      expect(
        screen.getByRole("menuitemcheckbox", { name: /alpha/i }),
      ).toBeInTheDocument();

      await user.click(
        screen.getByRole("menuitemcheckbox", { name: /alpha/i }),
      );

      // Dropdown should close — items should no longer be visible
      expect(
        screen.queryByRole("menuitemcheckbox", { name: /alpha/i }),
      ).not.toBeInTheDocument();
    });

    it("keeps dropdown open after deselecting an item", async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();

      render(
        <AssignmentCombobox
          items={items}
          selectedIds={["a", "b"]}
          onToggle={onToggle}
        />,
      );

      await openDropdown(user);

      await user.click(
        screen.getByRole("menuitemcheckbox", { name: /alpha/i }),
      );

      // Dropdown should stay open — other items still visible
      expect(
        screen.getByRole("menuitemcheckbox", { name: /beta/i }),
      ).toBeInTheDocument();
    });
  });

  describe("search ranking", () => {
    it("ranks name matches ahead of description-only matches", async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();

      render(
        <AssignmentCombobox
          items={[
            {
              id: "description-only",
              name: "Notifications",
              description: "GitHub server for issue tracking",
            },
            {
              id: "name-match",
              name: "GitHub",
              description: "Remote MCP server",
            },
          ]}
          selectedIds={[]}
          onToggle={onToggle}
        />,
      );

      await openDropdown(user);
      await user.type(screen.getByPlaceholderText("Search..."), "git");

      const menuItems = screen.getAllByRole("menuitemcheckbox");
      expect(menuItems[0]).toHaveTextContent("GitHub");
      expect(menuItems[1]).toHaveTextContent("Notifications");
    });
  });

  describe("sort rank", () => {
    it("keeps higher-ranked unselected items ahead of alphabetical order", async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();

      render(
        <AssignmentCombobox
          items={[
            {
              id: "github",
              name: "GitHub",
            },
            {
              id: "builtin",
              name: "Sparky",
              sortRank: 1,
            },
          ]}
          selectedIds={[]}
          onToggle={onToggle}
        />,
      );

      await openDropdown(user);

      const menuItems = screen.getAllByRole("menuitemcheckbox");
      expect(menuItems[0]).toHaveTextContent("Sparky");
      expect(menuItems[1]).toHaveTextContent("GitHub");
    });
  });

  describe("onSearchChange callback", () => {
    it("reports the query so a caller can fetch beyond the loaded page", async () => {
      // The local filter only ever sees `items`. A caller holding one page of a
      // larger catalog needs the raw query to widen it, or a search for
      // anything unloaded reads as "no results" rather than "not loaded".
      const user = userEvent.setup();
      const onSearchChange = vi.fn();

      render(
        <AssignmentCombobox
          items={items}
          selectedIds={[]}
          onToggle={vi.fn()}
          onSearchChange={onSearchChange}
        />,
      );

      await openDropdown(user);
      await user.type(screen.getByRole("textbox"), "alp");

      expect(onSearchChange).toHaveBeenLastCalledWith("alp");
    });

    it("reports the reset when the dropdown closes", async () => {
      // The internal query is cleared on close, so a caller that fetched for it
      // must hear about that too — otherwise the widened set outlives the
      // search that justified it.
      const user = userEvent.setup();
      const onSearchChange = vi.fn();

      render(
        <AssignmentCombobox
          items={items}
          selectedIds={[]}
          onToggle={vi.fn()}
          onSearchChange={onSearchChange}
        />,
      );

      await openDropdown(user);
      await user.type(screen.getByRole("textbox"), "alp");
      await user.keyboard("{Escape}");

      expect(onSearchChange).toHaveBeenLastCalledWith("");
    });
  });

  describe("pending search", () => {
    it("says it is searching rather than that nothing matched", async () => {
      // A caller that answers `onSearchChange` with a debounced request holds
      // only the previous page meanwhile. Calling that "No items found." is how
      // a user concludes a record they can see elsewhere does not exist.
      const user = userEvent.setup();

      render(
        <AssignmentCombobox
          items={items}
          selectedIds={[]}
          onToggle={vi.fn()}
          isSearching
          emptyMessage="No skills found."
        />,
      );

      await openDropdown(user);
      await user.type(screen.getByRole("textbox"), "unloaded-skill");

      expect(screen.getByText("Searching…")).toBeInTheDocument();
      expect(screen.queryByText("No skills found.")).not.toBeInTheDocument();
    });

    it("reports no matches once the search has settled", async () => {
      const user = userEvent.setup();

      render(
        <AssignmentCombobox
          items={items}
          selectedIds={[]}
          onToggle={vi.fn()}
          isSearching={false}
          emptyMessage="No skills found."
        />,
      );

      await openDropdown(user);
      await user.type(screen.getByRole("textbox"), "unloaded-skill");

      expect(screen.getByText("No skills found.")).toBeInTheDocument();
      expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
    });
  });
});
