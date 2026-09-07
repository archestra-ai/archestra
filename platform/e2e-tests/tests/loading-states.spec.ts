import type { Page } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
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
    browser,
  }) => {
    // The auth surface stacks two gates: the session check above the shell,
    // and the route's own Suspense boundary inside it. They used to draw
    // full-area loaders with different geometry — the second derived its
    // height from `100dvh - 12rem`, chrome the auth pages do not have — so the
    // indicator jumped up the screen partway through a reload. Both now centre
    // in the box the layout actually gives them.
    //
    // A fresh unauthenticated context: the project-level admin storage state
    // would bounce this navigation off /auth/sign-in before the gates render.
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
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

    await page.goto(`${UI_BASE_URL}/auth/sign-in`);
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

    await context.close();
  });

  test("the sign-in surface never blanks, and its form lands in one place", async ({
    browser,
  }) => {
    // One signed-out load used to run through five states: an indicator, an
    // empty screen, the indicator again, an empty screen again, the card — and
    // then the card shoved 55px down as the default-credentials banner landed
    // above it in a vertically centred column. The blanks were the backend
    // connectivity probe rendering nothing while it had no verdict, and the
    // jump was the column painting before it knew its own shape.
    //
    // Hidden elements are skipped deliberately: React keeps the outgoing
    // Suspense boundary mounted as `display: none` during a transition, so a
    // naive query matches a loader nobody can see, at y=0.
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const states: string[] = [];
      (window as unknown as { __states: string[] }).__states = states;
      const isVisible = (element: Element) =>
        element.getClientRects().length > 0;
      let previous = "";
      const sample = () => {
        const form = [...document.querySelectorAll("form")].find(isVisible);
        const indicator = [...document.querySelectorAll("output")].find(
          (element) =>
            isVisible(element) && element.querySelector(".animate-spin"),
        );
        const state = form
          ? `form@${Math.round(form.getBoundingClientRect().y)}`
          : indicator
            ? "indicator"
            : "nothing";
        if (state !== previous) {
          previous = state;
          states.push(state);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    await page.goto(`${UI_BASE_URL}/auth/sign-in`);
    await expect(
      page.getByRole("button", { name: "Sign In", exact: true }),
    ).toBeVisible();
    // Give a late-arriving banner the chance to shift the form, so that a
    // regression fails here rather than passing on timing.
    await page.waitForTimeout(1000);

    const states = await page.evaluate(
      () => (window as unknown as { __states: string[] }).__states,
    );

    // Everything before the first paint is legitimately empty; the contract
    // starts once the surface has shown something.
    const painted = states.slice(states.findIndex((s) => s !== "nothing"));
    expect(painted).not.toContain("nothing");

    // The form is allowed to appear once. Appearing at two different offsets
    // means something arrived above it after it had already painted.
    const formOffsets = painted
      .filter((s) => s.startsWith("form@"))
      .map((s) => Number(s.slice("form@".length)));
    const formSpread =
      formOffsets.length > 1
        ? Math.max(...formOffsets) - Math.min(...formOffsets)
        : 0;
    expect(formSpread).toBeLessThanOrEqual(2);

    await context.close();
  });

  test("the chat page's gates draw a loader, never a stringified value", async ({
    page,
    goToPage,
  }) => {
    // The chat page holds the screen until it knows whether a provider key
    // exists, and that gate once returned the *text* `null` where its loader
    // used to be — an early return for the whole page, so the version footer
    // went with it. Both queries behind the gate are pending on a cold load,
    // so it renders for at least a frame every time; sampling each frame is
    // what makes this deterministic rather than a race.
    await page.addInitScript(() => {
      const seen = new Set<string>();
      (window as unknown as { __placeholders: Set<string> }).__placeholders =
        seen;
      const sample = () => {
        for (const element of document.body?.querySelectorAll("*") ?? []) {
          if (element.children.length > 0) continue;
          const text = element.textContent?.trim();
          if (text === "null" || text === "undefined") seen.add(text);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    await goToPage(page, "/chat");
    await expect(
      page.getByPlaceholder(/What would you like to get done\?/i),
    ).toBeVisible();

    const placeholders = await page.evaluate(() => [
      ...(window as unknown as { __placeholders: Set<string> }).__placeholders,
    ]);
    expect(placeholders).toEqual([]);
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
