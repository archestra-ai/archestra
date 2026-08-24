import { DocsPage, getDocsUrl } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmailNotConfiguredMessage } from "./email-not-configured-message";

describe("EmailNotConfiguredMessage", () => {
  it("points at the email trigger setup guide in a safely-targeted new tab", () => {
    render(<EmailNotConfiguredMessage />);

    expect(
      screen.getByText(/Email invocation of Agents is not configured/),
    ).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /setup guide/i });
    expect(link).toHaveAttribute(
      "href",
      getDocsUrl(DocsPage.PlatformAgentTriggersEmail),
    );
    // target=_blank without rel=noopener hands the docs tab a window.opener
    // handle back into the app.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
