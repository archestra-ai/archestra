import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePublicConfig } from "@/lib/config/config.query";
import {
  EnvSiteNotificationBar,
  SiteNotificationBar,
} from "./site-notification-bar";

vi.mock("@/lib/config/config.query");

function mockPublicConfig(siteNotificationMessage: string | null) {
  vi.mocked(usePublicConfig).mockReturnValue({
    data: { siteNotificationMessage },
  } as ReturnType<typeof usePublicConfig>);
}

describe("SiteNotificationBar", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("dismisses the current notification and persists that choice", async () => {
    const user = userEvent.setup();

    render(
      <SiteNotificationBar
        content="Maintenance starts soon"
        notificationId="notification-1"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );

    expect(
      screen.queryByText("Maintenance starts soon"),
    ).not.toBeInTheDocument();
    expect(
      localStorage.getItem("site-notification-dismissed:notification-1"),
    ).toBe("true");
  });

  it("shows a new notification after dismissing a previous notification", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SiteNotificationBar content="First announcement" notificationId="one" />,
    );

    await user.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );

    rerender(
      <SiteNotificationBar
        content="Second announcement"
        notificationId="two"
      />,
    );

    expect(screen.getByText("Second announcement")).toBeInTheDocument();
  });

  it("renders the env-driven banner and re-shows it when the message changes after dismissal", async () => {
    const user = userEvent.setup();
    mockPublicConfig("Parallel staging stack");

    const { rerender } = render(<EnvSiteNotificationBar />);
    expect(screen.getByText("Parallel staging stack")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(
      screen.queryByText("Parallel staging stack"),
    ).not.toBeInTheDocument();

    mockPublicConfig("New message");
    rerender(<EnvSiteNotificationBar />);
    expect(screen.getByText("New message")).toBeInTheDocument();
  });

  it("renders nothing when the env message is not set", () => {
    mockPublicConfig(null);
    const { container } = render(<EnvSiteNotificationBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders markdown headings and links", () => {
    render(
      <SiteNotificationBar
        content="# Maintenance [details](https://example.com)"
        notificationId="markdown"
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Maintenance details",
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "details" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
  });
});
