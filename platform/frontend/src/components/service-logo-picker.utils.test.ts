import * as simpleIcons from "simple-icons";
import { describe, expect, it } from "vitest";
import {
  buildIconList,
  CUSTOM_ICONS,
  FEATURED_SLUGS,
  filterIcons,
  iconToDataUrl,
  type ServiceIcon,
} from "./service-logo-picker.utils";

/**
 * The real package, exactly as the picker loads it. Reading it for real is the
 * point: these tests exist to fail when an upstream simple-icons release drops
 * a brand we offer, which is how the Slack entry silently became "Slackware".
 */
const icons = buildIconList(simpleIcons);

describe("buildIconList", () => {
  it("offers every slug the featured row promises", () => {
    const available = new Set(icons.map((icon) => icon.slug));
    const missing = Array.from(FEATURED_SLUGS).filter(
      (slug) => !available.has(slug),
    );
    expect(missing).toEqual([]);
  });

  it("never lists two icons under one slug", () => {
    // The picker keys its grid by slug, so a collision is a duplicate React key.
    const countBySlug = new Map<string, number>();
    for (const icon of icons) {
      countBySlug.set(icon.slug, (countBySlug.get(icon.slug) ?? 0) + 1);
    }
    const duplicated = Array.from(countBySlug)
      .filter(([, count]) => count > 1)
      .map(([slug]) => slug);
    expect(duplicated).toEqual([]);
  });

  it("keeps our backfilled logo when simple-icons ships the same slug", () => {
    // If upstream ever re-adds Slack, it arrives as a one-color silhouette. Our
    // multi-color mark has to win, and the slug must not appear twice.
    const upstreamSlack: ServiceIcon = {
      title: "Slack",
      slug: "slack",
      hex: "4A154B",
      path: "M0 0h24v24H0z",
    };
    const merged = buildIconList({ siSlack: upstreamSlack });

    const matches = merged.filter((icon) => icon.slug === "slack");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.svgMarkup).toContain("#36C5F0");
  });

  it("skips module exports that are not icons", () => {
    const merged = buildIconList({
      someHelper: () => "not an icon",
      version: "1.2.3",
      nothing: null,
    });
    expect(merged).toEqual(CUSTOM_ICONS);
  });
});

describe("filterIcons", () => {
  it("ranks Slack above Slackware when searching for slack", () => {
    const results = filterIcons(icons, "slack");
    const titles = results.map((icon) => icon.title);

    expect(titles).toContain("Slack");
    expect(titles).toContain("Slackware");
    expect(titles.indexOf("Slack")).toBeLessThan(titles.indexOf("Slackware"));
  });

  it("puts prefix matches ahead of mid-word matches", () => {
    const catalog: ServiceIcon[] = [
      { title: "Zeta Notion", slug: "zetanotion", hex: "000000", path: "M0 0" },
      { title: "Notion", slug: "notion", hex: "000000", path: "M0 0" },
    ];
    expect(filterIcons(catalog, "notion").map((icon) => icon.title)).toEqual([
      "Notion",
      "Zeta Notion",
    ]);
  });

  it("leads with featured logos, in featured order, when there is no query", () => {
    const leading = filterIcons(icons, "")
      .slice(0, FEATURED_SLUGS.size)
      .map((icon) => icon.slug);
    expect(leading).toEqual(Array.from(FEATURED_SLUGS));
  });

  it("ignores surrounding whitespace and case", () => {
    expect(filterIcons(icons, "  SLACK ").map((icon) => icon.title)).toContain(
      "Slack",
    );
  });
});

describe("iconToDataUrl", () => {
  it("renders a multi-color logo from its own SVG markup", () => {
    const slack = icons.find((icon) => icon.slug === "slack");
    if (!slack) throw new Error("expected a Slack logo");

    const decoded = decodeURIComponent(
      iconToDataUrl(slack).replace("data:image/svg+xml,", ""),
    );
    // All four quadrants of the Slack mark, not a single-color silhouette.
    expect(decoded).toContain("#36C5F0");
    expect(decoded).toContain("#2EB67D");
    expect(decoded).toContain("#ECB22E");
    expect(decoded).toContain("#E01E5A");
  });

  it("renders a single-path logo in its brand color", () => {
    const dataUrl = iconToDataUrl({
      title: "Example",
      slug: "example",
      hex: "FF0000",
      path: "M0 0h24v24H0z",
    });
    expect(dataUrl).toContain('fill="%23FF0000"');
    expect(dataUrl).toContain('d="M0 0h24v24H0z"');
  });
});
