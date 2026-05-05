import { expect, type Locator, type Page } from "@playwright/test";

export async function closeOpenDialogs(
  page: Page,
  options?: { timeoutMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const start = Date.now();
  const dialogs = page.getByRole("dialog");

  while (Date.now() - start < timeoutMs) {
    const count = await dialogs.count();
    let hasVisibleDialog = false;
    for (let index = 0; index < count; index += 1) {
      if (await dialogs.nth(index).isVisible()) {
        hasVisibleDialog = true;
        break;
      }
    }

    if (!hasVisibleDialog) {
      return;
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    const closeButton = dialogs
      .getByRole("button", { name: /close|done|cancel/i })
      .first();
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click({ force: true, timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }

  await expect(dialogs).not.toBeVisible({ timeout: 1000 });
}

export async function expandTablePagination(
  page: Page,
  tableTestId: string,
): Promise<void> {
  const tableContainer = page.getByTestId(tableTestId);
  await expect(tableContainer).toBeVisible({ timeout: 10000 });
  const rowsPerPageSelect = tableContainer.getByRole("combobox");
  if (await rowsPerPageSelect.isVisible().catch(() => false)) {
    await rowsPerPageSelect.click();
    await page.getByRole("option", { name: "100" }).click();
  }
}

export async function clickButton({
  page,
  options,
  first,
  nth,
}: {
  page: Page;
  options: Parameters<Page["getByRole"]>[1];
  first?: boolean;
  nth?: number;
}) {
  let button = page.getByRole("button", {
    disabled: false,
    ...options,
  });

  if (first) {
    button = button.first();
  } else if (nth !== undefined) {
    button = button.nth(nth);
  }

  return await button.click();
}

export async function waitForElementWithReload(
  page: Page,
  locator: Locator,
  options?: {
    timeout?: number;
    intervals?: number[];
    checkEnabled?: boolean;
  },
): Promise<void> {
  const timeout = options?.timeout ?? 90_000;
  const intervals = options?.intervals ?? [2000, 5000, 10000];
  const checkEnabled = options?.checkEnabled ?? true;

  let attempts = 0;
  await expect(async () => {
    attempts++;
    if (attempts > 1) {
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
    }
    await expect(locator).toBeVisible({ timeout: 5000 });
    if (checkEnabled) {
      await expect(locator).toBeEnabled({ timeout: 5000 });
    }
  }).toPass({ timeout, intervals });
}
