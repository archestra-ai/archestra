/**
 * Shared utilities for worker-scoped authentication in Playwright tests.
 * This prevents race conditions when multiple workers share the same session.
 */
import type { Browser } from "@playwright/test";
import { UI_BASE_URL } from "./consts";
import { loginViaApi } from "./utils";

/**
 * Creates a worker-specific authenticated storage file.
 * Each worker authenticates independently and saves to its own storage file.
 */
export async function createWorkerAuthStorage(params: {
  browser: Browser;
  baseAuthFile: string;
  workerIndex: number;
  email: string;
  password: string;
  userType: string;
}): Promise<string> {
  const { browser, baseAuthFile, workerIndex, email, password, userType } =
    params;
  const workerStoragePath = `${baseAuthFile}.worker${workerIndex}`;

  // Create a fresh context and authenticate for this worker
  const context = await browser.newContext();
  const page = await context.newPage();

  // Authenticate via API
  const signedIn = await loginViaApi(page, email, password);
  if (!signedIn) {
    await context.close();
    throw new Error(
      `Worker ${workerIndex}: Failed to authenticate as ${userType}`,
    );
  }

  // Navigate to trigger cookie storage
  await page.goto(`${UI_BASE_URL}/chat`);
  await page.waitForLoadState("networkidle");

  // Save this worker's auth state
  await context.storageState({ path: workerStoragePath });
  await context.close();

  return workerStoragePath;
}

/**
 * Cleanup worker-specific auth file
 */
export async function cleanupWorkerAuthFile(path: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.unlink(path).catch(() => {});
}
