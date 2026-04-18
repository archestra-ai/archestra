import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExternalDocsLink } from "./external-docs-link";

describe("ExternalDocsLink", () => {
  it("renders an external link when href is provided", () => {
    render(
      <ExternalDocsLink href="https://example.com/docs">
        Learn more
      </ExternalDocsLink>,
    );

    expect(screen.getByRole("link", { name: /learn more/i })).toHaveAttribute(
      "href",
      "https://example.com/docs",
    );
  });

  it("renders nothing when href is missing", () => {
    const { container } = render(
      <ExternalDocsLink href={null}>Learn more</ExternalDocsLink>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
