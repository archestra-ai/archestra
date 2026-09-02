import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProgressBar } from "./navigation-progress-bar";
import { NavigationStatusProvider } from "./navigation-status-provider";

vi.mock("next/navigation", () => ({
  usePathname: () => CURRENT_PATH,
}));

const CURRENT_PATH = "/agents";

beforeEach(() => {
  // The provider decides "is this a navigation?" against window.location, not
  // against the router hook, so jsdom has to actually be on the page the test
  // says it is on — otherwise every link looks like it goes somewhere new.
  window.history.replaceState({}, "", CURRENT_PATH);
});

function renderShell() {
  return render(
    <NavigationStatusProvider>
      <NavigationProgressBar />
      <a href="/skills">Skills</a>
      <a href="/agents">Agents (current page)</a>
      <a href="https://example.com/docs">Docs</a>
    </NavigationStatusProvider>,
  );
}

const bar = () => document.querySelector('[data-slot="navigation-progress"]');

describe("NavigationProgressBar", () => {
  it("reports a navigation the moment the link is clicked", async () => {
    const user = userEvent.setup();
    renderShell();

    // Nothing to report while the user is just reading the page.
    expect(bar()).toBeNull();

    await user.click(screen.getByRole("link", { name: "Skills" }));

    // The next route has not mounted yet — this is the whole point: the
    // content area still shows the previous page, so without this the click
    // goes unacknowledged everywhere the user is looking.
    expect(bar()).not.toBeNull();
  });

  it("stays quiet for clicks that are not a navigation", async () => {
    const user = userEvent.setup();
    renderShell();

    // Same page: nothing is loading, so a bar would be a lie.
    await user.click(
      screen.getByRole("link", { name: "Agents (current page)" }),
    );
    expect(bar()).toBeNull();

    // Leaving the app entirely is the browser's progress to report, not ours.
    await user.click(screen.getByRole("link", { name: "Docs" }));
    expect(bar()).toBeNull();
  });

  it("leaves the announcement to the sidebar toggle", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("link", { name: "Skills" }));

    // The sidebar toggle already announces this exact wait. A second live
    // region for one navigation would double-announce it (WCAG 4.1.3).
    expect(bar()?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
