import type { archestraApiTypes } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TokenMixCard } from "./token-mix-card";

type TokenMix =
  archestraApiTypes.GetMyUsageBreakdownResponses["200"]["tokenMix"];

function makeMix(overrides: Partial<TokenMix> = {}): TokenMix {
  return {
    freshInputTokens: 1_000,
    cacheReadTokens: 9_000,
    cacheWriteTokens: 500,
    outputTokens: 250,
    cacheCost: 0.4,
    cacheSavings: 1.25,
    ...overrides,
  };
}

describe("My Usage TokenMixCard", () => {
  it("reports the share of readable context that came from cache", () => {
    render(
      <TokenMixCard
        mix={makeMix({ cacheReadTokens: 9_000, freshInputTokens: 1_000 })}
      />,
    );

    // 9000 of the 10000 tokens the model had to read were replayed from cache.
    // Output is excluded from the denominator, so verbose turns do not drag a
    // healthy hit rate down.
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  it("says caching saved money when the stored net figure is positive", () => {
    render(<TokenMixCard mix={makeMix({ cacheSavings: 1.25 })} />);

    expect(screen.getByText(/Caching saved \$1\.25/)).toBeInTheDocument();
  });

  it("reports a negative net figure as caching having cost money", () => {
    // The finding the card exists for: a cache rewritten every turn and never
    // read back is worse than not caching, and must not be shown as a saving.
    render(<TokenMixCard mix={makeMix({ cacheSavings: -0.75 })} />);

    expect(screen.getByText(/Caching cost \$0\.75 more/)).toBeInTheDocument();
    expect(screen.queryByText(/Caching saved/)).not.toBeInTheDocument();
  });

  it("shows the empty state rather than a zero-width bar when nothing was recorded", () => {
    render(
      <TokenMixCard
        mix={makeMix({
          freshInputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
        })}
      />,
    );

    expect(
      screen.getByText("No recorded activity for the selected timeframe."),
    ).toBeInTheDocument();
  });
});
