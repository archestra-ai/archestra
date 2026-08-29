import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientUsageCard, ModelUsageCard } from "./usage-dimension-cards";

describe("usage dimension cards", () => {
  it("expands model usage into shares, requests, tokens, and billed spend", () => {
    render(
      <ModelUsageCard
        models={[
          {
            model: "example/model-large",
            requests: 24,
            inputTokens: 1_250,
            outputTokens: 250,
            cacheReadTokens: 4_000,
            totalTokens: 1_500,
            percentage: 62.5,
            billedCost: 3.25,
            subscriptionCost: 0,
          },
        ]}
      />,
    );

    expect(screen.getByText("example/model-large")).toBeInTheDocument();
    expect(screen.getByText("62.5%")).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument();
    expect(screen.getByText("1.5K")).toBeInTheDocument();
    expect(screen.getByText("$3.2500")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /62\.5% of tokens/i }),
    ).toBeInTheDocument();
    // Phone viewports must scroll the table rather than wrap figures into
    // neighbouring columns (`table-fixed` + wrap-break-word otherwise crush it).
    expect(screen.getByRole("table").className).toContain("min-w-[70rem]");
    expect(screen.getByRole("table").className).toContain("table-auto");
  });

  it("groups client usage and keeps subscription-covered value out of spend", () => {
    render(
      <ClientUsageCard
        clients={[
          {
            client: "Example coding client",
            requests: 40,
            inputTokens: 2_000,
            outputTokens: 500,
            cacheReadTokens: 8_000,
            totalTokens: 2_500,
            percentage: 100,
            billedCost: 0,
            subscriptionCost: 12.5,
          },
        ]}
      />,
    );

    expect(screen.getByText("Example coding client")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.getByText("Sub")).toHaveAccessibleName(
      "Subscription-covered usage",
    );
    expect(screen.queryByText("$12.50")).not.toBeInTheDocument();
  });

  it("labels requests that do not report a client", () => {
    render(
      <ClientUsageCard
        clients={[
          {
            client: null,
            requests: 1,
            inputTokens: 1,
            outputTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 1,
            percentage: 100,
            billedCost: 0,
            subscriptionCost: 0,
          },
        ]}
      />,
    );

    expect(screen.getByText("Not reported")).toBeInTheDocument();
  });
});
