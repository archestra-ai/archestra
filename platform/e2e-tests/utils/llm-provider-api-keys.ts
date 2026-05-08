import type { APIRequestContext, Page } from "@playwright/test";
import { E2eTestId } from "@shared";
import {
  getE2eRequestUrl,
  LLM_PROVIDER_API_KEYS_ROUTE,
  UI_BASE_URL,
} from "../consts";
import { expect, goToPage } from "../fixtures";
import { clickButton, expandTablePagination } from "./dialogs";

export async function goToLlmProviderApiKeysPage(page: Page): Promise<void> {
  await goToPage(page, "/llm/model-providers/api-keys");
  await expandTablePagination(page, E2eTestId.ChatApiKeysTable);
}

export async function goToVirtualKeysPage(page: Page): Promise<void> {
  await goToPage(page, "/llm/credentials/virtual-keys");
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
    scope?: "personal" | "org";
    baseUrl?: string;
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
  await expect(
    page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${params.name}`),
  ).toBeVisible({ timeout: 30_000 });
}

export async function deleteLlmProviderApiKey(
  page: Page,
  keyName: string,
): Promise<void> {
  const deleteButton = page.getByTestId(
    `${E2eTestId.DeleteChatApiKeyButton}-${keyName}`,
  );
  if (!(await deleteButton.isVisible().catch(() => false))) {
    return;
  }

  await deleteButton.click();
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
    await page.getByTestId(E2eTestId.VirtualKeyProviderSelect).click();
    if (params.parentProvider) {
      await page
        .getByRole("option", { name: new RegExp(params.parentProvider, "i") })
        .click();
    } else {
      await page.getByRole("option").first().click();
    }

    await page.getByTestId(E2eTestId.VirtualKeyParentKeySelect).click();
    await page.getByRole("option", { name: parentKeyOptionName }).click();
    await page.getByRole("button", { name: /^Add$/ }).click();
  }
  await page.getByLabel(/Name/i).fill(params.name);
  await clickButton({ page, options: { name: "Create" } });

  await expect(
    page.getByRole("heading", { name: "Virtual API Key Created" }),
  ).toBeVisible({
    timeout: 10_000,
  });
}

export async function deleteVisibleProviderKeys(
  request: APIRequestContext,
  provider: string,
): Promise<void> {
  const listResponse = await request.get(
    getE2eRequestUrl(
      `/api/llm-provider-api-keys?provider=${encodeURIComponent(provider)}`,
    ),
    {
      headers: {
        Origin: UI_BASE_URL,
      },
    },
  );

  if (!listResponse.ok()) {
    throw new Error(
      `Failed to list LLM provider API keys for ${provider}: ${listResponse.status()} ${await listResponse.text()}`,
    );
  }

  const keys = extractPaginatedArray<{ id: string }>(await listResponse.json());
  for (const key of keys) {
    await deleteVirtualKeysForProviderKey(request, key.id);

    const deleteResponse = await request.delete(
      getE2eRequestUrl(`/api/llm-provider-api-keys/${key.id}`),
      {
        headers: {
          Origin: UI_BASE_URL,
        },
      },
    );

    if (!deleteResponse.ok() && deleteResponse.status() !== 404) {
      throw new Error(
        `Failed to delete LLM provider API key ${key.id}: ${deleteResponse.status()} ${await deleteResponse.text()}`,
      );
    }
  }
}

async function deleteVirtualKeysForProviderKey(
  request: APIRequestContext,
  providerApiKeyId: string,
): Promise<void> {
  const listResponse = await request.get(
    getE2eRequestUrl(
      `/api/llm-virtual-keys?providerApiKeyId=${encodeURIComponent(providerApiKeyId)}&limit=100`,
    ),
    {
      headers: {
        Origin: UI_BASE_URL,
      },
    },
  );

  if (!listResponse.ok()) {
    throw new Error(
      `Failed to list virtual API keys for provider key ${providerApiKeyId}: ${listResponse.status()} ${await listResponse.text()}`,
    );
  }

  const virtualKeys = extractPaginatedArray<{ id: string }>(
    await listResponse.json(),
  );
  for (const virtualKey of virtualKeys) {
    const deleteResponse = await request.delete(
      getE2eRequestUrl(`/api/llm-virtual-keys/${virtualKey.id}`),
      {
        headers: {
          Origin: UI_BASE_URL,
        },
      },
    );

    if (!deleteResponse.ok() && deleteResponse.status() !== 404) {
      throw new Error(
        `Failed to delete virtual API key ${virtualKey.id}: ${deleteResponse.status()} ${await deleteResponse.text()}`,
      );
    }
  }
}

function extractPaginatedArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) {
    return data as T[];
  }

  if (
    data &&
    typeof data === "object" &&
    "data" in data &&
    Array.isArray(data.data)
  ) {
    return data.data as T[];
  }

  return [];
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
