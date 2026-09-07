import { E2eTestId, PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import type { APIRequestContext } from "@playwright/test";
import { goToPage } from "../fixtures";
import {
  ensureWireMockAnthropicChatProvider,
  expectChatReady,
  goToChat,
} from "../utils";
import { expect, type TestFixtures, test } from "./api-fixtures";

test.describe.configure({ retries: 2 });

// Slow delegation discovery must not block drafting a message.
const BROWSER_CHECK_ROUTE = "**/api/agents/*/delegations*";

const SETUP_CARD = "Browser Setup Required";

test.describe("Chat browser setup", () => {
  test("leaves the composer usable while delegation discovery is in flight", async ({
    page,
    request,
    makeApiRequest,
    syncModels,
    createAgent,
  }) => {
    await ensureWireMockAnthropicChatProvider({
      request,
      makeApiRequest,
      syncModels,
    });

    const conversationId = await createConversation({
      request,
      makeApiRequest,
      createAgent,
      agentName: `Browser setup check ${Date.now()}`,
    });

    await goToChat(page);
    await expectChatReady(page);

    // Keep discovery pending throughout the composer assertions.
    await page.route(BROWSER_CHECK_ROUTE, () => {});

    await goToPage(page, `/chat/${conversationId}`);

    // Drafting remains available even when related tooling has not loaded.
    const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(textarea).toBeEditable();
    await textarea.fill("typed while the browser check was still running");
    await expect(textarea).toHaveValue(
      "typed while the browser check was still running",
    );

    await expect(page.getByText(SETUP_CARD)).toHaveCount(0);
  });

  test("keeps the composer usable with Playwright tools and no personal browser installation", async ({
    page,
    request,
    makeApiRequest,
    syncModels,
    createAgent,
  }) => {
    await ensureWireMockAnthropicChatProvider({
      request,
      makeApiRequest,
      syncModels,
    });

    const conversationId = await createConversation({
      request,
      makeApiRequest,
      createAgent,
      agentName: `Browser setup required ${Date.now()}`,
    });

    await goToChat(page);
    await expectChatReady(page);

    // Playwright is managed by the platform. Discovering a browser tool must
    // never replace the composer with a personal installation prompt.
    await page.route("**/api/agents/*/tools*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "00000000-0000-4000-8000-0000000000ff",
            name: "microsoft__playwright-mcp__browser_navigate",
            description: "Navigate to a URL",
            catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
            delegateToAgentId: null,
          },
        ]),
      });
    });

    await goToPage(page, `/chat/${conversationId}`);

    const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
    await expect(textarea).toBeEditable({ timeout: 15_000 });
    await textarea.fill("browse with the managed runtime");
    await expect(textarea).toHaveValue("browse with the managed runtime");
    await expect(page.getByText(SETUP_CARD)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Install Browser" }),
    ).toHaveCount(0);
  });
});

/**
 * A conversation on a brand-new agent, made through the API so the test does
 * not have to drive a whole message exchange to reach the composer this is
 * about. A fresh agent keeps the tool list — the thing the check reads —
 * independent of whatever else the suite has assigned.
 */
async function createConversation(params: {
  request: APIRequestContext;
  makeApiRequest: TestFixtures["makeApiRequest"];
  createAgent: TestFixtures["createAgent"];
  agentName: string;
}): Promise<string> {
  const { request, makeApiRequest, createAgent, agentName } = params;

  const agentResponse = await createAgent(request, agentName, "personal");
  const agent = (await agentResponse.json()) as { id: string };

  const conversationResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/chat/conversations",
    data: { agentId: agent.id },
  });
  const conversation = (await conversationResponse.json()) as { id: string };

  return conversation.id;
}
