import { E2eTestId } from "@archestra/shared";
import {
  ensureWireMockAnthropicChatProvider,
  expectChatReady,
  goToChat,
} from "../utils";
import { expect, test } from "./api-fixtures";

test.describe.configure({ retries: 2 });

/**
 * Everything the new-chat screen's first paint used to be held behind, and
 * that the server now reads for the document (see prefetchShellSeed):
 *
 * - the agent roster, the largest thing this page fetches and the one the
 *   refresh snapshot cannot always keep, and
 * - the agent's tools and delegations, which the browser-tooling check reads —
 *   a second and third wave that cannot even begin until the roster has
 *   resolved an agent.
 *
 * Holding all of them open is what makes this deterministic: it asserts the
 * screen no longer *needs* any of them to draw a usable composer, rather than
 * racing a stopwatch against them.
 */
const FIRST_PAINT_ROUTES = [
  "**/api/agents/chat-roster*",
  "**/api/agents/*/tools*",
  "**/api/agents/*/delegations*",
];

test.describe("New chat refresh", () => {
  test("draws a ready composer without asking the browser for the roster", async ({
    page,
    request,
    makeApiRequest,
    syncModels,
  }) => {
    await ensureWireMockAnthropicChatProvider({
      request,
      makeApiRequest,
      syncModels,
    });

    await goToChat(page);
    await expectChatReady(page);

    // Exercise a genuinely missing roster, not one restored from the refresh
    // snapshot. A cached roster can already resolve the selected agent.
    await page.evaluate(() => sessionStorage.clear());

    // Held open for the rest of the test. A handler that never settles the
    // route is the point: if any of these is back in front of the first paint,
    // the reload below never gets past its loading state.
    for (const pattern of FIRST_PAINT_ROUTES) {
      await page.route(pattern, () => {});
    }

    await page.reload({ waitUntil: "commit" });

    // Not merely on screen — it takes a draft, which is the first thing anyone
    // does on this page.
    await expectChatReady(page);
    const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
    await expect(textarea).toBeEditable();
    await textarea.fill("drafted before the roster arrived");
    await expect(textarea).toHaveValue("drafted before the roster arrived");

    // Sending needs an agent, and the document now carries one: the server
    // resolves the roster and the starting agent before it answers, so the
    // reload never asks the browser for the routes held open above. Send is
    // on as soon as the composer is drawn.
    await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();

    // An empty roster means "no agents" only once it has loaded. An
    // organization that has agents must never be told it has none while its
    // roster is still in flight.
    await expect(page.getByText("No agents yet")).toHaveCount(0);
  });
});
