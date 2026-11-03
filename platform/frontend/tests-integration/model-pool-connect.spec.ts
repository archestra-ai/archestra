import type { archestraApiTypes } from "@archestra/shared";
import type { APIRequestContext, Page } from "@playwright/test";
import {
  makeLlmProviderApiKey,
  makeVirtualKey,
  makeVirtualKeysList,
} from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";
import type { MswControl } from "./helpers/msw-control";

type ModelPool = archestraApiTypes.GetModelPoolsResponses["200"][number];
type OauthClient =
  archestraApiTypes.GetOauthClientsResponses["200"]["data"][number];

const POOL_NAME = "fast-chat";

const openaiKey = makeLlmProviderApiKey({
  id: "key-openai",
  name: "OpenAI team key",
  provider: "openai",
});
const anthropicKey = makeLlmProviderApiKey({
  id: "key-anthropic",
  name: "Anthropic team key",
  provider: "anthropic",
  isPrimary: false,
});
const geminiKey = makeLlmProviderApiKey({
  id: "key-gemini",
  name: "Gemini key",
  provider: "gemini",
});

function mapping(key: typeof openaiKey) {
  return {
    provider: key.provider,
    providerApiKeyId: key.id,
    providerApiKeyName: key.name,
  };
}

// The pool's members use the OpenAI and Anthropic keys and it lists one
// virtual key directly; anything mapping only the Gemini key can't call it.
const pool: ModelPool = {
  id: "pool-fast-chat",
  organizationId: "test-org",
  name: POOL_NAME,
  streamTimeoutSeconds: null,
  timeoutSeconds: null,
  cooldownSeconds: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  virtualApiKeyIds: ["vk-listed"],
  members: [
    {
      id: "member-openai",
      poolId: "pool-fast-chat",
      providerApiKeyId: openaiKey.id,
      providerApiKeyName: openaiKey.name,
      provider: "openai",
      modelId: "gpt-4o-mini",
      priority: 0,
      weight: 1,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      benchedUntil: null,
      benchReason: null,
    },
    {
      id: "member-anthropic",
      poolId: "pool-fast-chat",
      providerApiKeyId: anthropicKey.id,
      providerApiKeyName: anthropicKey.name,
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      priority: 1,
      weight: 1,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      benchedUntil: null,
      benchReason: null,
    },
  ],
};

const virtualKeys = [
  makeVirtualKey({
    id: "vk-member",
    name: "Maps a member key",
    tokenStart: "archestra_mem",
    providerApiKeys: [mapping(openaiKey)],
  }),
  makeVirtualKey({
    id: "vk-listed",
    name: "Listed by the pool",
    tokenStart: "archestra_lst",
    providerApiKeys: [mapping(geminiKey)],
  }),
  makeVirtualKey({
    id: "vk-unrelated",
    name: "Gemini only",
    tokenStart: "archestra_gem",
    providerApiKeys: [mapping(geminiKey)],
  }),
];

function oauthClient(overrides: Partial<OauthClient>): OauthClient {
  return {
    id: "oauth-client",
    clientId: "client-id",
    serviceAccountId: null,
    name: "OAuth client",
    organizationId: "test-org",
    grantType: "client_credentials",
    providerApiKeys: [],
    redirectUris: [],
    disabled: false,
    authorId: "test-user-admin",
    authorName: "Test Admin",
    createdBy: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    billingTeam: null,
    spendCap: null,
    scopes: ["llm:proxy"],
    allowedGatewayIds: [],
    includeFutureProviders: false,
    modelPoolIds: [],
    ...overrides,
  };
}

const oauthClients = [
  oauthClient({
    id: "oauth-member",
    clientId: "pool-ci-client",
    name: "CI pipeline",
    providerApiKeys: [mapping(anthropicKey)],
  }),
  oauthClient({
    id: "oauth-granted",
    clientId: "granted-client",
    name: "Granted the pool",
    providerApiKeys: [mapping(geminiKey)],
    modelPoolIds: [pool.id],
  }),
  oauthClient({
    id: "oauth-unrelated",
    clientId: "gemini-client",
    name: "Gemini batch",
    providerApiKeys: [mapping(geminiKey)],
  }),
];

