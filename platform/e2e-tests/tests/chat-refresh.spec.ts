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
  test("draws a ready composer while browser agent lookups are held", async ({
    page,
    request,
    makeApiRequest,
    syncModels,
    createAgent,
    deleteAgent,
  }) => {
    await ensureWireMockAnthropicChatProvider({
      request,
      makeApiRequest,
      syncModels,
    });

    const agentIds: string[] = [];
    try {
      // A second personal agent becomes the server's recent starting choice;
      // the older pinned one still needs a legitimate background reference.
      for (const label of ["Pinned", "Starting"]) {
        const response = await createAgent(
          request,
          `Refresh ${label} ${crypto.randomUUID()}`,
          "agent",
        );
        agentIds.push((await response.json()).id);
      }
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${agentIds[0]}/pin`,
      });
      await goToChat(page);
      await expectChatReady(page);

      // Exercise the server-selected starting agent with no refresh snapshot or
      // remembered browser selection. A saved agent outside the server roster
      // correctly needs a reference lookup, which is a different startup path.
      await page.evaluate(() => {
        sessionStorage.clear();
        localStorage.removeItem("selected-chat-agent");
      });

      // Held open for the rest of the test. A handler that never settles the
      // route is the point: if any of these is back in front of the first paint,
      // the reload below never gets past its loading state.
      const heldRequests: string[] = [];
      for (const pattern of FIRST_PAINT_ROUTES) {
        await page.route(pattern, (route) => {
          heldRequests.push(route.request().url());
        });
      }

      await page.reload({ waitUntil: "commit" });

      // The older pinned agent is outside the bounded starting roster. Wait
      // for its background lookup to be held before checking the composer.
      await expect
        .poll(() =>
          heldRequests.some((url) =>
            new URL(url).searchParams
              .get("ids")
              ?.split(",")
              .includes(agentIds[0]),
          ),
        )
        .toBe(true);

      // Not merely on screen — it takes a draft, which is the first thing anyone
      // does on this page.
      await expectChatReady(page);
      const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
      await expect(textarea).toBeEditable();
      await textarea.fill("drafted before the roster arrived");
      await expect(textarea).toHaveValue("drafted before the roster arrived");

      // Sending needs an agent, and the document now carries one: the server
      // resolves the roster and the starting agent before it answers, so the
      // composer stays ready even while the separate pinned-agent lookup is
      // held. Send is on as soon as the composer is drawn.
      await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();

      // An empty roster means "no agents" only once it has loaded. An
      // organization that has agents must never be told it has none while its
      // roster is still in flight.
      await expect(page.getByText("No agents yet")).toHaveCount(0);
      // Background pin lookups may run, but the server-seeded composer must
      // not fetch the full roster again in the browser.
      const fullRosterRequests = heldRequests.filter((url) => {
        const requestUrl = new URL(url);
        return (
          requestUrl.pathname.startsWith("/api/agents/chat-roster") &&
          !requestUrl.searchParams.has("ids")
        );
      });
      expect(fullRosterRequests).toEqual([]);
    } finally {
      for (const id of agentIds.reverse()) await deleteAgent(request, id);
    }
  });
});
