import { WIREMOCK_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";
import {
  createLlmProviderApiKey,
  expectChatReady,
  goToChat,
  goToLlmProviderApiKeysPage,
  hasLlmProviderApiKey,
} from "../utils";

const ORG_KEY_NAME = "chat-permissions-org-seed";

test.describe("Chat permissions — slim custom role", () => {
  test.setTimeout(60_000);

  test("basic-user role can access chat without the empty-state block", async ({
    adminPage,
    basicUserPage,
  }) => {
    await goToLlmProviderApiKeysPage(adminPage);
    if (!(await hasLlmProviderApiKey(adminPage, ORG_KEY_NAME))) {
      await createLlmProviderApiKey(adminPage, {
        name: ORG_KEY_NAME,
        apiKey: "sk-e2e-test",
        providerOptionName: "OpenAI OpenAI",
        scope: "org",
        baseUrl: `${WIREMOCK_BASE_URL}/v1`,
      });
    }

    await goToChat(basicUserPage);
    await expectChatReady(basicUserPage);

    await expect(
      basicUserPage.getByRole("heading", { name: /Add an LLM Provider Key/i }),
    ).not.toBeVisible();
  });
});
