import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";

/**
 * The app reports loading in exactly one place — the spinner inside the
 * sidebar's circle toggle, which is fixed to the sidebar edge and therefore
 * never moves.
 *
 * Before this was pinned, a single refresh could put a spinner at the centre
 * of the viewport ("Loading your workspace…"), then at the centre of the
 * content column ("Checking access…"), then lower again for the list itself —
 * three indicators at three different positions in under a second, which read
 * as the loader jumping around the screen.
 */
const BOOT_LOADER_LABELS = [
  "Loading your workspace…",
  "Checking access…",
  "Loading LLM proxies…",
  "Loading LLM proxy…",
  "Loading agents…",
  "Loading results…",
];

/**
 * Record every visible loading indicator that appears from this point until
 * `readIndicatorsSeen` is called. Installed as an init script so it survives
 * the reload it is measuring, and samples on every frame so a spinner shown
 * for a few frames is still caught.
 */
async function recordIndicators(page: Page) {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __loadingSeen: Set<string> }).__loadingSeen = seen;
    const sample = () => {
      for (const element of document.querySelectorAll(
        'output, [role="status"]',
      )) {
        // A `quiet` loading state announces itself to assistive tech without
        // drawing anything; only an actual spinner counts as an indicator.
        if (!element.querySelector(".animate-spin")) continue;
        const inSidebarToggle = !!element.closest(
          '[data-slot="sidebar-circle-toggle"]',
        );
        seen.add(
          inSidebarToggle
            ? "sidebar-toggle"
            : (element.getAttribute("aria-label") ?? "unlabelled"),
        );
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

const readIndicatorsSeen = (page: Page) =>
  page.evaluate(() => [
    ...(window as unknown as { __loadingSeen: Set<string> }).__loadingSeen,
  ]);

test.describe("loading states", () => {
  test("a refresh brings the page back without a full-screen loader", async ({
    page,
    goToPage,
  }) => {
    await goToPage(page, "/llm/proxy");
    await expect(
      page.getByRole("heading", { name: "LLM Proxy", exact: true }),
    ).toBeVisible();

    await recordIndicators(page);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "LLM Proxy", exact: true }),
    ).toBeVisible();

    const seen = await readIndicatorsSeen(page);
    expect(seen.filter((label) => label !== "sidebar-toggle")).toEqual([]);
    for (const label of BOOT_LOADER_LABELS) {
      expect(seen).not.toContain(label);
    }
  });

  test("an empty result is only reported once the list has actually loaded", async ({
    page,
    goToPage,
  }) => {
    await goToPage(page, "/llm/proxy/virtual-keys");
    const search = page.getByPlaceholder(/Search keys by name/i);
    await expect(search).toBeVisible();

    // A filter that cannot match sends the list through a fetch that returns
    // nothing. The empty state belongs at the end of that, not while it runs:
    // announcing it early and replacing it with rows is the flash this pins.
    await search.fill("no-such-key-should-ever-exist");
    await expect(
      page.getByText(/No virtual keys match your filters/i),
    ).toBeVisible();

    // Clearing the filter restores the unfiltered list, with no filtered
    // empty state on the way.
    await search.fill("");
    await expect(
      page.getByText(/No virtual keys match your filters/i),
    ).toBeHidden();
  });
});
