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
const otherAnthropicKey = makeLlmProviderApiKey({
  id: "key-anthropic-other",
  name: "Anthropic personal key",
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

// Provider-key mappings alone do not grant pool access. Only the virtual
// keys and app OAuth clients with an explicit pool grant can call it.
const pool: ModelPool = {
  id: "pool-fast-chat",
  organizationId: "test-org",
  name: POOL_NAME,
  routingStrategy: "weighted" as const,
  streamTimeoutSeconds: null,
  timeoutSeconds: null,
  cooldownSeconds: null,
  retrySettings: null,
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
      retrySettings: null,
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
      retrySettings: null,
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
    providerApiKeys: [],
    includeFutureProviders: true,
  }),
  makeVirtualKey({
    id: "vk-mixed",
    name: "Other Anthropic key",
    tokenStart: "archestra_mix",
    providerApiKeys: [mapping(otherAnthropicKey), mapping(openaiKey)],
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
    autoRouterIds: [],
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
    providerApiKeys: [],
    includeFutureProviders: true,
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
  poolOverrides = {},
}: {
  mswControl: MswControl;
  request: APIRequestContext;
  poolOverrides?: Partial<ModelPool>;
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
    {
      method: "get",
      url: "/api/model-pools",
      body: [{ ...pool, ...poolOverrides }],
    },
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
    // The managed list exposes automatic access; keep the LLM capability filter.
    {
      method: "get",
      url: "/api/oauth-clients",
      query: { capability: "llm:proxy" },
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
    },
  ]);
}

