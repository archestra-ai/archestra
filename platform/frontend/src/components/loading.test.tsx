import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingState } from "./loading";

describe("LoadingState", () => {
  it("exposes the label to assistive tech and respects reduced motion", () => {
    const { container } = render(<LoadingState label="Loading connectors…" />);

    expect(
      screen.getByRole("status", { name: "Loading connectors…" }),
    ).toBeVisible();
    // The spinner is a CSS animation, so reduced-motion users need it stopped
    // rather than merely slowed.
    expect(container.querySelector(".animate-spin")).toHaveClass(
      "motion-reduce:animate-none",
    );
  });

  it("keeps inline loading states compact and visually label-free", () => {
    render(<LoadingState label="Loading token" variant="inline" />);

    const status = screen.getByRole("status", { name: "Loading token" });
    // Inline callers sit next to their own copy, so the label stays
    // accessible-only instead of rendering a second time on screen.
    expect(screen.queryByText("Loading token")).toBeNull();
    expect(status).toHaveClass("inline-flex");
  });
});
