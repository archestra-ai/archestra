import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingState } from "./loading";

describe("LoadingState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
  });

  it("holds a fresh indicator back so a short wait draws nothing", () => {
    // A wait shorter than the delay never draws: the indicator is transparent
    // for the whole delay (`backwards` fill-mode) and unmounts before it would
    // have appeared. That is what keeps a gate resolving in 50ms from flashing
    // a spinner nobody could read — the sign-out route did exactly that.
    //
    // Fresh means nothing was on screen recently, and the previous test's
    // teardown was milliseconds ago, so move past the handover window first.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);

    const { container } = render(<LoadingState variant="fill" />);
    expect(container.querySelector("output")?.className).toContain(
      "animation-delay",
    );
  });

  it("does not delay an indicator that replaces one already on screen", () => {
    // The same call site is a fresh wait or a handover depending only on what
    // was on screen a moment earlier, so the component decides per mount
    // rather than trusting a prop. Delaying at a handover would blank the area
    // between the two indicators instead of covering a new wait.
    const first = render(<LoadingState variant="fill" />);
    const takingOver = render(<LoadingState variant="fill" />);

    expect(
      takingOver.container.querySelector("output")?.className,
    ).not.toContain("animation-delay");

    // Still a handover when the outgoing one leaves first, which is the order
    // a plain conditional swap unmounts in.
    first.unmount();
    takingOver.unmount();
    const afterSwap = render(<LoadingState variant="fill" />);
    expect(
      afterSwap.container.querySelector("output")?.className,
    ).not.toContain("animation-delay");
  });

  it("keeps inline loading labels accessible-only", () => {
    render(<LoadingState label="Loading token" variant="inline" />);

    screen.getByRole("status", { name: "Loading token" });
    // Inline callers sit next to their own copy, so the label stays
    // accessible-only instead of rendering a second time on screen.
    expect(screen.queryByText("Loading token")).toBeNull();
  });
});
