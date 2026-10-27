import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AutoRoutingDiagnostics } from "@/lib/auto-routing.query";
import { RoutingTriangle } from "./diagnostics-charts";
import { TIER_NAMES } from "./tiers";

type Ready = Extract<AutoRoutingDiagnostics, { status: "ready" }>;
type Prices = [number, number, number];

const LAM_STAR = 200_000;
const SHORT: Prices = [1e-7, 6e-7, 2e-6];
const LONG: Prices = [1e-7, 2e-7, 2e-6];

/** Jev readings over the triangle, each routed at its own prices by router-core's rule. */
function triangle(pricesOf: (i: number) => Prices, lamStar = LAM_STAR): Ready {
  const sessions = Array.from({ length: 120 }, (_, i) => {
    const pNormal = ((i * 0.618) % 1) * 0.98;
    const pSmart = (1 - pNormal) * ((i * 0.414) % 1) * 0.98;
    const pFast = 1 - pNormal - pSmart;
    const prices = pricesOf(i);
    const score = [pFast, pFast + pNormal, 1].map(
      (adequacy, k) => adequacy - lamStar * prices[k],
    );
    const best = score.indexOf(Math.max(...score));
    return {
      tierNeeded: [pFast, pNormal, pSmart] as Prices,
      pLong: 0.1,
      realizedTokens: 1000,
      predictedTokens: null,
      usdPerToken: prices,
      tier: TIER_NAMES[best],
    };
  });
  return {
    status: "ready",
    budgetUsdPerDay: 50,
    savedBudgetUsdPerDay: 50,
    lamStar,
    q: 0,
    tierSessionShare: [1 / 3, 1 / 3, 1 / 3],
    sizeFit: { status: "no_holdout" },
    sessions,
  };
}

function polygon(d: string): [number, number][] {
  return d
    .slice(1, -1)
    .split("L")
    .map((p) => p.split(",").map(Number) as [number, number]);
}

/** Inside `vertices` (even–odd), or within half a pixel of its boundary. */
function contains(vertices: [number, number][], [x, y]: [number, number]) {
  let inside = false;
  let nearest = Number.POSITIVE_INFINITY;
  vertices.forEach(([x1, y1], i) => {
    const [x2, y2] = vertices[(i + 1) % vertices.length];
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1)
      inside = !inside;
    const length2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    const t =
      length2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / length2,
            ),
          );
    nearest = Math.min(
      nearest,
      Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1))),
    );
  });
  return inside || nearest <= 0.5;
}

function regionsOf(container: HTMLElement) {
  return new Map(
    [...container.querySelectorAll("path[data-tier]")].map((path) => [
      path.getAttribute("data-tier"),
      polygon(path.getAttribute("d") ?? ""),
    ]),
  );
}

describe("RoutingTriangle", () => {
  it("draws regions that hold every dot and move with the budget's λ*", () => {
    const drawn = [LAM_STAR, LAM_STAR / 4].map((lamStar) => {
      const { container, unmount } = render(
        <RoutingTriangle data={triangle(() => SHORT, lamStar)} />,
      );
      const regions = regionsOf(container);
      expect([...regions.keys()].sort()).toEqual(["fast", "normal", "smart"]);
      const dots = [...container.querySelectorAll("circle[data-tier]")];
      expect(dots).toHaveLength(120);
      for (const dot of dots) {
        const region = regions.get(dot.getAttribute("data-tier")) ?? [];
        const at: [number, number] = [
          Number(dot.getAttribute("cx")),
          Number(dot.getAttribute("cy")),
        ];
        expect(contains(region, at), dot.textContent ?? "").toBe(true);
      }
      const tiers = dots.map((dot) => dot.getAttribute("data-tier"));
      unmount();
      return { regions, tiers };
    });

    const [tight, loose] = drawn;
    expect(loose.regions.get("smart")).not.toEqual(tight.regions.get("smart"));
    const smartShare = ({ tiers }: (typeof drawn)[number]) =>
      tiers.filter((t) => t === "smart").length;
    expect(smartShare(loose)).toBeGreaterThan(smartShare(tight));
  });

  it("draws no regions when long-context pricing varies sessions' prices", () => {
    const { container } = render(
      <RoutingTriangle data={triangle((i) => (i % 2 ? LONG : SHORT))} />,
    );

    expect(container.querySelectorAll("path[data-tier]")).toHaveLength(0);
    expect(container.querySelectorAll("circle[data-tier]")).toHaveLength(120);
  });

  it("labels a tier holding no area outside the triangle, clear of every region", () => {
    const base = triangle(() => SHORT);
    // Smart never beats normal at these prices, yet the plan routes some sessions there.
    const prices: Prices = [1e-7, 6e-7, 1e-5];
    const smart = {
      ...base.sessions[0],
      tierNeeded: [0.1, 0.2, 0.7] as Prices,
    };
    const data: Ready = {
      ...base,
      sessions: [
        ...base.sessions.map((s) => ({
          ...s,
          usdPerToken: prices,
          tier: s.tier === "smart" ? ("normal" as const) : s.tier,
        })),
        ...[0, 1, 2].map(() => ({
          ...smart,
          usdPerToken: prices,
          tier: "smart" as const,
        })),
      ],
    };
    const { container } = render(<RoutingTriangle data={data} />);

    const regions = [...regionsOf(container).values()];
    expect(regions.length).toBeGreaterThan(0);
    expect(container.querySelector('path[data-tier="smart"]')).toBeNull();
    const label = container.querySelector('[data-label="smart"] text');
    const at: [number, number] = [
      Number(label?.getAttribute("x")),
      Number(label?.getAttribute("y")),
    ];
    const outline = polygon(
      container.querySelector("path:not([data-tier])")?.getAttribute("d") ?? "",
    );
    expect(contains(outline, at)).toBe(false);
    for (const region of regions) expect(contains(region, at)).toBe(false);
  });
});
