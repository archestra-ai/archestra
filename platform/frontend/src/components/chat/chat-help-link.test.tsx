import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatHelpLink } from "./chat-help-link";

describe("ChatHelpLink", () => {
  it("renders nothing when no URL is configured", () => {
    const { container } = render(<ChatHelpLink url={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders an external help link when configured", () => {
    render(<ChatHelpLink url="https://support.example.com/help" />);

    const link = screen.getByRole("link", { name: /Help Center/i });
    expect(link).toHaveAttribute("href", "https://support.example.com/help");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders a custom label when provided", () => {
    render(
      <ChatHelpLink
        url="https://support.example.com/help"
        label="Docs & Support"
      />,
    );

    expect(
      screen.getByRole("link", { name: /Docs & Support/i }),
    ).toBeInTheDocument();
  });
});
