import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PersonalResourceOwner } from "./personal-resource-owner";

describe("PersonalResourceOwner", () => {
  it("distinguishes same-named personal resources by their actual owner", () => {
    render(
      <>
        <div>
          <span>My Assistant</span>
          <PersonalResourceOwner
            resource={{
              scope: "personal",
              authorId: "current-user",
              authorEmail: "me@example.com",
            }}
            currentUserId="current-user"
          />
        </div>
        <div>
          <span>My Assistant</span>
          <PersonalResourceOwner
            resource={{
              scope: "personal",
              authorId: "other-user",
              authorEmail: "teammate@example.com",
            }}
            currentUserId="current-user"
          />
        </div>
      </>,
    );

    const names = screen.getAllByText("My Assistant");
    expect(names[0].parentElement).toHaveTextContent("Yours");
    expect(names[1].parentElement).toHaveTextContent(
      "Owned by teammate@example.com",
    );
  });

  it("identifies unavailable owners without labeling shared resources as personal", () => {
    render(
      <>
        <PersonalResourceOwner
          resource={{ scope: "personal", authorId: null }}
          currentUserId="current-user"
        />
        <PersonalResourceOwner
          resource={{
            scope: "org",
            authorId: "other-user",
            authorEmail: "teammate@example.com",
          }}
          currentUserId="current-user"
        />
      </>,
    );

    expect(screen.getByText("Owner unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/teammate@example.com/)).not.toBeInTheDocument();
  });
});
