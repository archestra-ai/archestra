import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { KpiTile } from "./cost-overview";

it("explains a card's change immediately on keyboard focus with the shared tooltip", async () => {
  render(
    <KpiTile
      label="Requests"
      value="60"
      caption="Your requests"
      series={[10, 10, 20, 20]}
    />,
  );
  const user = userEvent.setup();
  await user.tab();
  expect(screen.getByRole("button", { name: "100% increase" })).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "100% higher in the second half of the selected range than in the first half.",
  );
  expect(
    screen.getByRole("button", { name: "100% increase" }),
  ).not.toHaveAttribute("title");
});
