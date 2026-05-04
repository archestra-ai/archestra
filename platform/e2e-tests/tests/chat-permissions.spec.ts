import type { APIRequestContext } from "@playwright/test";
import {
  getE2eRequestUrl,
  LLM_PROVIDER_API_KEYS_ROUTE,
  UI_BASE_URL,
  WIREMOCK_INTERNAL_URL,
} from "../consts";
import { expect, test } from "../fixtures";
import { expectChatReady, goToChat } from "../utils";

const ORG_KEY_NAME = "chat-permissions-org-seed";

test.describe("Chat permissions — slim custom role", () => {
  test.setTimeout(60_000);

  test("basic-user role can access chat without the empty-state block", async ({
    adminPage,
    basicUserPage,
  }) => {
    await ensureOrgProviderKey(adminPage.request);

    await goToChat(basicUserPage);
    await expectChatReady(basicUserPage);

    await expect(
      basicUserPage.getByRole("heading", { name: /Add an LLM Provider Key/i }),
    ).not.toBeVisible();
  });
});

async function ensureOrgProviderKey(request: APIRequestContext): Promise<void> {
  const listResponse = await request.get(
    getE2eRequestUrl(LLM_PROVIDER_API_KEYS_ROUTE),
    {
      headers: { Origin: UI_BASE_URL },
    },
  );

  if (!listResponse.ok()) {
    throw new Error(
      `Failed to list LLM provider API keys: ${listResponse.status()} ${await listResponse.text()}`,
    );
  }

  const keys = (await listResponse.json()) as Array<{ name: string }>;
  if (keys.some((key) => key.name === ORG_KEY_NAME)) {
    return;
  }

  const createResponse = await request.post(
    getE2eRequestUrl(LLM_PROVIDER_API_KEYS_ROUTE),
    {
      headers: {
        "Content-Type": "application/json",
        Origin: UI_BASE_URL,
      },
      data: {
        name: ORG_KEY_NAME,
        provider: "openai",
        apiKey: "sk-e2e-test",
        scope: "org",
        baseUrl: `${WIREMOCK_INTERNAL_URL}/v1`,
      },
    },
  );

  if (!createResponse.ok()) {
    throw new Error(
      `Failed to create org LLM provider API key: ${createResponse.status()} ${await createResponse.text()}`,
    );
  }
}
