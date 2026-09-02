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

  test("the sign-in page holds its loading indicator in one place", async ({
    page,
  }) => {
    // The auth surface stacks two gates: the session check above the shell,
    // and the route's own Suspense boundary inside it. They used to draw
    // full-area loaders with different geometry — the second derived its
    // height from `100dvh - 12rem`, chrome the auth pages do not have — so the
    // indicator jumped up the screen partway through a reload. Both now centre
    // in the box the layout actually gives them.
    await page.addInitScript(() => {
      const centres: number[] = [];
      (window as unknown as { __centres: number[] }).__centres = centres;
      const sample = () => {
        for (const element of document.querySelectorAll("output")) {
          const indicator = element.querySelector(".animate-spin");
          if (!indicator) continue;
          const box = element.getBoundingClientRect();
          if (box.height < 200) continue; // full-area loaders only
          centres.push(Math.round(box.y + box.height / 2));
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    await page.goto("/auth/sign-in");
    // Deliberately not a role query: the auth surface nests the shell's <main>
    // inside the auth page's own, so getByRole("main") is a strict-mode
    // violation here rather than a wait.
    await page.waitForLoadState("networkidle");

    const centres = await page.evaluate(
      () => (window as unknown as { __centres: number[] }).__centres,
    );

    // Two or more samples means the handover between the gates was caught, and
    // that is the moment the indicator used to jump ~55px up the screen. One
    // sample means the page resolved inside a frame and there was no handover
    // to see; either way it must never have drawn a loader in two places.
    const spread =
      centres.length > 1 ? Math.max(...centres) - Math.min(...centres) : 0;
    expect(spread).toBeLessThanOrEqual(16);
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
