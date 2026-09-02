import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExternalDocsLink } from "./external-docs-link";

describe("ExternalDocsLink", () => {
  // The anchor's display mode is the layout contract here, not incidental
  // styling: an `inline-flex` anchor is an *atomic* inline box, so it refuses
  // to wrap mid-phrase and leaves a line-break opportunity immediately after
  // itself. Inside prose that strands the text following the link — most
  // visibly a trailing period, which ends up alone on the next line. jsdom has
  // no layout engine, so the display mode is the closest assertable proxy.
  describe("prose links (no trailing icon)", () => {
    it("renders the anchor as a plain inline box so it wraps with the sentence", () => {
      render(
        <ExternalDocsLink href="https://example.com/docs" showIcon={false}>
          Atlassian account security
        </ExternalDocsLink>,
      );

      const link = screen.getByRole("link", {
        name: /atlassian account security/i,
      });
      expect(link).toHaveClass("inline");
      expect(link).not.toHaveClass("inline-flex");
    });

    it("renders no icon", () => {
      const { container } = render(
        <ExternalDocsLink href="https://example.com/docs" showIcon={false}>
          Learn more
        </ExternalDocsLink>,
      );

      expect(container.querySelector("svg")).toBeNull();
    });
  });

  describe("standalone links (with trailing icon)", () => {
    it("keeps the flex layout that holds the icon beside the label", () => {
      render(
        <ExternalDocsLink href="https://example.com/docs">
          Learn more
        </ExternalDocsLink>,
      );

      const link = screen.getByRole("link", { name: /learn more/i });
      expect(link).toHaveClass("inline-flex");
      expect(link).toHaveClass("items-center");
    });
  });

  it("keeps the caller's classes winning over the base display class", () => {
    render(
      <ExternalDocsLink
        href="https://example.com/docs"
        showIcon={false}
        className="underline"
      >
        View docs
      </ExternalDocsLink>,
    );

    const link = screen.getByRole("link", { name: /view docs/i });
    expect(link).toHaveClass("underline");
    expect(link).toHaveClass("inline");
  });

  it("renders nothing when href is missing", () => {
    const { container } = render(
      <ExternalDocsLink href={null}>Learn more</ExternalDocsLink>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
