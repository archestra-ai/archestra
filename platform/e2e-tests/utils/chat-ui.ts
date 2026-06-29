import {
  E2eTestId,
  getChatApiKeySelectorOptionTestId,
  getChatApiKeySelectorProviderGroupTestId,
} from "@archestra/shared";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import {
  LLM_PROVIDER_API_KEYS_AVAILABLE_ROUTE,
  LLM_PROVIDER_API_KEYS_ROUTE,
  WIREMOCK_INTERNAL_URL,
} from "../consts";
import { expect, goToPage } from "../fixtures";

type MakeApiRequest = (args: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  ignoreStatusCheck?: boolean;
}) => Promise<APIResponse>;

type SyncModels = (request: APIRequestContext) => Promise<APIResponse>;

interface RuntimeChatModel {
  provider: string;
  id: string;
  displayName: string;
}

interface ReadyChatProvider {
  apiKeyId: string;
  runtimeModel: RuntimeChatModel;
}

interface AvailableLlmProviderApiKey {
  id: string;
  name: string;
  provider: string;
  baseUrl?: string | null;
  inferenceBaseUrl?: string | null;
  bestModelId?: string | null;
}

const AVAILABLE_LLM_MODELS_ROUTE = "/api/llm-models/available";
const E2E_ANTHROPIC_PROVIDER = "anthropic";
const E2E_ANTHROPIC_KEY_NAME = "E2E Anthropic WireMock Chat Key";
const E2E_ANTHROPIC_API_KEY = "sk-ant-e2e-wiremock";
const E2E_ANTHROPIC_BASE_URL = `${WIREMOCK_INTERNAL_URL}/anthropic`;

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

export async function getRuntimeModelForProviderFromApi(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  providerName: string,
): Promise<RuntimeChatModel | null> {
  const query = new URLSearchParams({ provider: providerName });
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `${AVAILABLE_LLM_MODELS_ROUTE}?${query.toString()}`,
  });

  const models = (await response.json()) as RuntimeChatModel[];
  return models.find((entry) => entry.provider === providerName) ?? null;
}

// Keep this as real backend setup: browser-route mocks would only satisfy the
// UI empty-state, while this e2e verifies active-run persistence/replay.
export async function ensureWireMockAnthropicChatProvider(params: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
  syncModels: SyncModels;
}): Promise<ReadyChatProvider> {
  const { request, makeApiRequest, syncModels } = params;
  let apiKeyId = await findWireMockAnthropicKeyId({
    request,
    makeApiRequest,
  });

  if (!apiKeyId) {
    apiKeyId = await createWireMockAnthropicKey({ request, makeApiRequest });
  }

  await syncModels(request);
  const runtimeModel = await waitForRuntimeModel({
    request,
    makeApiRequest,
    provider: E2E_ANTHROPIC_PROVIDER,
  });

  return { apiKeyId, runtimeModel };
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

export async function selectApiKeyById(
  page: Page,
  apiKeyId: string,
): Promise<void> {
  const trigger = page.getByTestId(E2eTestId.ChatApiKeySelectorTrigger).first();
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  const keyOption = page.getByTestId(
    getChatApiKeySelectorOptionTestId(apiKeyId),
  );
  await expect(keyOption).toBeVisible({ timeout: 10_000 });
  await keyOption.click();

  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

export async function selectRuntimeModelFromDialog(
  page: Page,
  runtimeModel: RuntimeChatModel,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Select Model" });
  const modelOptionPattern = buildModelOptionPattern(runtimeModel);
  const searchInput = dialog.getByPlaceholder("Search models...");
  const emptyState = dialog.getByText("No models found.");
  const refreshButton = dialog.getByRole("button", {
    name: /refresh models/i,
  });
  const exactModelOption = dialog
    .getByRole("option")
    .filter({ hasText: `(${runtimeModel.id})` });
  const displayNameModelOption = dialog
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
      exactModelOption.or(displayNameModelOption).first(),
    ).toBeVisible();
  }).toPass({ timeout: 25_000, intervals: [500, 1000, 2000, 5000] });

  if (
    await exactModelOption
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await exactModelOption.first().click();
  } else {
    await displayNameModelOption.first().click();
  }

  await expect(dialog)
    .not.toBeVisible({ timeout: 2_000 })
    .catch(async () => {
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    });
}

function buildModelOptionPattern(model: RuntimeChatModel): RegExp {
  const displayName = escapeRegExp(model.displayName);
  const modelId = escapeRegExp(model.id);
  // Lone-name alternatives use (?![-\w]) so e.g. id "sonar" does not match a
  // sibling option's "sonar-deep-research". Without this guard the click-time
  // fallback could land on the wrong model.
  return new RegExp(
    `${displayName}\\s*\\(${modelId}\\)|${modelId}(?![-\\w])|${displayName}(?![-\\w])`,
    "i",
  );
}

async function findWireMockAnthropicKeyId({
  request,
  makeApiRequest,
}: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
}): Promise<string | null> {
  const keys = await getAvailableKeysForProvider({
    request,
    makeApiRequest,
    provider: E2E_ANTHROPIC_PROVIDER,
  });
  return (
    keys.find(
      (key) =>
        key.name === E2E_ANTHROPIC_KEY_NAME &&
        key.baseUrl === E2E_ANTHROPIC_BASE_URL &&
        key.inferenceBaseUrl === E2E_ANTHROPIC_BASE_URL,
    )?.id ?? null
  );
}

async function createWireMockAnthropicKey({
  request,
  makeApiRequest,
}: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
}): Promise<string> {
  const createResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: LLM_PROVIDER_API_KEYS_ROUTE,
    data: {
      name: E2E_ANTHROPIC_KEY_NAME,
      provider: E2E_ANTHROPIC_PROVIDER,
      apiKey: E2E_ANTHROPIC_API_KEY,
      baseUrl: E2E_ANTHROPIC_BASE_URL,
      inferenceBaseUrl: E2E_ANTHROPIC_BASE_URL,
      scope: "personal",
    },
  });

  const createdKey = (await createResponse.json()) as { id: string };
  return createdKey.id;
}

async function getAvailableKeysForProvider({
  request,
  makeApiRequest,
  provider,
}: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
  provider: string;
}): Promise<AvailableLlmProviderApiKey[]> {
  const query = new URLSearchParams({ provider });
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `${LLM_PROVIDER_API_KEYS_AVAILABLE_ROUTE}?${query.toString()}`,
  });

  return (await response.json()) as AvailableLlmProviderApiKey[];
}

async function waitForRuntimeModel({
  request,
  makeApiRequest,
  provider,
}: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
  provider: string;
}): Promise<RuntimeChatModel> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const runtimeModel = await getRuntimeModelForProviderFromApi(
        makeApiRequest,
        request,
        provider,
      );
      if (runtimeModel) {
        return runtimeModel;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `No runtime model became available for ${provider}${
      lastError ? `: ${lastError.message}` : ""
    }`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
