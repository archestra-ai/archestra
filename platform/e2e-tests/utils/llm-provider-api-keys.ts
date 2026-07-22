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
    // First-run screens front the create dialog with a "Paste an API key" card.
    .or(page.getByTestId(E2eTestId.QuickstartAddApiKeyButton))
    .or(page.getByRole("button", { name: /^Add API Key$/i }))
    .first();
  await expect(addApiKeyButton).toBeVisible({ timeout: 15_000 });
  await addApiKeyButton.click();
  await expect(
    page.getByRole("heading", { name: /Add API Key/i }),
  ).toBeVisible();

  if (params.providerOptionName) {
    // The provider picker is a searchable catalog (a combobox button that opens
    // a command list), not a plain select. Open it, then pick the option.
    await page
      .getByTestId(E2eTestId.AddApiKeyProviderSelect)
      .getByRole("button")
      .click();
    await page.getByRole("option", { name: params.providerOptionName }).click();
  }

  // The create flow has no Name field (the key is auto-named after the provider).
  await page.getByRole("textbox", { name: /API Key/i }).fill(params.apiKey);

  // Scope and base URL now live behind the collapsed "Advanced settings" section.
  if (params.scope === "org" || params.baseUrl) {
    await page.getByTestId(E2eTestId.AddApiKeyAdvancedToggle).click();
  }

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
  // The create flow now confirms with the provider's discovered model list;
  // click "Done" to close the dialog (and, in the first-run flow, advance).
  await clickButton({ page, options: { name: "Done" } });
  if (params.waitForRow !== false) {
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${params.name}`),
    ).toBeVisible({ timeout: 30_000 });
  }
}
