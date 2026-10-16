import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { SessionUsage } from "./session-usage";

const session: ComponentProps<typeof SessionUsage>["session"] = {
  requestCount: 4,
  totalInputTokens: 4210,
  totalOutputTokens: 318,
  totalCacheReadTokens: 18400,
  totalCacheWriteTokens: 0,
  totalCost: "0.0182",
  totalBilledCost: "0.0182",
  totalSubscriptionCost: null,
  totalBaselineCost: "0.03",
};

describe("SessionUsage", () => {
  it("shows exact billed, token and savings details on focus", async () => {
    const user = userEvent.setup();
    render(<SessionUsage session={session} />);
    expect(screen.getByText("4.2k in")).toBeVisible();
    expect(screen.getByText("318 out")).toBeVisible();
    await user.tab();
    const details = within(await screen.findByRole("tooltip"));
    expect(details.getByText("4,210 / 318")).toBeInTheDocument();
    expect(details.getByText("18,400")).toBeInTheDocument();
    expect(details.getByText("$0.0182")).toBeInTheDocument();
    expect(details.getByText("$0.0118")).toBeInTheDocument();
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
      <SessionUsage session={{ ...session, totalCost: "0.125", ...costs }} />,
    );
    expect(screen.getByText(expected, { exact: true })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /includes subscription usage/ }),
    ).toBeVisible();
    expect(screen.queryByText("$0.13")).toBeNull();
  });

  it("keeps sub-cent spend visible", () => {
    render(
      <SessionUsage
        session={{
          ...session,
          totalCost: "0.00004",
          totalBilledCost: "0.00004",
        }}
      />,
    );
    expect(screen.getByText("$0.000040")).toBeVisible();
  });
});
