import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatLinkButton } from "./chat-help-link";

describe("ChatLinkButton", () => {
  it("renders nothing when no URL is configured", () => {
    const { container } = render(<ChatLinkButton url={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders an external chat link when configured", () => {
    render(<ChatLinkButton url="https://support.example.com/help" />);

    const link = screen.getByRole("link", { name: /Open Link/i });
    expect(link).toHaveAttribute("href", "https://support.example.com/help");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders a custom label when provided", () => {
    render(
      <ChatLinkButton
        url="https://support.example.com/help"
        label="Docs & Support"
      />,
    );

    expect(
      screen.getByRole("link", { name: /Docs & Support/i }),
    ).toBeInTheDocument();
  });
});
