import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarContent, SidebarProvider } from "./sidebar";

vi.mock("@/lib/use-mobile.hook", () => ({
  useIsMobile: () => false,
}));

describe("SidebarContent", () => {
  it("does not reserve a stable scrollbar gutter on desktop", () => {
    render(
      <SidebarProvider>
        <SidebarContent>content</SidebarContent>
      </SidebarProvider>,
    );

    const content = screen
      .getByText("content")
      .closest("[data-slot='sidebar-content']");

    expect(content).toBeTruthy();
    expect(content?.className).toContain("overflow-y-auto");
    expect(content?.className).not.toContain("[scrollbar-gutter:stable]");
  });
});
