import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmailNotConfiguredMessage } from "./email-not-configured-message";

describe("EmailNotConfiguredMessage", () => {
  it("renders the default message with link to documentation", () => {
    render(<EmailNotConfiguredMessage />);

    expect(
      screen.getByText(/Email invocation of Agents is not configured/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /setup guide/i })).toHaveAttribute(
      "href",
      "https://archestra.ai/docs/platform-agents#incoming-email",
    );
  });

  it("applies custom className when provided", () => {
    render(<EmailNotConfiguredMessage className="custom-class" />);

    const paragraph = screen.getByText(
      /Email invocation of Agents is not configured/,
    );
    expect(paragraph).toHaveClass("custom-class");
  });

  it("applies default className when not provided", () => {
    render(<EmailNotConfiguredMessage />);

    const paragraph = screen.getByText(
      /Email invocation of Agents is not configured/,
    );
    expect(paragraph).toHaveClass("text-sm", "text-muted-foreground");
  });

  it("opens documentation link in new tab", () => {
    render(<EmailNotConfiguredMessage />);

    const link = screen.getByRole("link", { name: /setup guide/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
