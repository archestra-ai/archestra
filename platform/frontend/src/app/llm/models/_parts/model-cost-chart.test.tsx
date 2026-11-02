import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CostChart } from "./model-cost-chart";

test("reports sub-cent recorded and recomputed costs without rounding to cents", () => {
  const day = new Date("2026-10-01T00:00:00");
  render(
    <CostChart
      days={[{ day, requests: 1, recordedCost: 0.004, recomputedCost: 0.006 }]}
      since={day}
      firstRequestAt={day}
      presetId={null}
      onPick={() => {}}
    />,
  );
  const slider = screen.getByRole("slider", { name: "Recompute from" });
  expect(slider.getAttribute("aria-valuetext")).toContain(
    "$0.004 recorded, $0.006 at the new prices",
  );
});
