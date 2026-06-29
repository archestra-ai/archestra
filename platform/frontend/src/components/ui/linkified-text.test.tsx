import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkifiedText } from "./linkified-text";

describe("LinkifiedText", () => {
  it("renders plain text without links unchanged", () => {
    render(<LinkifiedText>No links here</LinkifiedText>);
    expect(screen.getByText("No links here")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("converts an https URL to a clickable link", () => {
    render(
      <LinkifiedText>
        Visit https://github.com/settings/tokens for tokens
      </LinkifiedText>,
    );
    const link = screen.getByRole("link", {
      name: "https://github.com/settings/tokens",
    });
    expect(link).toHaveAttribute("href", "https://github.com/settings/tokens");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("converts an http URL to a clickable link", () => {
    render(<LinkifiedText>Go to http://example.com for more</LinkifiedText>);
    const link = screen.getByRole("link", {
      name: "http://example.com",
    });
    expect(link).toHaveAttribute("href", "http://example.com");
  });

  it("handles multiple URLs in the same string", () => {
    render(
      <LinkifiedText>
        See https://example.com and https://other.com for details
      </LinkifiedText>,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "https://example.com");
    expect(links[1]).toHaveAttribute("href", "https://other.com");
  });

  it("preserves surrounding text around the URL", () => {
    const { container } = render(
      <LinkifiedText>
        Create one at https://github.com/settings/tokens today
      </LinkifiedText>,
    );
    expect(container.textContent).toBe(
      "Create one at https://github.com/settings/tokens today",
    );
  });

  it("handles a string that is only a URL", () => {
    render(<LinkifiedText>https://example.com/path</LinkifiedText>);
    const link = screen.getByRole("link", {
      name: "https://example.com/path",
    });
    expect(link).toBeInTheDocument();
  });

  it("handles URL with query parameters and fragments", () => {
    render(
      <LinkifiedText>
        Go to https://example.com/page?foo=bar&baz=1#section
      </LinkifiedText>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://example.com/page?foo=bar&baz=1#section",
    );
  });

  it("stops URL at comma boundary", () => {
    render(
      <LinkifiedText>Visit https://example.com, then continue</LinkifiedText>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  it("stops URL at closing parenthesis", () => {
    render(<LinkifiedText>(see https://example.com) for info</LinkifiedText>);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com");
  });
});
