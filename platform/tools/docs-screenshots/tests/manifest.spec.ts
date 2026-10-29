import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { SHOTS } from "../src/manifest";

// Always check the full source inventory, even for a filtered capture or when
// DOCS_SCREENSHOTS_OUTPUT points at a separate reproducibility output directory.
const docs = path.resolve(__dirname, "../../../../docs");
const pages = path.join(docs, "pages");
const references = new Set(
  fs
    .readdirSync(pages, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md"))
    .flatMap((file) =>
      Array.from(
        fs
          .readFileSync(path.join(pages, file), "utf8")
          .replace(/```[\s\S]*?```|<!--[\s\S]*?-->/g, "")
          .matchAll(
            /!\[[^\]]*\]\(\/docs\/(automated_screenshots\/[a-zA-Z0-9_.-]+\.webp)\)/g,
          ),
        (match) => match[1],
      ),
    ),
);

test("every capture has a unique asset embedded by a docs page", () => {
  const assets = SHOTS.map((shot) => shot.asset);
  expect(
    new Set(assets).size,
    "Duplicate capture paths overwrite each other",
  ).toBe(assets.length);
  for (const asset of assets) {
    expect(asset).toMatch(/^automated_screenshots\/[a-zA-Z0-9_-]+$/);
    expect(references, `Unused capture: ${asset}`).toContain(`${asset}.webp`);
  }
});

test("every automated asset belongs to a referenced light and dark capture", () => {
  const expected = new Set(
    SHOTS.flatMap(({ asset }) => [`${asset}.webp`, `${asset}.dark.webp`]),
  );
  const actual = fs
    .readdirSync(path.join(docs, "assets/automated_screenshots"))
    .map((file) => `automated_screenshots/${file}`);
  expect(actual.sort()).toEqual([...expected].sort());
  expect([...references].sort()).toEqual(
    SHOTS.map(({ asset }) => `${asset}.webp`).sort(),
  );
});