async function mockPool({
  mswControl,
  request,
}: {
  mswControl: MswControl;
  request: APIRequestContext;
}) {
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/config",
      body: {
        ...config,
        features: { ...config.features, llmModelPoolsEnabled: true },
      },
    },
    { method: "get", url: "/api/model-pools", body: [pool] },
    {
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [openaiKey, anthropicKey, geminiKey],
    },
    {
      method: "get",
      url: "/api/llm-virtual-keys",
      body: makeVirtualKeysList({ keys: virtualKeys }),
    },
    // The LLM Proxy page lists clients from the first, the pool dialog from
    // the second, which carries each client's pool grants.
    ...["/api/llm-oauth-clients", "/api/oauth-clients"].map((url) => ({
      method: "get" as const,
      url,
      body: {
        data: oauthClients,
        pagination: {
          currentPage: 1,
          limit: 100,
          total: oauthClients.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
    })),
  ]);
}

async function openConnectDialog(page: Page) {
  await page.goto("/llm/model-pools");
  await page.getByRole("button", { name: `Connect ${POOL_NAME}` }).click();
  const dialog = page.getByRole("dialog", {
    name: `Connect to ${POOL_NAME}`,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Model pool Connect dialog", () => {
  test("offers only virtual keys that can call the pool and asks for it by name", async ({
    page,
    mswControl,
    request,
  }) => {
    await mockPool({ mswControl, request });
    const dialog = await openConnectDialog(page);

    await expect(
      dialog.getByRole("heading", { name: "Set up virtual key" }),
    ).toBeVisible();
    await dialog.getByRole("combobox", { name: "Virtual key" }).click();
    const options = page.getByRole("option");
    await expect(
      options.filter({ hasText: "Maps a member key" }),
    ).toBeVisible();
    await expect(
      options.filter({ hasText: "Listed by the pool" }),
    ).toBeVisible();
    await expect(options.filter({ hasText: "Gemini only" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await expect(dialog.getByText('"model": "fast-chat"')).toBeVisible();
    // The pool is the model, so there's no model to pick.
    await expect(dialog.getByLabel("Model", { exact: true })).toHaveCount(0);
  });

  test("shows where the OAuth access token comes from", async ({
    page,
    mswControl,
    request,
  }) => {
    await mockPool({ mswControl, request });
    const dialog = await openConnectDialog(page);

    await dialog.getByText("OAuth client", { exact: true }).click();
    await dialog.getByRole("combobox", { name: "OAuth client" }).click();
    await expect(
      page.getByRole("option").filter({ hasText: "CI pipeline" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option").filter({ hasText: "Granted the pool" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option").filter({ hasText: "Gemini batch" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    await expect(dialog.getByText("client_id=pool-ci-client")).toBeVisible();
    await expect(
      dialog.getByText(
        "$ARCHESTRA_LLM_ACCESS_TOKEN is the access_token from the token request above.",
      ),
    ).toBeVisible();
    await expect(dialog.getByText('"model": "fast-chat"')).toBeVisible();
  });

  test("on the Anthropic endpoint, offers keys mapping any member and asks for no Anthropic key", async ({
    page,
    mswControl,
    request,
  }) => {
    await mockPool({ mswControl, request });
    // The Anthropic member's key belongs to someone else.
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [openaiKey, geminiKey],
    });
    const dialog = await openConnectDialog(page);

    await dialog.getByText("Anthropic API", { exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: /Add Anthropic key/ }),
    ).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Virtual key" }).click();
    await expect(
      page.getByRole("option").filter({ hasText: "Maps a member key" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog.getByText('"model": "fast-chat"')).toBeVisible();
  });
});