async function openConnectTab(page: Page) {
  await page.goto("/llm/model-pools");
  await page.getByText(POOL_NAME, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: POOL_NAME, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  return dialog;
}

test.describe("Model pool Connect tab", () => {
  test("offers only explicitly granted virtual keys and asks for the pool by name", async ({
    page,
    mswControl,
    request,
  }) => {
    await mockPool({ mswControl, request });
    const dialog = await openConnectTab(page);
    await expect(
      dialog.getByRole("heading", { name: "Choose a virtual key" }),
    ).toBeVisible();
    await dialog.getByRole("combobox", { name: "Virtual key" }).click();
    const options = page.getByRole("option");
    await expect(
      options.filter({ hasText: "Listed by the pool" }),
    ).toBeVisible();
    for (const name of [
      "Maps a member key",
      "Other Anthropic key",
      "Gemini only",
    ]) {
      await expect(options.filter({ hasText: name })).toHaveCount(0);
    }
    await expect(page.getByText("+ Create new key")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog.getByText("Create new virtual key")).toHaveCount(0);
    await expect(dialog.getByText('"model": "fast-chat"')).toBeVisible();
    await expect(
      dialog.getByText("/chat/completions", { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Model", { exact: true })).toHaveCount(0);
  });

  test("shows the granted pool request without visible provider keys", async ({
    page,
    mswControl,
    request,
  }) => {
    await mockPool({ mswControl, request });
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [],
    });
    const dialog = await openConnectTab(page);
    await expect(
      dialog.getByRole("combobox", { name: "Virtual key" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("combobox", { name: "Virtual key" }),
    ).toContainText("Listed by the pool");
    await expect(dialog.getByText('"model": "fast-chat"')).toBeVisible();
    await expect(
      dialog.getByText("/chat/completions", { exact: false }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Add provider key" }),
    ).toHaveCount(0);
  });

  test("explains how to grant access when no virtual key has the pool", async ({
    page,
    mswControl,
    request,
  }) => {
    await mockPool({
      mswControl,
      request,
      poolOverrides: { virtualApiKeyIds: [] },
    });
    const dialog = await openConnectTab(page);
    await expect(
      dialog.getByText(
        `No virtual key can call ${POOL_NAME} yet. Add the pool to a key from Virtual Keys.`,
      ),
    ).toBeVisible();
    await expect(dialog.getByText("Create new virtual key")).toHaveCount(0);
    await expect(
      dialog.getByRole("combobox", { name: "Virtual key" }),
    ).toHaveCount(0);
  });
});

test.describe("LLM Proxy pool discovery", () => {
  test("defaults a pool-only app OAuth client to its pool rather than the viewer catalog", async ({
    page,
    mswControl,
    request,
  }) => {
    await mockPool({ mswControl, request });
    // These personal keys are visible to the viewer but cannot become the
    // client's automatic shared-primary provider mappings.
    await mswControl.registerMany([
      { method: "get", url: "/api/llm-provider-api-keys", body: [openaiKey] },
      {
        method: "get",
        url: "/api/llm-models/available",
        body: [
          {
            id: "gpt-4o",
            dbId: "personal-model",
            displayName: "GPT-4o",
            provider: "openai",
            isFree: false,
          },
        ],
      },
    ]);
    await page.goto("/llm/proxy");
    await page.getByText("OAuth client", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "OAuth client", exact: true })
      .click();
    await page
      .getByRole("option")
      .filter({ hasText: "Granted the pool" })
      .click();
    await expect(page.getByText('"model": "fast-chat"')).toBeVisible();
    await page.getByRole("combobox", { name: "Model", exact: true }).click();
    await expect(
      page.getByRole("option").filter({ hasText: POOL_NAME }),
    ).toBeVisible();
    await expect(
      // Rows sit under their provider heading and show only the model id.
      page.getByRole("option", { name: "gpt-4o", exact: true }),
    ).toHaveCount(0);
  });

  test("keeps shared-primary model examples for an automatic app OAuth client", async ({
    page,
    mswControl,
    request,
  }) => {
    await mockPool({ mswControl, request });
    const sharedKey = makeLlmProviderApiKey({
      ...openaiKey,
      id: "shared-openai",
      scope: "org",
      userId: null,
    });
    await mswControl.registerMany([
      {
        method: "get",
        url: "/api/llm-provider-api-keys",
        body: [openaiKey, sharedKey],
      },
      {
        method: "get",
        url: "/api/llm-models/available",
        body: [
          {
            id: "gpt-4o",
            dbId: "personal-model",
            displayName: "GPT-4o",
            provider: "openai",
            isFree: false,
          },
        ],
      },
      {
        method: "get",
        url: "/api/llm-models",
        body: [
          {
            id: "shared-model",
            modelId: "gpt-4.1",
            provider: "openai",
            ignored: false,
            embeddingDimensions: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            apiKeys: [sharedKey],
          },
          {
            id: "personal-model",
            modelId: "gpt-4o",
            provider: "openai",
            ignored: false,
            embeddingDimensions: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            apiKeys: [openaiKey],
          },
        ],
      },
    ]);
    await page.goto("/llm/proxy");
    await page.getByText("OAuth client", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "OAuth client", exact: true })
      .click();
    await page
      .getByRole("option")
      .filter({ hasText: "Granted the pool" })
      .click();
    await expect(page.getByText('"model": "openai:gpt-4.1"')).toBeVisible();
    await page.getByRole("combobox", { name: "Model", exact: true }).click();
    await expect(
      page.getByRole("option").filter({ hasText: POOL_NAME }),
    ).toBeVisible();
    await expect(
      // Rows sit under their provider heading and show only the model id.
      page.getByRole("option", { name: "gpt-4.1", exact: true }),
    ).toBeVisible();
    await expect(
      // Rows sit under their provider heading and show only the model id.
      page.getByRole("option", { name: "gpt-4o", exact: true }),
    ).toHaveCount(0);
  });

  for (const { label, granted, ungranted, noun } of [
    {
      label: "Virtual key",
      granted: "Listed by the pool",
      ungranted: "Maps a member key",
      noun: "key",
    },
    {
      label: "OAuth client",
      granted: "Granted the pool",
      ungranted: "CI pipeline",
      noun: "client",
    },
  ]) {
    test(`does not count a disabled pool as provider access for a ${label}`, async ({
      page,
      mswControl,
      request,
    }) => {
      await mockPool({
        mswControl,
        request,
        poolOverrides: {
          members: pool.members.map((member) => ({
            ...member,
            enabled: false,
          })),
        },
      });
      await mswControl.use({
        method: "get",
        url: "/api/llm-provider-api-keys",
        body: [],
      });
      await page.goto("/llm/proxy");
      if (label === "OAuth client") {
        await page.getByText(label, { exact: true }).click();
      }
      await expect(
        page.getByRole("button", { name: "Add provider key" }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: label, exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText('"model": "fast-chat"')).toHaveCount(0);
    });

    for (const visibleProviderKeys of [true, false]) {
      test(`shows granted pools for an automatic ${label} without stored mappings and ${visibleProviderKeys ? "visible" : "no visible"} provider keys`, async ({
        page,
        mswControl,
        request,
      }) => {
        await mockPool({ mswControl, request });
        if (!visibleProviderKeys) {
          await mswControl.use({
            method: "get",
            url: "/api/llm-provider-api-keys",
            body: [],
          });
        }
        await page.goto("/llm/proxy");
        if (label === "OAuth client") {
          await page.getByText(label, { exact: true }).click();
        }
        const picker = page.getByRole("combobox", { name: label, exact: true });
        await picker.click();
        await page.getByRole("option").filter({ hasText: granted }).click();
        await page
          .getByRole("button", { name: `1 pool on this ${noun}` })
          .click();
        await expect(
          page.getByRole("listitem").filter({ hasText: /^fast-chat$/ }),
        ).toBeVisible();
        await page
          .getByRole("combobox", { name: "Model", exact: true })
          .click();
        await page.getByRole("option").filter({ hasText: POOL_NAME }).click();
        await expect(page.getByText('"model": "fast-chat"')).toBeVisible();
        if (label === "OAuth client") {
          await expect(
            page.getByText("client_id=granted-client"),
          ).toBeVisible();
          await expect(
            page.getByText(
              "$ARCHESTRA_LLM_ACCESS_TOKEN is the access_token from the token request above.",
            ),
          ).toBeVisible();
        }
        await picker.click();
        await page.getByRole("option").filter({ hasText: ungranted }).click();
        await expect(page.getByText(`No pools on this ${noun}`)).toBeVisible();
        // These credentials have no matching models in the catalog fixture;
        // switching away from the grant must also remove the pool request.
        await expect(page.getByText('"model": "fast-chat"')).toHaveCount(0);
      });
    }
  }
});
