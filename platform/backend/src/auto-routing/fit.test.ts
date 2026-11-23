import { describe, expect, test } from "vitest";
import { type FitHistory, planInput } from "./fit";
import type { RouterTierSet, RouterTokenPrices } from "./tiers";

describe("planInput tier prices", () => {
  test("cache writes cost the 5m and 1h rates blended by each block's 1h share", () => {
    const { tiers } = input(trio({ long: usd(4, 8) }), [
      { weight: 1, short: [300, 300], long: [300, 0] },
      { weight: 3, short: [100, 0], long: [0, 0] },
    ]);

    expect(tiers.tiers[0].short).toEqual({
      input: 1,
      cache_read: 0.1,
      cache_write: 0.5 * 2 + 0.5 * 4,
      output: 5,
    });
    expect(tiers.tiers[0].long?.cache_write).toBe(4);
  });

  test("a tier without long prices bills long requests at its short rates", () => {
    const { tiers } = input(
      {
        tiers: [
          tier(usd(2, 4), null),
          tier(usd(2, 4), usd(4, 8)),
          tier(usd(2, 4), usd(4, 8)),
        ],
        long_context_threshold: 200_000,
      },
      [{ weight: 1, short: [100, 0], long: [100, 100] }],
    );

    expect(tiers.tiers[0].short.cache_write).toBe(2);
    expect(tiers.tiers[0].long?.cache_write).toBe(4);
    expect(tiers.tiers[1].long?.cache_write).toBe(8);
  });

  test("a block without cache writes takes the other block's 1h share", () => {
    const { tiers } = input(trio({ long: usd(4, 8) }), [
      { weight: 1, short: [100, 25], long: [0, 0] },
    ]);

    expect(tiers.tiers[0].long?.cache_write).toBe(0.75 * 4 + 0.25 * 8);
  });

  test("a trio without a long-context threshold has no long prices", () => {
    const { tiers } = input(trio({ long: null }), [
      { weight: 1, short: [100, 100], long: [0, 0] },
    ]);

    expect(tiers.tiers.map((t) => t.long)).toEqual([null, null, null]);
    expect(tiers.tiers[0].short.cache_write).toBe(4);
  });
});

/** Cache-write tokens of a block as [all, written with the 1h TTL]. */
type Writes = [number, number];

function input(
  tiers: RouterTierSet,
  rows: { weight: number; short: Writes; long: Writes }[],
) {
  const block = ([cacheWrite, cacheWrite1h]: Writes) => ({
    input: 0,
    cacheRead: 0,
    cacheWrite,
    cacheWrite1h,
    output: 0,
  });
  const sample: FitHistory["sample"] = rows.map((row) => ({
    createdAt: new Date(0),
    features: {
      signals: {
        "jev-session": {
          version: "v",
          tier_needed: [0.2, 0.5, 0.3],
          p_long: 0,
        },
      },
      client: "claude-code",
    },
    short: block(row.short),
    long: block(row.long),
    weight: row.weight,
  }));
  const volume = {
    sessions: rows.length,
    tokens: 0,
    firstCreatedAt: null,
    lastCreatedAt: null,
  };
  return planInput({ sample, volume }, tiers, 1);
}

function usd(cache_write: number, cache_write_1h: number): RouterTokenPrices {
  return { input: 1, cache_read: 0.1, cache_write, cache_write_1h, output: 5 };
}

function tier(short: RouterTokenPrices, long: RouterTokenPrices | null) {
  return { model_id: "model", short, long };
}

function trio(prices: { long: RouterTokenPrices | null }): RouterTierSet {
  return {
    tiers: [0, 1, 2].map(() => tier(usd(2, 4), prices.long)),
    long_context_threshold: prices.long === null ? null : 200_000,
  };
}
