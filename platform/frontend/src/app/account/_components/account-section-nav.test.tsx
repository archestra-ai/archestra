import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountSectionNav } from "./account-section-nav";

const { usePathname } = vi.hoisted(() => ({ usePathname: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname }));
vi.mock("@/lib/config/config.query", () => ({ useFeature: () => true }));

describe("AccountSectionNav", () => {
  it("links every section to its own route", () => {
    usePathname.mockReturnValue("/account");
    render(<AccountSectionNav />);

    expect(screen.getByRole("link", { name: "API Keys" })).toHaveAttribute(
      "href",
      "/account/api-keys",
    );
    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/account/sessions",
    );
    expect(screen.getByRole("link", { name: "Connections" })).toHaveAttribute(
      "href",
      "/account/connections",
    );
  });

  it("marks only the section matching the pathname as the current page", () => {
    usePathname.mockReturnValue("/account/sessions");
    render(<AccountSectionNav />);

    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Every href starts with "/account", so the index must not also light up.
    expect(screen.getByRole("link", { name: "Profile" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("treats the bare /account path as Profile", () => {
    usePathname.mockReturnValue("/account");
    render(<AccountSectionNav />);

    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
