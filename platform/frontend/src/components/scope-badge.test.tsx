import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScopeBadge } from "./scope-badge";

describe("ScopeBadge", () => {
  it("labels org and personal scopes", () => {
    render(<ScopeBadge scope="org" />);
    expect(screen.getByLabelText("Organization")).toBeInTheDocument();

    render(<ScopeBadge scope="personal" />);
    expect(screen.getByLabelText("Personal")).toBeInTheDocument();
  });

  it("folds team names into the team label", () => {
    render(<ScopeBadge scope="team" teamNames={["Design", "Engineering"]} />);
    expect(
      screen.getByLabelText("Team: Design, Engineering"),
    ).toBeInTheDocument();
  });

  it("falls back to a bare Team label when names are unknown", () => {
    render(<ScopeBadge scope="team" teamNames={null} />);
    expect(screen.getByLabelText("Team")).toBeInTheDocument();
  });

  it("renders nothing for a personal scope when hidePersonal is set", () => {
    const { container } = render(<ScopeBadge scope="personal" hidePersonal />);
    expect(container).toBeEmptyDOMElement();
  });
});
