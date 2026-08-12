import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResourceVisibilityBadge } from "./resource-visibility-badge";

const ME = "user-me";

describe("ResourceVisibilityBadge", () => {
  it("renders nothing rather than guessing when the scope is unknown", () => {
    const { container } = render(
      <ResourceVisibilityBadge
        scope={undefined}
        teams={[]}
        authorId="user-other"
        authorName="Someone"
        currentUserId={ME}
        showSelfAsMe
      />,
    );

    // Never fall through to "Team": a badge asserting the wrong audience is
    // believed, whereas a missing one gets questioned.
    expect(container).toBeEmptyDOMElement();
  });

  it("hides the badge for the current user's own personal resource when showSelfAsMe is false", () => {
    const { container } = render(
      <ResourceVisibilityBadge
        scope="personal"
        teams={[]}
        authorId={ME}
        authorName="My Name"
        currentUserId={ME}
        showSelfAsMe={false}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders 'Me' for the current user's own personal resource when showSelfAsMe is set", () => {
    render(
      <ResourceVisibilityBadge
        scope="personal"
        teams={[]}
        authorId={ME}
        authorName="My Name"
        currentUserId={ME}
        showSelfAsMe
      />,
    );

    expect(screen.getByText("Me")).toBeInTheDocument();
    expect(screen.queryByText("My Name")).not.toBeInTheDocument();
  });

  it("renders the author's name for another user's personal resource even with showSelfAsMe", () => {
    render(
      <ResourceVisibilityBadge
        scope="personal"
        teams={[]}
        authorId="user-other"
        authorName="Other Person"
        currentUserId={ME}
        showSelfAsMe
      />,
    );

    expect(screen.getByText("Other Person")).toBeInTheDocument();
    expect(screen.queryByText("Me")).not.toBeInTheDocument();
  });

  it("renders the Organization badge for org scope regardless of showSelfAsMe", () => {
    render(
      <ResourceVisibilityBadge
        scope="org"
        teams={[]}
        authorId={ME}
        authorName="My Name"
        currentUserId={ME}
        showSelfAsMe
      />,
    );

    expect(screen.getByText("Organization")).toBeInTheDocument();
  });
});

/**
 * A resource shared with named people stays `personal` and carries grants
 * beside it, so reading the scope alone attributed it to its author — which is
 * exactly the question an "Accessible to" column exists to answer.
 */
describe("ResourceVisibilityBadge per-user shares", () => {
  it("names the grantees without one pill each", () => {
    render(
      <ResourceVisibilityBadge
        scope="personal"
        teams={[]}
        users={[
          { id: "u1", name: "Ada Lovelace" },
          { id: "u2", name: "Grace Hopper" },
        ]}
        authorId={ME}
        authorName="My Name"
        currentUserId={ME}
        showSelfAsMe
      />,
    );

    // A share with ten people must not become ten pills in a table cell.
    expect(
      screen.getByLabelText("Shared with: Ada Lovelace, Grace Hopper"),
    ).toBeInTheDocument();
    expect(screen.getByText("Me")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("still shows a shared resource when the owner's own badge is hidden", () => {
    render(
      <ResourceVisibilityBadge
        scope="personal"
        teams={[]}
        users={[{ id: "u1", name: "Ada Lovelace" }]}
        authorId={ME}
        authorName="My Name"
        currentUserId={ME}
        showSelfAsMe={false}
      />,
    );

    // Blank would claim the resource reaches nobody but its author.
    expect(
      screen.getByLabelText("Shared with: Ada Lovelace"),
    ).toBeInTheDocument();
  });

  it("leaves an unshared personal resource exactly as it was", () => {
    const { container } = render(
      <ResourceVisibilityBadge
        scope="personal"
        teams={[]}
        users={[]}
        authorId={ME}
        authorName="My Name"
        currentUserId={ME}
        showSelfAsMe={false}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe("ResourceVisibilityBadge compact team scope", () => {
  const TEAMS = [
    { id: "t1", name: "Engineering" },
    { id: "t2", name: "Consultants" },
  ];

  it("names the scope instead of listing every team", () => {
    render(
      <ResourceVisibilityBadge
        scope="team"
        teams={TEAMS}
        authorId="user-other"
        authorName="Someone"
        currentUserId={ME}
        showSelfAsMe
        compact
      />,
    );

    // One pill carrying the count, not one pill per team — a card's metadata
    // row has a single line to spend and the roster is not what it answers.
    expect(screen.getByText("2 teams")).toBeInTheDocument();
    expect(screen.queryByText("Engineering")).not.toBeInTheDocument();
    expect(screen.queryByText("Consultants")).not.toBeInTheDocument();
  });

  it("keeps the team names reachable on the collapsed pill", () => {
    render(
      <ResourceVisibilityBadge
        scope="team"
        teams={TEAMS}
        authorId="user-other"
        authorName="Someone"
        currentUserId={ME}
        showSelfAsMe
        compact
      />,
    );

    expect(screen.getByTitle("Engineering, Consultants")).toBeInTheDocument();
  });

  it("still lists the teams when not compact", () => {
    render(
      <ResourceVisibilityBadge
        scope="team"
        teams={TEAMS}
        authorId="user-other"
        authorName="Someone"
        currentUserId={ME}
        showSelfAsMe
      />,
    );

    // The "Accessible to" column is asking exactly who, so it still enumerates.
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Consultants")).toBeInTheDocument();
  });
});
