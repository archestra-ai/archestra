import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { usePublicConfig } from "@/lib/config/config.query";
import { HIDE_DISMISSED_SITE_NOTIFICATIONS_SCRIPT } from "@/lib/site-notification-dismissal";
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

  it("shows the text at once, as plain text, until its markdown renders", async () => {
    const { container } = render(
      <SiteNotificationBar
        content="**Maintenance** tonight, see the [status page](https://example.com/status)"
        notificationId="markdown"
      />,
    );

    // First render: the band already reads right, without markdown marks.
    expect(container).toHaveTextContent(
      "Maintenance tonight, see the status page",
    );
    expect(container).not.toHaveTextContent("**");

    expect(
      await screen.findByRole("link", { name: "status page" }),
    ).toHaveAttribute("href", "https://example.com/status");
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

  it("never shows a dismissed bar that the server rendered, and hydrates it away", async () => {
    const bar = (
      <SiteNotificationBar
        content="Maintenance tonight"
        notificationId="seeded"
      />
    );
    // The server cannot read storage, so its HTML has the bar regardless.
    const html = renderToString(bar);
    localStorage.setItem("site-notification-dismissed:seeded", "true");
    const stylesBefore = document.head.querySelectorAll("style").length;
    new Function(HIDE_DISMISSED_SITE_NOTIFICATIONS_SCRIPT)();
    const container = document.createElement("div");
    container.innerHTML = `${html}<div data-site-notification-id="other"></div>`;
    document.body.appendChild(container);
    onTestFinished(() => {
      container.remove();
      for (const style of [...document.head.querySelectorAll("style")].slice(
        stylesBefore,
      )) {
        style.remove();
      }
    });

    // Before hydration: in the document, but not painted.
    const serverBar = container.querySelector(
      '[data-site-notification-id="seeded"]',
    );
    expect(serverBar).not.toBeNull();
    expect(getComputedStyle(serverBar as Element).display).toBe("none");
    const otherBar = container.querySelector(
      '[data-site-notification-id="other"]',
    );
    expect(getComputedStyle(otherBar as Element).display).not.toBe("none");
    otherBar?.remove();

    const onRecoverableError = vi.fn();
    const root = await act(async () =>
      hydrateRoot(container, bar, { onRecoverableError }),
    );
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-site-notification-id="seeded"]'),
    ).toBeNull();

    act(() => root.unmount());
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
