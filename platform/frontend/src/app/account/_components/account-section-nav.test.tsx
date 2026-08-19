import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountSectionNav } from "./account-section-nav";

describe("AccountSectionNav", () => {
  it("links every section to its own deep link", () => {
    render(<AccountSectionNav activeSection="profile" />);

    expect(screen.getByRole("link", { name: "API Keys" })).toHaveAttribute(
      "href",
      "/account?section=api-keys",
    );
    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/account?section=sessions",
    );
  });

  it("marks only the active section as the current page", () => {
    render(<AccountSectionNav activeSection="sessions" />);

    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Profile" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
