import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "@/components/ui/badge";
import { AgentNameCell } from "./agent-name-cell";

describe("AgentNameCell", () => {
  it("renders the name with metadata on a separate row", () => {
    const { container } = render(
      <AgentNameCell
        name="My Assistant"
        scope="personal"
        labels={[{ key: "team", value: "support" }]}
      />,
    );

    expect(screen.getByText("My Assistant")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();

    const contentRows = container.firstElementChild?.firstElementChild;
    expect(contentRows?.childElementCount).toBe(2);
    expect(contentRows?.children[1]).toHaveClass(
      "flex",
      "flex-wrap",
      "items-center",
      "gap-2",
    );
  });

  it("renders description beneath the metadata row when provided", () => {
    const { container } = render(
      <AgentNameCell
        name="My Assistant"
        scope="personal"
        description="Your personal chat assistant"
      />,
    );

    expect(
      screen.getByText("Your personal chat assistant"),
    ).toBeInTheDocument();

    const contentRows = container.firstElementChild?.firstElementChild;
    expect(contentRows?.childElementCount).toBe(3);
  });

  it("renders extra badges alongside the visibility badge", () => {
    render(
      <AgentNameCell
        name="Gateway Profile"
        scope="org"
        extraBadges={<Badge variant="outline">Profile</Badge>}
      />,
    );

    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.getByText("Profile")).toBeInTheDocument();
  });
});
