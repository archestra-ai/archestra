import {
  E2eTestId,
  getChatApiKeySelectorOptionTestId,
  getChatApiKeySelectorProviderGroupTestId,
  getChatModelOptionTestId,
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
  dbId: string;
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

/**
 * First catalogued model for a provider, or the first one `matchModel` accepts.
 * Pass the predicate when the provider serves more than one upstream API and
 * the test only stubs one of them: the catalogue is ordered by model id, so
 * which transport an unfiltered pick lands on changes whenever the provider
 * gains a model that sorts earlier.
 */
export async function getRuntimeModelForProviderFromApi(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  providerName: string,
  matchModel?: (model: RuntimeChatModel) => boolean,
): Promise<RuntimeChatModel | null> {
  const query = new URLSearchParams({ provider: providerName });
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `${AVAILABLE_LLM_MODELS_ROUTE}?${query.toString()}`,
  });

  const models = (await response.json()) as RuntimeChatModel[];
  return (
    models.find(
      (entry) =>
        entry.provider === providerName && (matchModel?.(entry) ?? true),
    ) ?? null
  );
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
  const menu = await openSetupMenuTab(page, /^Key:/);
  const providerGroup = menu.getByTestId(
    getChatApiKeySelectorProviderGroupTestId(provider),
  );
  await expect(providerGroup).toBeVisible({ timeout: 10_000 });
  const keyOption = providerGroup.getByRole("option").first();
  await expect(keyOption).toBeVisible({ timeout: 10_000 });
  await keyOption.click();
  await closeSetupMenu(page);
}

export async function selectApiKeyById(
  page: Page,
  apiKeyId: string,
): Promise<void> {
  const menu = await openSetupMenuTab(page, /^Key:/);
  const keyOption = menu.getByTestId(
    getChatApiKeySelectorOptionTestId(apiKeyId),
  );
  await expect(keyOption).toBeVisible({ timeout: 10_000 });
  await keyOption.click();
  await closeSetupMenu(page);
}

/** Picks a model in the composer's setup menu, which must already be open. */
export async function selectRuntimeModelFromDialog(
  page: Page,
  runtimeModel: RuntimeChatModel,
): Promise<void> {
  const menu = page.getByTestId(E2eTestId.ChatSetupMenu);
  await expect(menu).toBeVisible({ timeout: 5_000 });
  const modelTab = menu.getByRole("tab", { name: /^Model:/ });
  if ((await modelTab.getAttribute("aria-selected")) !== "true") {
    await modelTab.click();
  }
  const searchInput = menu.getByPlaceholder("Search models…");
  const modelOption = menu
    .getByTestId(getChatModelOptionTestId(runtimeModel.id))
    .first();

  // Models load per key, so the option can trail the key switch.
  await expect(async () => {
    await searchInput.fill(runtimeModel.id);
    await expect(modelOption).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 25_000, intervals: [500, 1000, 2000, 5000] });

  await modelOption.click();
  await expect(menu).not.toBeVisible({ timeout: 5_000 });
}

async function openSetupMenuTab(page: Page, tabName: RegExp) {
  const trigger = page.getByTestId(E2eTestId.ChatModelSelectorTrigger).first();
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  const menu = page.getByTestId(E2eTestId.ChatSetupMenu);
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await menu.getByRole("tab", { name: tabName }).click();
  return menu;
}

async function closeSetupMenu(page: Page) {
  // Picking a key keeps the menu open on its Model tab.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(E2eTestId.ChatSetupMenu)).not.toBeVisible({
    timeout: 5_000,
  });
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
