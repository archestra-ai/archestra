import type { Page } from "@playwright/test";
import { E2eTestId } from "@shared";
import { expect, goToPage } from "../fixtures";
import { clickButton, expandTablePagination } from "../utils";

export async function goToChatApiKeysPage(page: Page): Promise<void> {
  await goToPage(page, "/llm/providers/api-keys");
  await expandTablePagination(page, E2eTestId.ChatApiKeysTable);
}

export async function goToVirtualKeysPage(page: Page): Promise<void> {
  await goToPage(page, "/llm/providers/virtual-keys");
  await expect(page.getByTestId(E2eTestId.VirtualKeysPage)).toBeVisible({
    timeout: 15_000,
  });
}

export async function createChatApiKey(
  page: Page,
  params: {
    name: string;
    apiKey: string;
    providerOptionName?: string | RegExp;
  },
): Promise<void> {
  await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
  await expect(
    page.getByRole("heading", { name: /Add API Key/i }),
  ).toBeVisible();

  if (params.providerOptionName) {
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page
      .getByRole("option", { name: params.providerOptionName })
      .click();
  }

  await page.getByLabel(/Name/i).fill(params.name);
  await page.getByRole("textbox", { name: /API Key/i }).fill(params.apiKey);
  await clickButton({ page, options: { name: "Test & Create" } });
  await expect(
    page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${params.name}`),
  ).toBeVisible({ timeout: 30_000 });
}

export async function deleteChatApiKey(
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
    parentKeyOptionName: string | RegExp;
  },
): Promise<void> {
  await page.getByTestId(E2eTestId.AddVirtualKeyButton).click();
  await expect(
    page.getByTestId(E2eTestId.VirtualKeyCreateDialog),
  ).toBeVisible();

  await page.getByTestId(E2eTestId.VirtualKeyParentKeySelect).click();
  await page
    .getByRole("option", { name: params.parentKeyOptionName })
    .click();
  await page.getByLabel(/Name/i).fill(params.name);
  await clickButton({ page, options: { name: "Create" } });

  await expect(
    page.getByRole("heading", { name: "Virtual API Key Created" }),
  ).toBeVisible({
    timeout: 10_000,
  });
}
