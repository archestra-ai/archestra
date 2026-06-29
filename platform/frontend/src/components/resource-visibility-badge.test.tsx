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
