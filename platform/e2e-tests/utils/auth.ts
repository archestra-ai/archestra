import { expect, type Locator, type Page } from "@playwright/test";
import { E2eTestId } from "@shared";
import { UI_BASE_URL } from "../consts";

export async function expectAuthenticated(
  page: Page,
  timeout = 30000,
): Promise<void> {
  const sidebar = page.locator("[data-slot=sidebar]");
  const hasSidebar = await sidebar
    .isVisible({ timeout: 2_000 })
    .catch(() => false);

  if (hasSidebar) {
    await expandSidebar(page);
    await expect(page.getByTestId(E2eTestId.SidebarUserProfile)).toBeVisible({
      timeout,
    });
    return;
  }

  await expect(page).not.toHaveURL(/\/auth\/sign-in/, { timeout });
}

export async function expandSidebar(page: Page): Promise<void> {
  const sidebar = page.locator("[data-slot=sidebar]");
  if (!(await sidebar.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return;
  }
  const state = await sidebar.getAttribute("data-state");
  if (state === "collapsed") {
    const trigger = page.locator("[data-sidebar=trigger]").first();
    if (await trigger.isVisible({ timeout: 2000 }).catch(() => false)) {
      await trigger.click();
    } else {
      await page.keyboard.press("ControlOrMeta+b");
    }
  }
}

export async function loginViaApi(
  page: Page,
  email: string,
  password: string,
  maxRetries = 3,
): Promise<boolean> {
  let delay = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await page.request.post(
      `${UI_BASE_URL}/api/auth/sign-in/email`,
      {
        data: { email, password },
        headers: { Origin: UI_BASE_URL },
      },
    );

    if (response.ok()) {
      return true;
    }

    if (
      (response.status() === 429 || response.status() >= 500) &&
      attempt < maxRetries
    ) {
      await page.waitForTimeout(delay);
      delay *= 2;
      continue;
    }

    return false;
  }

  return false;
}

export async function loginViaUi(
  page: Page,
  email: string,
  password: string,
  options: { skipDefaultPasswordPrompt?: boolean } = {},
): Promise<void> {
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByTestId(E2eTestId.SignInSubmitButton).click();
  if (options.skipDefaultPasswordPrompt !== false) {
    await skipDefaultPasswordChangePromptIfVisible(page);
  }
}

async function skipDefaultPasswordChangePromptIfVisible(
  page: Page,
): Promise<void> {
  const promptVisible = await page
    .getByTestId(E2eTestId.DefaultPasswordChangePrompt)
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (promptVisible) {
    await page.getByTestId(E2eTestId.DefaultPasswordChangeSkipButton).click();
  }
}

export async function navigateAndVerifyAuth(params: {
  page: Page;
  path: string;
  email: string;
  password: string;
  verifyLocator: Locator;
  goToPage: (page: Page, path: string) => Promise<void>;
  timeout?: number;
  intervals?: number[];
}): Promise<void> {
  const {
    page,
    path,
    email,
    password,
    verifyLocator,
    timeout = 90_000,
    intervals = [3000, 5000, 10000],
  } = params;

  await expect(async () => {
    await params.goToPage(page, path);
    await page.waitForLoadState("domcontentloaded");
    const loginButton = page.getByTestId(E2eTestId.SignInSubmitButton);
    if (await loginButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await loginViaApi(page, email, password);
      await params.goToPage(page, path);
      await page.waitForLoadState("domcontentloaded");
    }
    await expect(verifyLocator).toBeVisible({ timeout: 10_000 });
    await expect(verifyLocator).toBeEnabled({ timeout: 5_000 });
  }).toPass({ timeout, intervals });
}
