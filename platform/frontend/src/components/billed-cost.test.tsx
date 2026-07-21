import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BilledCost } from "./billed-cost";

function renderBilledCost(props: React.ComponentProps<typeof BilledCost>) {
  return render(
    <TooltipProvider>
      <BilledCost {...props} />
    </TooltipProvider>,
  );
}

describe("BilledCost", () => {
  it("shows $0 billed (not the list price) for a fully subscription-covered session", () => {
    // The exact regression: SUM(cost) FILTER (billing_mode='metered') is NULL
    // when there are no metered rows, so billedCost arrives as null. Billed
    // spend must be $0, not the $100 list price.
    renderBilledCost({
      cost: "100.0000000000",
      billedCost: null,
      subscriptionCost: "100.0000000000",
      baselineCost: "100.0000000000",
    });

    expect(screen.getByText("Subscription")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.queryByText(/\$100/)).not.toBeInTheDocument();
  });

  it("shows only the metered portion as billed for a mixed session", () => {
    renderBilledCost({
      cost: "100.0000000000",
      billedCost: "30.0000000000",
      subscriptionCost: "70.0000000000",
      baselineCost: "100.0000000000",
    });

    expect(screen.getByText("Subscription")).toBeInTheDocument();
    expect(screen.getByText("$30.0000")).toBeInTheDocument();
    expect(screen.queryByText("$100.0000")).not.toBeInTheDocument();
  });

  it("treats a single subscription interaction as $0 billed via billingMode", () => {
    renderBilledCost({
      cost: "5.0000000000",
      billingMode: "subscription",
      baselineCost: "5.0000000000",
    });

    expect(screen.getByText("Subscription")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("delegates to the metered savings display when there is no subscription cost", () => {
    renderBilledCost({
      cost: "10.0000000000",
      billedCost: "10.0000000000",
      subscriptionCost: null,
      baselineCost: "10.0000000000",
      format: "number",
      tooltip: "never",
    });

    // Metered path renders no Subscription badge.
    expect(screen.queryByText("Subscription")).not.toBeInTheDocument();
  });
});
