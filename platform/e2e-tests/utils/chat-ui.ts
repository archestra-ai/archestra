import type { Page } from "@playwright/test";
import { E2eTestId, getChatApiKeySelectorProviderGroupTestId } from "@shared";
import { expect, goToPage } from "../fixtures";

export interface RuntimeChatModel {
  provider: string;
  id: string;
  displayName: string;
}

export async function goToChat(
  page: Page,
  options?: { agentId?: string },
): Promise<void> {
  const searchParams = new URLSearchParams();
  if (options?.agentId) {
    searchParams.set("agentId", options.agentId);
  }

  const path = searchParams.size > 0 ? `/chat?${searchParams}` : "/chat";
  await goToPage(page, path);
  await page.waitForLoadState("domcontentloaded");
}

export async function expectChatReady(page: Page): Promise<void> {
  await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeVisible({
    timeout: 15_000,
  });
}

export async function sendChatMessage(
  page: Page,
  message: string,
): Promise<void> {
  const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  await textarea.fill(message);
  await page.keyboard.press("Enter");
}

export async function getRuntimeModelForProvider(
  page: Page,
  providerName: string,
): Promise<RuntimeChatModel | null> {
  return page.evaluate(async (provider) => {
    const response = await fetch("/api/chat/models", {
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(
        `Failed to load chat models: ${response.status} ${response.statusText}`,
      );
    }

    const models = (await response.json()) as RuntimeChatModel[];
    return models.find((entry) => entry.provider === provider) ?? null;
  }, providerName);
}

export async function selectApiKeyForProvider(
  page: Page,
  provider: string,
): Promise<void> {
  const trigger = page.getByTestId(E2eTestId.ChatApiKeySelectorTrigger).first();
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  const providerGroup = page.getByTestId(
    getChatApiKeySelectorProviderGroupTestId(provider),
  );
  await expect(providerGroup).toBeVisible({ timeout: 10_000 });

  const keyOption = providerGroup.getByRole("option").first();
  await expect(keyOption).toBeVisible({ timeout: 10_000 });
  await keyOption.click();

  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

export async function selectRuntimeModelFromDialog(
  page: Page,
  runtimeModel: RuntimeChatModel,
): Promise<void> {
  const modelOptionPattern = buildModelOptionPattern(runtimeModel);
  const searchInput = page.getByPlaceholder("Search models...");
  const emptyState = page.getByText("No models found.");
  const refreshButton = page.getByRole("button", { name: /refresh models/i });
  const exactModelOption = page
    .getByRole("option")
    .filter({ hasText: `(${runtimeModel.id})` });
  const displayNameModelOption = page
    .getByRole("option")
    .filter({ hasText: modelOptionPattern });

  await expect(async () => {
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill(runtimeModel.id);
    }

    if (
      (await exactModelOption
        .first()
        .isVisible()
        .catch(() => false)) ||
      (await displayNameModelOption
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      return;
    }

    if (await emptyState.isVisible().catch(() => false)) {
      if (await refreshButton.isVisible().catch(() => false)) {
        await refreshButton.click();
      }
      if (await searchInput.isVisible().catch(() => false)) {
        await searchInput.clear();
      }
    }

    await expect(
      exactModelOption.first().or(displayNameModelOption.first()),
    ).toBeVisible();
  }).toPass({ timeout: 25_000, intervals: [500, 1000, 2000, 5000] });

  if (
    await exactModelOption
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await exactModelOption.first().click();
    return;
  }

  await displayNameModelOption.first().click();
}

function buildModelOptionPattern(model: RuntimeChatModel): RegExp {
  const displayName = escapeRegExp(model.displayName);
  const modelId = escapeRegExp(model.id);
  return new RegExp(
    `${displayName}\\s*\\(${modelId}\\)|${modelId}|${displayName}`,
    "i",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
