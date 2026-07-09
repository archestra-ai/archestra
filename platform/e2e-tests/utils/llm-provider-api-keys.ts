import { E2eTestId } from "@archestra/shared";
import type { Page } from "@playwright/test";
import { expect } from "../fixtures";
import { clickButton } from "./dialogs";

export async function createLlmProviderApiKey(
  page: Page,
  params: {
    name: string;
    apiKey: string;
    providerOptionName?: string | RegExp;
    scope?: "personal" | "org";
    baseUrl?: string;
    // The row assertion only applies when the caller is on the API keys
    // management page. Quickstart-style flows host the create dialog on /chat
    // and redirect back to /chat on success, where ChatApiKeyRow does not exist.
    waitForRow?: boolean;
  },
): Promise<void> {
  const addApiKeyButton = page
    .getByTestId(E2eTestId.AddChatApiKeyButton)
    .or(page.getByRole("button", { name: /^Add API Key$/i }))
    .first();
  await expect(addApiKeyButton).toBeVisible({ timeout: 15_000 });
  await addApiKeyButton.click();
  await expect(
    page.getByRole("heading", { name: /Add API Key/i }),
  ).toBeVisible();

  if (params.providerOptionName) {
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: params.providerOptionName }).click();
  }

  await page.getByLabel(/Name/i).fill(params.name);
  await page.getByRole("textbox", { name: /API Key/i }).fill(params.apiKey);

  if (params.scope === "org") {
    // Scope selector is a collapsible custom control — click the current
    // ("Personal") option to expand it before picking "Organization".
    await page.getByRole("button", { name: /^Personal/ }).click();
    await page.getByRole("button", { name: /^Organization/ }).click();
  }

  if (params.baseUrl) {
    await page.getByLabel(/Base URL/i).fill(params.baseUrl);
  }

  await clickButton({ page, options: { name: "Test & Create" } });
  // The success toast confirms the upstream test passed and the row will be
  // populated by the next refetch — observing it first turns a single 30 s
  // poll on the row into two cheaper waits and surfaces clearer errors when
  // "Test & Create" itself fails.
  await expect(page.getByText("API key created successfully")).toBeVisible({
    timeout: 30_000,
  });
  if (params.waitForRow !== false) {
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${params.name}`),
    ).toBeVisible({ timeout: 30_000 });
  }
}
