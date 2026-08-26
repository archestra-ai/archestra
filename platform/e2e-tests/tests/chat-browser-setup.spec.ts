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

/**
 * The composer asks "does this user need to install a browser?" by way of three
 * dependent waves of requests: the agent's tools, its delegations, and one more
 * per enabled sub-agent. The screen no longer waits behind them, so the answer
 * arrives while a conversation is already on screen and the composer has to be
 * right about the *unresolved* state as well as the resolved one.
 *
 * Holding the delegations lookup open forever is what makes that window
 * observable at all — it asserts a rule about the state rather than racing a
 * stopwatch against it.
 */
const BROWSER_CHECK_ROUTE = "**/api/agents/*/delegations*";

const SETUP_CARD = "Browser Setup Required";

test.describe("Chat browser setup", () => {
  test("leaves the composer alone while the browser-tooling check is in flight", async ({
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

    // Held open for the rest of the test: the check can never resolve, so
    // anything the composer shows here is what it shows while it does not know.
    await page.route(BROWSER_CHECK_ROUTE, () => {});

    await goToPage(page, `/chat/${conversationId}`);

    // "We are still checking" is not "you need to install a browser". The
    // message input keeps its place and stays typeable — this agent has no
    // browser tools at all, and even one that did would not have earned the
    // card until the check came back.
    const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(textarea).toBeEditable();
    await textarea.fill("typed while the browser check was still running");
    await expect(textarea).toHaveValue(
      "typed while the browser check was still running",
    );

    await expect(page.getByText(SETUP_CARD)).toHaveCount(0);
  });

  test("hands the composer over to the setup card once a browser is known to be missing", async ({
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

    // The other half of the rule, and what keeps the assertion above from
    // passing for the wrong reason: an agent that really does carry a browser
    // tool, for a user with no install, does get the card. Installing a real
    // browser per user is out of reach here, so the agent's tool list is the
    // one thing answered from the test — the install lookup underneath it is
    // the live one, and genuinely empty.
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

    await expect(page.getByText(SETUP_CARD)).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Install Browser" }),
    ).toBeVisible();
    await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toHaveCount(0);
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
