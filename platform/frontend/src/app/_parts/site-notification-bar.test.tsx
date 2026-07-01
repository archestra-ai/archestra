import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SiteNotificationBar } from "./site-notification-bar";

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
