import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PooledHint } from "./pooled-hint";

const HINT_TEXT =
  "Agent runs start much quicker from pool of runtime instances. Managed automatically. Pooled instances reserve part of cluster's capacity. Learn more";

describe("PooledHint", () => {
  it("opens under the pointer without taking focus, and closes when the pointer leaves", async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="Name" />
        <PooledHint />
      </>,
    );
    const name = screen.getByLabelText("Name");
    name.focus();
    await user.hover(
      screen.getByRole("button", { name: "About pooled tiers" }),
    );
    const hint = await screen.findByRole("dialog", {
      name: "About pooled tiers",
    });
    expect(hint).toHaveTextContent(HINT_TEXT);
    expect(
      within(hint).getByRole("link", { name: /Learn more/ }),
    ).toHaveAttribute(
      "href",
      expect.stringMatching(/\/docs\/agents\/runtime\/setup#warm-pools$/),
    );
    expect(name).toHaveFocus();

    await user.unhover(
      screen.getByRole("button", { name: "About pooled tiers" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "About pooled tiers" }),
      ).not.toBeInTheDocument(),
    );
    expect(name).toHaveFocus();
  });

  it("a press while the pointer opened it moves focus inside, so Tab reaches the link", async () => {
    const user = userEvent.setup();
    render(<PooledHint />);
    const trigger = screen.getByRole("button", { name: "About pooled tiers" });
    await user.hover(trigger);
    const hint = await screen.findByRole("dialog", {
      name: "About pooled tiers",
    });
    expect(hint).not.toContainElement(document.activeElement as HTMLElement);
    await user.click(trigger);
    expect(hint).toBeInTheDocument();
    expect(hint).toContainElement(document.activeElement as HTMLElement);
    await user.tab();
    expect(
      within(hint).getByRole("link", { name: /Learn more/ }),
    ).toHaveFocus();
    await user.unhover(trigger);
    // Opened by a press now: the pointer leaving does not close it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(hint).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "About pooled tiers" }),
      ).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("opens from the keyboard with its link in the Tab order, and Escape returns focus to the icon", async () => {
    const user = userEvent.setup();
    render(<PooledHint />);
    const trigger = screen.getByRole("button", { name: "About pooled tiers" });
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    const hint = await screen.findByRole("dialog", {
      name: "About pooled tiers",
    });
    await user.tab();
    expect(
      within(hint).getByRole("link", { name: /Learn more/ }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "About pooled tiers" }),
      ).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });
});
