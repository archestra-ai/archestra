import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectableFileList } from "./selectable-file-list";

const sections = [
  {
    title: "First",
    items: [
      file("one", "one.txt"),
      file("artifact", "artifact.txt", ""),
      file("two", "two.txt"),
    ],
  },
  {
    title: "Second",
    items: [file("three", "three.txt"), file("four", "four.txt")],
  },
];

describe("SelectableFileList", () => {
  it("selects a Shift range across sections without including unmanageable rows", async () => {
    renderFileList();

    await enterSelection("one.txt");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select four.txt" }), {
      shiftKey: true,
    });

    for (const name of ["one.txt", "two.txt", "three.txt", "four.txt"]) {
      expect(
        screen.getByRole("checkbox", { name: `Select ${name}` }),
      ).toBeChecked();
    }
    expect(
      screen.queryByRole("checkbox", { name: "Select artifact.txt" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("4 selected")).toBeVisible();
  });

  it("uses the menu-selected row as the anchor and deselects from a selected Shift endpoint", async () => {
    renderFileList();

    await enterSelection("three.txt");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select one.txt" }), {
      shiftKey: true,
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select two.txt" }), {
      shiftKey: true,
    });

    expect(
      screen.getByRole("checkbox", { name: "Select one.txt" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select two.txt" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select three.txt" }),
    ).toBeChecked();
    expect(screen.getByText("1 selected")).toBeVisible();
  });
});

function renderFileList() {
  render(
    <SelectableFileList
      sections={sections}
      canManage
      onOpen={vi.fn()}
      onRequestDelete={vi.fn()}
    />,
  );
}

async function enterSelection(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  await user.click(screen.getByRole("menuitem", { name: "Select" }));
}

function file(id: string, name: string, contentUrl = `/files/${id}`) {
  return {
    id,
    name,
    mimeType: "text/plain",
    contentUrl,
  };
}
