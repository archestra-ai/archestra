import { TIER_NAMES, type TierName } from "./tiers";

/** (p_normal, p_smart); p_fast = 1 − x − y. */
export type Point = readonly [number, number];
type TierTriple = readonly [number, number, number];
/** a·x + b·y ≥ c */
type HalfPlane = readonly [number, number, number];

const TRIANGLE: Point[] = [
  [0, 0],
  [1, 0],
  [0, 1],
];

/**
 * Where each tier wins argmax_k (adequacy_k − λ*·usdPerToken_k) on Jev's
 * (p_normal, p_smart) triangle, with adequacy (p_fast, p_fast + p_normal, 1):
 * router-core's rule at the given per-token prices. Empty when the tier
 * holds no area.
 */
export function routingRegions(
  lamStar: number,
  usdPerToken: TierTriple,
): Record<TierName, Point[]> {
  const [fast, normal, smart] = usdPerToken;
  const normalOverFast: HalfPlane = [1, 0, lamStar * (normal - fast)];
  const smartOverFast: HalfPlane = [1, 1, lamStar * (smart - fast)];
  const smartOverNormal: HalfPlane = [0, 1, lamStar * (smart - normal)];
  const not = ([a, b, c]: HalfPlane): HalfPlane => [-a, -b, -c];
  const bounds: Record<TierName, HalfPlane[]> = {
    fast: [not(normalOverFast), not(smartOverFast)],
    normal: [normalOverFast, not(smartOverNormal)],
    smart: [smartOverFast, smartOverNormal],
  };
  return Object.fromEntries(
    TIER_NAMES.map((tier) => {
      const polygon = bounds[tier].reduce(clip, TRIANGLE);
      return [tier, area(polygon) > 1e-9 ? polygon : []];
    }),
  ) as Record<TierName, Point[]>;
}

export function centroid(polygon: Point[]): Point {
  const n = polygon.length;
  return [
    polygon.reduce((sum, [x]) => sum + x, 0) / n,
    polygon.reduce((sum, [, y]) => sum + y, 0) / n,
  ];
}

/** Sutherland–Hodgman clip of a convex polygon to a half-plane. */
function clip(polygon: Point[], [a, b, c]: HalfPlane): Point[] {
  const out: Point[] = [];
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    const fp = a * p[0] + b * p[1] - c;
    const fq = a * q[0] + b * q[1] - c;
    if (fp >= 0) out.push(p);
    if (fp * fq < 0) {
      const t = fp / (fp - fq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  });
  return out;
}

function area(polygon: Point[]): number {
  let twice = 0;
  polygon.forEach(([x1, y1], i) => {
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    twice += x1 * y2 - x2 * y1;
  });
  return Math.abs(twice) / 2;
}
