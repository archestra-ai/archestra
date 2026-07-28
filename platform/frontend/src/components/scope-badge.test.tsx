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
  it("says an app is shared, not Personal, when it has individual grants", () => {
    // An app shared with named people is stored as `personal` plus grants, so
    // reading the scope literally labelled a shared app "Personal" — the exact
    // confusion this pill exists to settle.
    render(<ScopeBadge scope="personal" userNames={["Joey"]} />);
    expect(screen.getByLabelText("Shared with: Joey")).toBeInTheDocument();
    expect(screen.queryByLabelText("Personal")).not.toBeInTheDocument();
  });

  it("lists every person the app is shared with", () => {
    render(<ScopeBadge scope="personal" userNames={["Ada", "Grace"]} />);
    expect(
      screen.getByLabelText("Shared with: Ada, Grace"),
    ).toBeInTheDocument();
  });

  it("still reads Personal when the grant list is empty", () => {
    render(<ScopeBadge scope="personal" userNames={[]} />);
    expect(screen.getByLabelText("Personal")).toBeInTheDocument();
  });

  it("keeps a shared app visible even when hidePersonal is set", () => {
    // hidePersonal hides *private* apps; a shared one still needs its pill.
    render(<ScopeBadge scope="personal" userNames={["Joey"]} hidePersonal />);
    expect(screen.getByLabelText("Shared with: Joey")).toBeInTheDocument();
  });
});
