import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { UsageCell } from "./usage-cell";

const session: ComponentProps<typeof UsageCell>["session"] = {
  requestCount: 4,
  failedOverCount: 0,
  totalInputTokens: 4210,
  totalOutputTokens: 318,
  totalCacheReadTokens: 18400,
  totalCacheWriteTokens: 0,
  totalCost: "0.0182",
  totalBilledCost: "0.0182",
  totalSubscriptionCost: null,
  totalBaselineCost: "0.03",
};

describe("UsageCell", () => {
  it("shows exact billed, token and savings details on focus", async () => {
    const user = userEvent.setup();
    render(<UsageCell session={session} />);
    expect(screen.getByText("$0.02")).toBeVisible();
    expect(screen.getByText("4.5K tokens")).toBeVisible();
    await user.tab();
    const details = within(await screen.findByRole("tooltip"));
    expect(details.getByText("4,210 / 318")).toBeInTheDocument();
    expect(details.getByText("18,400")).toBeInTheDocument();
    expect(details.getByText("$0.0182")).toBeInTheDocument();
    expect(details.getByText("$0.0118")).toBeInTheDocument();
  });

  it("shows how many requests a model pool failed over", async () => {
    const user = userEvent.setup();
    render(<UsageCell session={{ ...session, failedOverCount: 2 }} />);
    await user.tab();
    const details = within(await screen.findByRole("tooltip"));
    expect(details.getByText("Failed over")).toBeInTheDocument();
    expect(details.getByText("2")).toBeInTheDocument();
  });

  it.each([
    { totalBilledCost: null, totalSubscriptionCost: "0.125", expected: "$0" },
    {
      totalBilledCost: "0.04",
      totalSubscriptionCost: "0.085",
      expected: "$0.04",
    },
  ])("keeps subscription-covered cost out of billed spend ($expected)", ({
    expected,
    ...costs
  }) => {
    render(
      <UsageCell session={{ ...session, totalCost: "0.125", ...costs }} />,
    );
    expect(screen.getByText(expected, { exact: true })).toBeVisible();
    expect(screen.getByText("Plan")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /includes subscription usage/ }),
    ).toBeVisible();
    expect(screen.queryByText("$0.13")).toBeNull();
  });

  it("keeps sub-cent spend visible", async () => {
    const user = userEvent.setup();
    render(
      <UsageCell
        session={{
          ...session,
          totalCost: "0.00004",
          totalBilledCost: "0.00004",
        }}
      />,
    );
    expect(screen.getByText("<$0.01")).toBeVisible();
    await user.tab();
    expect(
      within(await screen.findByRole("tooltip")).getByText("$0.000040"),
    ).toBeInTheDocument();
  });
});
