import { E2eTestId } from "@archestra/shared";
import {
  ensureWireMockAnthropicChatProvider,
  expectChatReady,
  goToChat,
} from "../utils";
import { expect, test } from "./api-fixtures";

test.describe.configure({ retries: 2 });

/**
 * The browser-tooling check's two dependent waves. Neither can even begin
 * until the roster has resolved which agent the chat starts on, so holding the
 * first paint for them put two more sequential round trips in front of a
 * screen that draws none of what they decide — the composer's own loading
 * posture already covers the gap.
 *
 * Stalling them is what makes this deterministic: it asserts the screen no
 * longer *needs* them at paint time, rather than racing a stopwatch. The
 * roster and key requests are deliberately left alone — whether those are
 * served from the network or from the restored refresh snapshot varies with
 * how much an organization has in them, and this test is about the waves that
 * are gone either way.
 */
const DEPENDENT_ROUTES = [
  "**/api/agents/*/tools*",
  "**/api/agents/*/delegations*",
];

test.describe("New chat refresh", () => {
  test("paints the composer without waiting on the browser-tooling check", async ({
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

    // Held open for the rest of the test. A handler that never settles the
    // route is the point: if either is back in the first-paint gate, the
    // reload below never gets past its loading state.
    for (const pattern of DEPENDENT_ROUTES) {
      await page.route(pattern, () => {});
    }

    await page.reload({ waitUntil: "commit" });

    // The composer on screen is the assertion: the gate this test is about
    // renders a full-area loading state *instead of* the page, so a visible
    // composer is proof it cleared without the stalled requests. The composer
    // is not editable here and should not be — with the check held open
    // forever, its own loading posture (submit disabled until it knows whether
    // a browser is needed) never lifts. That posture is the point: it is what
    // makes holding the whole screen unnecessary.
    await expectChatReady(page);
    await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeVisible();
  });
});
