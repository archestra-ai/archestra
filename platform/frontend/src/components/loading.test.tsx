import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingState } from "./loading";

describe("LoadingState", () => {
  it("exposes the label to assistive tech and respects reduced motion", () => {
    const { container } = render(<LoadingState label="Loading connectors…" />);

    expect(
      screen.getByRole("status", { name: "Loading connectors…" }),
    ).toBeVisible();
    // `showLabel` defaults to on for every variant that draws an indicator, so
    // the label renders on screen as well as naming the live region.
    expect(screen.getByText("Loading connectors…")).toBeVisible();
    // The spinner is a CSS animation, so reduced-motion users need it stopped
    // rather than merely slowed.
    expect(container.querySelector(".animate-spin")).toHaveClass(
      "motion-reduce:animate-none",
    );
  });

  it("announces itself while drawing nothing when quiet", () => {
    const { container } = render(
      <LoadingState label="Loading…" variant="quiet" />,
    );

    const status = screen.getByRole("status", { name: "Loading…" });
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(status).toHaveTextContent("");
  });

  it("fills its container instead of deriving a height from the viewport", () => {
    // The auth surface has no app header or page header, so `page`'s
    // `100dvh - 12rem` describes chrome that is not there and lands the
    // indicator above the centre of the box the layout actually gave it —
    // which is what made the session gate's indicator jump on handover.
    const { container: filled } = render(
      <LoadingState label="Loading…" variant="fill" />,
    );
    const fill = filled.querySelector("output");
    expect(fill?.className).toContain("h-full");
    expect(fill?.className).not.toContain("visual-viewport-height");

    // It also takes over from an indicator already on screen, so it must not
    // delay its own entrance and blank the area at the handover.
    expect(fill?.className).not.toContain("animation-delay");
  });

  it("keeps inline loading labels accessible-only", () => {
    render(<LoadingState label="Loading token" variant="inline" />);

    screen.getByRole("status", { name: "Loading token" });
    // Inline callers sit next to their own copy, so the label stays
    // accessible-only instead of rendering a second time on screen.
    expect(screen.queryByText("Loading token")).toBeNull();
  });
});
