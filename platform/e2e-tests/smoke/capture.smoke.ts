import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../consts";
import { expectAuthenticated, loginViaApi } from "../utils/auth";

/**
 * Headless screenshot capture for the `archestra-dev-smoke` skill. Navigates each path in
 * SMOKE_PATHS, captures a full-page PNG, and prints a JSON manifest of files + page errors to
 * stdout. The agent then `Read`s the PNGs and does the visual evaluation — this file only
 * captures, it makes no assertions about what "looks right".
 *
 * Env:
 *   SMOKE_PATHS    comma-separated app routes, e.g. "/agents,/settings" (default "/")
 *   SMOKE_OUT_DIR  output directory for PNGs (default "/tmp/archestra-smoke")
 */
const paths = (process.env.SMOKE_PATHS || "/")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const outDir = process.env.SMOKE_OUT_DIR || "/tmp/archestra-smoke";

interface CaptureEntry {
  path: string;
  screenshot: string;
  errors: string[];
}

test("capture", async ({ page }) => {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest: CaptureEntry[] = [];

  // Attach error listeners once; reset the buffer per path so each entry only carries its own.
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      pageErrors.push(`console.error: ${msg.text()}`);
    }
  });

  // Authenticate proactively: the app renders its sign-in view client-side without changing the
  // URL, so a reactive URL check can't detect it. loginViaApi seeds the context's session cookie
  // (a no-op refresh when storageState already supplied a valid one) so every navigation below is
  // authenticated.
  if (!(await loginViaApi(page, ADMIN_EMAIL, ADMIN_PASSWORD))) {
    throw new Error(
      "sign-in failed — is the local stack up and are the admin credentials correct?",
    );
  }

  for (const [index, appPath] of paths.entries()) {
    pageErrors.length = 0;
    // "domcontentloaded", not the default "load": the Next.js dev server compiles a route on first
    // hit (can exceed 30s) and some pages hold long-lived connections that defer the load event.
    await page.goto(appPath, { waitUntil: "domcontentloaded" });
    if (index === 0) {
      // Fail loudly on the first path if the session didn't take, rather than silently
      // capturing the sign-in view for every route.
      await expectAuthenticated(page);
    }
    await page.waitForLoadState("networkidle").catch(() => {});

    // Index-prefix the filename so two routes that slug to the same name (e.g. "/foo-bar" and
    // "/foo_bar") get distinct files instead of silently overwriting each other.
    const screenshot = path.join(outDir, `${index}-${slug(appPath)}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    manifest.push({ path: appPath, screenshot, errors: [...pageErrors] });
  }

  // Single delimited block, written straight to stdout, so it is unambiguous to find in the
  // runner's output and survives the line reporter.
  process.stdout.write(
    `\n===SMOKE_MANIFEST===\n${JSON.stringify(manifest, null, 2)}\n===END===\n`,
  );
  expect(manifest.length).toBe(paths.length);
});

function slug(appPath: string): string {
  const cleaned = appPath
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "root";
}
