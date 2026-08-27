import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientUsageCard, ModelUsageCard } from "./usage-dimension-cards";

describe("usage dimension cards", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
  });

  it("groups client usage and keeps subscription-covered value out of spend", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T16:00:00.000Z"));

    render(
      <ClientUsageCard
        clients={[
          {
            client: "Example coding client",
            lastActiveAt: "2026-08-27T15:00:00.000Z",
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
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("about 1 hour ago")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.getByText("Sub")).toHaveAccessibleName(
      "Subscription-covered usage",
    );
    expect(screen.queryByText("$12.50")).not.toBeInTheDocument();
  });

  it("labels requests that do not report a client", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T16:00:00.000Z"));

    render(
      <ClientUsageCard
        clients={[
          {
            client: null,
            lastActiveAt: "2026-08-25T16:00:00.000Z",
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
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });
});
