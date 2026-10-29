import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Slider } from "./slider";

describe("Slider", () => {
  it("names and describes the thumb with the given ARIA props", () => {
    render(<Slider aria-label="Budget" aria-valuetext="$5/day" value={[5]} />);

    expect(screen.getByRole("slider", { name: "Budget" })).toHaveAttribute(
      "aria-valuetext",
      "$5/day",
    );
  });

  it("keeps Radix's generated thumb names when none are given", () => {
    render(<Slider value={[10, 90]} />);

    expect(screen.getByRole("slider", { name: "Minimum" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Maximum" })).toBeInTheDocument();
  });
});
