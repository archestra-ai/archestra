import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ChatLinkButton,
  MOBILE_HEADER_ACTIONS_CONTAINER_ID,
  MobileHeaderChatLinks,
} from "./chat-help-link";

// Pass-through dropdown mock so the collapsed menu's items are assertable
// without driving Radix portals in jsdom.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

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

describe("MobileHeaderChatLinks", () => {
  function renderWithHeaderSlot(ui: ReactNode) {
    const slot = document.createElement("div");
    slot.id = MOBILE_HEADER_ACTIONS_CONTAINER_ID;
    document.body.appendChild(slot);
    const result = render(ui);
    return {
      ...result,
      slot,
      cleanupSlot: () => slot.remove(),
    };
  }

  it("renders nothing when there are no links with a URL", () => {
    const { slot, cleanupSlot } = renderWithHeaderSlot(
      <MobileHeaderChatLinks links={[{ label: "Broken", url: null }]} />,
    );

    expect(slot).toBeEmptyDOMElement();
    cleanupSlot();
  });

  it("portals a single link into the header slot as a direct button", () => {
    const { slot, cleanupSlot } = renderWithHeaderSlot(
      <MobileHeaderChatLinks
        links={[{ label: "Help Channel", url: "https://help.example.com" }]}
      />,
    );

    const link = screen.getByRole("link", { name: /Help Channel/i });
    expect(slot.contains(link)).toBe(true);
    expect(link).toHaveAttribute("href", "https://help.example.com");
    expect(link).toHaveAttribute("target", "_blank");
    cleanupSlot();
  });

  it("collapses multiple links into a help menu in the header slot", () => {
    const { slot, cleanupSlot } = renderWithHeaderSlot(
      <MobileHeaderChatLinks
        links={[
          { label: "Help Channel", url: "https://help.example.com" },
          { label: "Docs", url: "https://docs.example.com" },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Help and support/i });
    expect(slot.contains(trigger)).toBe(true);

    const helpLink = screen.getByRole("link", { name: /Help Channel/i });
    const docsLink = screen.getByRole("link", { name: /Docs/i });
    expect(helpLink).toHaveAttribute("href", "https://help.example.com");
    expect(docsLink).toHaveAttribute("href", "https://docs.example.com");
    cleanupSlot();
  });
});
