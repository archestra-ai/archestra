/**
 * E2E regression coverage for T-953: "Slack logs are not visible in the LLM Logs".
 *
 * A Slack ChatOps run reaches the LLM proxy as a *streaming* request tagged
 * `X-Archestra-Source: chatops:slack`. Its upstream is frequently another
 * Archestra instance, whose own SSE output omits the trailing usage chunk, so
 * the stream completes cleanly and never reports token usage.
 *
 * The proxy used to gate its whole finally-block persist on `if (usage)`, so
 * such a run left no interaction row at all and the LLM Proxy log page was
 * empty even for an admin with no filters set. The WireMock stub used here
 * (openai-chatops-slack-no-usage.json) reproduces exactly that upstream: a
 * complete stream that never sends usage.
 *
 * This spec pins the *UI* contract: the run is listed on /llm/logs, it is
 * labelled with the Slack source, and it survives the "Slack" entry of the
 * Source filter. The corresponding API/persistence contract is pinned by
 * backend/src/routes/proxy/llm-proxy-handler.test.ts.
 */
import type { APIRequestContext } from "@playwright/test";
import { mergeTests } from "@playwright/test";
import { API_BASE_URL } from "../consts";
import { expect, test as uiTest } from "../fixtures";
import { test as apiTest } from "./api-fixtures";

const test = mergeTests(uiTest, apiTest);

/** Marker the WireMock stub matches on; also the prompt text. */
const STUB_MARKER = "chatops-slack-no-usage";
/** Interaction source ChatOps sets for Slack (CHATOPS_PROVIDER_SOURCES). */
const SLACK_SOURCE = "chatops:slack";
/** Label INTERACTION_SOURCE_DISPLAY renders for that source. */
const SLACK_SOURCE_LABEL = "Slack";

const LOGS_PATH = "/llm/logs";

/**
 * Drive one Slack-sourced streaming completion through the proxy.
 *
 * Returns both the session id (used for the API-level readiness poll) and the
 * unique prompt text, which is what the log table's Session column actually
 * renders and is therefore how the row is located in the UI. The session-ID
 * search box is deliberately not used: it only accepts a UUID, while a ChatOps
 * session id is a thread-derived string like `slack-<channel>-<ts>`.
 */
async function runSlackChatOpsCompletion(
  request: APIRequestContext,
  proxyId: string,
) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `slack-e2e-${nonce}`;
  // Contains STUB_MARKER so WireMock still matches, plus a nonce so the row is
  // uniquely identifiable among other runs' rows.
  const prompt = `${STUB_MARKER} ${nonce}`;

  const response = await request.post(
    `${API_BASE_URL}/v1/openai/${proxyId}/chat/completions`,
    {
      headers: {
        Authorization: `Bearer ${STUB_MARKER}`,
        "Content-Type": "application/json",
        // What chatops-manager -> a2a-manager -> llm-client put on the wire.
        "X-Archestra-Source": SLACK_SOURCE,
        // ChatOps derives this from the Slack thread so a whole thread is one
        // session in the logs (buildChatOpsSessionId).
        "X-Archestra-Session-Id": sessionId,
      },
      data: {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: prompt }],
      },
    },
  );

  const body = await response.text();
  expect(
    response.status(),
    `Expected 200 but got ${response.status()}. A 404 means WireMock matched no ` +
      `stub for "${STUB_MARKER}". Body: ${body}`,
  ).toBe(200);

  // The stub IS the failure mode under test: a complete stream, no usage.
  expect(
    body,
    "The stub must not report usage — a usage-less stream is the condition being regression-tested",
  ).not.toContain("usage");
  expect(body).toContain("[DONE]");

  // The row is written once the stream drains, so poll rather than sleep.
  await expect
    .poll(
      async () => {
        const sessions = await request.get(
          `${API_BASE_URL}/api/interactions/sessions` +
            `?limit=10&offset=0&sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!sessions.ok()) return -1;
        return (await sessions.json()).pagination.total;
      },
      {
        timeout: 30_000,
        message:
          "A Slack ChatOps stream that reported no usage was never recorded as an interaction",
      },
    )
    .toBe(1);

  return { sessionId, prompt };
}

test.describe("LLM Logs - Slack (ChatOps) source", {
  tag: ["@firefox", "@webkit"],
}, () => {
  test("lists a Slack ChatOps run and keeps it under the Slack source filter", async ({
    request,
    adminPage,
    goToAdminPage,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResponse = await createLlmProxy(
      request,
      `Slack ChatOps Logs ${Date.now()}`,
      "personal",
    );
    const proxy = await proxyResponse.json();
    const proxyId = proxy.id;

    try {
      const { prompt } = await runSlackChatOpsCompletion(request, proxyId);
      // The Session column renders the run's prompt, so the nonce in it is what
      // identifies this run's row.
      const rowFor = () =>
        adminPage.locator("tbody tr").filter({ hasText: prompt });

      // 1. Unfiltered log page — the view the bug report screenshotted.
      await goToAdminPage(LOGS_PATH);
      await adminPage.waitForLoadState("domcontentloaded");

      const row = rowFor();
      await expect(
        row,
        "The Slack ChatOps run is missing from the unfiltered LLM Proxy logs",
      ).toBeVisible({ timeout: 20_000 });

      // 2. The Source column identifies it as Slack.
      await expect(
        row.getByText(SLACK_SOURCE_LABEL, { exact: true }),
        "The Slack ChatOps run is not labelled with the Slack source",
      ).toBeVisible();

      // 3. The Source filter is URL-driven (page.client.tsx reads ?source=),
      //    so this exercises the same path the "Slack" dropdown entry takes.
      await goToAdminPage(
        `${LOGS_PATH}?source=${encodeURIComponent(SLACK_SOURCE)}`,
      );
      await adminPage.waitForLoadState("domcontentloaded");
      await expect(
        rowFor(),
        `The Slack ChatOps run disappeared under the "${SLACK_SOURCE_LABEL}" source filter`,
      ).toBeVisible({ timeout: 20_000 });

      // 4. ...and the filter genuinely filters: under a different source the
      //    same run must be gone, otherwise step 3 proves nothing.
      await goToAdminPage(`${LOGS_PATH}?source=chat`);
      await adminPage.waitForLoadState("domcontentloaded");
      await expect(
        rowFor(),
        "The Slack ChatOps run is still listed under a non-Slack source filter",
      ).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await deleteAgent(request, proxyId);
    }
  });
});
