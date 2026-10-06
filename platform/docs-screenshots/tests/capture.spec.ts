import { expect, test } from "@playwright/test";
import { ARCHESTRA_URL, ONLY } from "../src/env";
import { assetPath, type Theme, writeIfChanged } from "../src/image";
import { SHOTS } from "../src/manifest";
import { readSeedState } from "../src/seed";

const THEMES: Theme[] = ["light", "dark"];
const DOCS_SCREENSHOT_COOKIE = "archestra_docs_screenshot";
// A step such as creating a key raises a toast that can cover the shot. A
// development build also shows the Next.js issues badge.
const HIDE_TOASTS = "[data-sonner-toaster], nextjs-portal { display: none !important; }";

const selected = SHOTS.filter(
  (shot) =>
    ONLY.length === 0 || ONLY.some((prefix) => shot.asset.startsWith(prefix)),
);

for (const shot of selected) {
  for (const theme of THEMES) {
    test(`${shot.asset} (${theme})`, async ({ page, context }) => {
      const seed = readSeedState();
      if (shot.viewport) await page.setViewportSize(shot.viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await context.addCookies([
        { name: DOCS_SCREENSHOT_COOKIE, value: "1", url: ARCHESTRA_URL },
      ]);
      // next-themes reads the theme before first paint. The sidebar is always
      // collapsed, so every shot gives the page the full width.
      await page.addInitScript((value) => {
        window.localStorage.setItem("theme", value);
        window.localStorage.setItem("archestra-sidebar-open", "false");
      }, theme);

      await shot.beforeNavigate?.(page, seed);

      await page.goto(shot.route(seed));
      await page.waitForLoadState("networkidle");
      await shot.prepare?.(page, seed);
      await settle(page);

      const target = shot.target?.(page);
      if (target) await expect(target).toBeVisible();
      const options = {
        animations: "disabled",
        caret: "hide",
        style: HIDE_TOASTS,
      } as const;
      const png = target
        ? await target.screenshot(options)
        : await page.screenshot(options);

      const result = await writeIfChanged({
        png,
        file: assetPath(shot.asset, theme),
      });
      test.info().annotations.push({ type: "result", description: result });
    });
  }
}

/** Waits for fonts, images, and skeleton loaders so the frame is final. */
async function settle(page: import("@playwright/test").Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page
    .locator('[data-slot="skeleton"], .animate-pulse')
    .first()
    .waitFor({ state: "detached", timeout: 15_000 })
    .catch(() => {});
  await page.mouse.move(0, 0);
}
