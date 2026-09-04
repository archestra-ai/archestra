import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TeamVisibilityPicker,
  type VisibilityOption,
  VisibilitySelector,
} from "./visibility-selector";

const OPTIONS: VisibilityOption<"personal" | "team">[] = [
  {
    value: "personal",
    label: "Personal",
    description: "Only you can access this",
  },
  {
    value: "team",
    label: "Teams",
    description: "Share this with selected teams",
    disabled: true,
    disabledLabel: "No teams available",
    disabledReason: "There are no teams to share with yet.",
  },
];

function expand() {
  fireEvent.click(screen.getAllByRole("button")[0]);
}

describe("VisibilitySelector", () => {
  it("explains a disabled option in the row itself", () => {
    render(
      <VisibilitySelector
        value="personal"
        options={OPTIONS}
        onValueChange={() => {}}
      />,
    );
    expand();

    // A tooltip hides the explanation behind a hover the reader has no reason
    // to try, and mis-anchors when several rows are disabled.
    expect(screen.getByText("No teams available")).toBeInTheDocument();
    expect(
      screen.getByText("There are no teams to share with yet."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Share this with selected teams"),
    ).not.toBeInTheDocument();
  });

  it("keeps the plain description on options that can be picked", () => {
    render(
      <VisibilitySelector
        value="personal"
        options={OPTIONS}
        onValueChange={() => {}}
      />,
    );
    expand();

    expect(screen.getByText("Only you can access this")).toBeInTheDocument();
  });

  it("ignores clicks on a disabled option", () => {
    const onValueChange = vi.fn();
    render(
      <VisibilitySelector
        value="personal"
        options={OPTIONS}
        onValueChange={onValueChange}
      />,
    );
    expand();

    fireEvent.click(screen.getByText("Teams"));

    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe("TeamVisibilityPicker", () => {
  it("shows every child team that inherits access", () => {
    render(
      <TeamVisibilityPicker
        teams={[
          { id: "root", name: "Company", parentId: null },
          { id: "group", name: "Product", parentId: "root" },
          { id: "team", name: "Platform", parentId: "group" },
          { id: "other", name: "Operations", parentId: null },
        ]}
        value={["root"]}
        onChange={() => {}}
      />,
    );

    expect(
      screen.getByText("Also available to 2 child teams"),
    ).toBeInTheDocument();
    expect(screen.getByText("Product, Platform")).toBeInTheDocument();
    expect(screen.queryByText("Operations, Platform")).not.toBeInTheDocument();
  });

  it("does not count a directly selected child twice", () => {
    render(
      <TeamVisibilityPicker
        teams={[
          { id: "root", name: "Company", parentId: null },
          { id: "child", name: "Platform", parentId: "root" },
        ]}
        value={["root", "child"]}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByText(/Also available to/)).not.toBeInTheDocument();
  });

  it("shows descendant summaries when the picker only exposes direct teams", () => {
    render(
      <TeamVisibilityPicker
        teams={[
          {
            id: "root",
            name: "Company",
            parentId: null,
            descendantTeams: [
              { id: "group", name: "Product" },
              { id: "team", name: "Platform" },
            ],
          },
        ]}
        value={["root"]}
        onChange={() => {}}
      />,
    );

    expect(
      screen.getByText("Also available to 2 child teams"),
    ).toBeInTheDocument();
    expect(screen.getByText("Product, Platform")).toBeInTheDocument();
  });
});
