import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SiteNotificationsSection } from "./site-notifications-section";

vi.mock("@/components/editor");
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));
vi.mock("@/lib/site-notification.query", () => ({
  useSiteNotification: () => ({ data: null, isLoading: false }),
  useDeleteSiteNotification: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

describe("SiteNotificationsSection", () => {
  it("shows a markdown editor and live preview together", () => {
    const onContentChange = vi.fn();

    render(
      <SiteNotificationsSection
        content="# Planned maintenance"
        expiresAt={null}
        onContentChange={onContentChange}
        onExpiresAtChange={() => {}}
        onDeleted={() => {}}
      />,
    );

    expect(screen.getByText("Markdown")).toBeVisible();
    expect(screen.getByText("Preview")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Planned maintenance" }),
    ).toBeVisible();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Notification content" }),
      { target: { value: "Updated notice" } },
    );
    expect(onContentChange).toHaveBeenCalledWith("Updated notice");
  });
});
