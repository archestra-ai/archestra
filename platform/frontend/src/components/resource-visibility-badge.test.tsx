import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResourceVisibilityBadge } from "./resource-visibility-badge";

const ME = "user-me";

describe("ResourceVisibilityBadge", () => {
  it("hides the badge for the current user's own personal resource by default", () => {
    const { container } = render(
      <ResourceVisibilityBadge
        scope="personal"
        teams={[]}
        authorId={ME}
        authorName="My Name"
        currentUserId={ME}
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
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
