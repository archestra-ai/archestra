import type { Page } from "@playwright/test";
import { E2eTestId } from "@shared";
import { expect, goToPage } from "../fixtures";
import { LLM_PROVIDER_API_KEYS_ROUTE } from "../tests/api/fixtures";
import { clickButton, expandTablePagination } from "./dialogs";

export async function goToLlmProviderApiKeysPage(page: Page): Promise<void> {
  await goToPage(page, "/llm/providers/api-keys");
  await expandTablePagination(page, E2eTestId.ChatApiKeysTable);
}

export async function goToVirtualKeysPage(page: Page): Promise<void> {
  await goToPage(page, "/llm/providers/virtual-keys");
  await expect(page.getByTestId(E2eTestId.VirtualKeysPage)).toBeVisible({
    timeout: 15_000,
  });
}

export async function createLlmProviderApiKey(
  page: Page,
  params: {
    name: string;
    apiKey: string;
    providerOptionName?: string | RegExp;
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
  await clickButton({ page, options: { name: "Test & Create" } });
  await expect(
    page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${params.name}`),
  ).toBeVisible({ timeout: 30_000 });
}

export async function deleteLlmProviderApiKey(
  page: Page,
  keyName: string,
): Promise<void> {
  await page
    .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${keyName}`)
    .click();
  await clickButton({ page, options: { name: "Delete" } });
}

export async function createVirtualKey(
  page: Page,
  params: {
    name: string;
    parentKeyOptionName?: string | RegExp;
    parentProvider?: string;
  },
): Promise<void> {
  await page.getByTestId(E2eTestId.AddVirtualKeyButton).click();
  await expect(
    page.getByTestId(E2eTestId.VirtualKeyCreateDialog),
  ).toBeVisible();

  const parentKeyOptionName =
    params.parentKeyOptionName ??
    (params.parentProvider
      ? await getParentKeyOptionNameForProvider(page, params.parentProvider)
      : null);

  if (parentKeyOptionName) {
    await page.getByTestId(E2eTestId.VirtualKeyParentKeySelect).click();
    await page.getByRole("option", { name: parentKeyOptionName }).click();
  }
  await page.getByLabel(/Name/i).fill(params.name);
  await clickButton({ page, options: { name: "Create" } });

  await expect(
    page.getByRole("heading", { name: "Virtual API Key Created" }),
  ).toBeVisible({
    timeout: 10_000,
  });
}

async function getParentKeyOptionNameForProvider(
  page: Page,
  provider: string,
): Promise<string> {
  return page.evaluate(
    async ({ targetProvider, route }) => {
      const response = await fetch(
        `${route}?provider=${encodeURIComponent(targetProvider)}`,
        {
          credentials: "include",
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to load LLM provider API keys for ${targetProvider}: ${response.status} ${response.statusText}`,
        );
      }

      const apiKeys = (await response.json()) as Array<{ name: string }>;
      const matchingKey = apiKeys[0];

      if (!matchingKey?.name) {
        throw new Error(
          `No LLM provider API keys found for provider ${targetProvider}`,
        );
      }

      return matchingKey.name;
    },
    { targetProvider: provider, route: LLM_PROVIDER_API_KEYS_ROUTE },
  );
}
