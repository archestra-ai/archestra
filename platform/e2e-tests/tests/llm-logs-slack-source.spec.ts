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
 * This spec pins the *UI* contract: the run is listed under LLM Proxy on the
 * Logs page, and it survives the "Slack" entry of the Client filter while
 * another client hides it. The corresponding API/persistence contract is pinned by
 * backend/src/routes/proxy/llm-proxy-handler.test.ts.
 */
import crypto from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { mergeTests } from "@playwright/test";
import { API_BASE_URL } from "../consts";
import { expect, test as uiTest } from "../fixtures";
import { test as apiTest } from "./api-fixtures";

const test = mergeTests(uiTest, apiTest);

/** Marker the WireMock stub matches on; also the prompt text. */
const STUB_MARKER = "chatops-slack-no-usage";
/** Interaction source ChatOps sets for Slack (CHATOPS_PROVIDER_SOURCES). */
const SLACK_SOURCE = "chatops:slack";
/** The Client filter's name for that source (INTERACTION_SOURCE_DISPLAY). */
const SLACK_CLIENT = "Slack";

/** The Logs page narrowed to LLM Proxy requests matching `q`. */
const llmLogsPath = (params: { q: string; client?: string }) =>
  `/logs?type=llm&q=${encodeURIComponent(params.q)}` +
  (params.client ? `&client=${encodeURIComponent(params.client)}` : "");

/**
 * Drive one Slack-sourced streaming completion through the proxy.
 *
 * Returns the session id, which is unique to this run: the Logs search
 * matches it, so it narrows the page to this run's request.
 */
async function runSlackChatOpsCompletion(params: {
  request: APIRequestContext;
  proxyId: string;
  /** A passthrough virtual key: the proxy rejects a provider key alone. */
  passthroughKey: string;
}) {
  const { request, proxyId, passthroughKey } = params;
  const nonce = crypto.randomUUID().slice(0, 8);
  // Prefixed, so it stays a ChatOps-shaped id rather than a bare UUID.
  const sessionId = `slack-e2e-${nonce}`;
  // Contains STUB_MARKER so WireMock still matches, plus a nonce so the row is
  // uniquely identifiable among other runs' rows.
  const prompt = `${STUB_MARKER} ${nonce}`;

  const response = await request.post(
    `${API_BASE_URL}/v1/openai/${proxyId}/chat/completions`,
    {
      headers: {
        Authorization: `Bearer ${STUB_MARKER}`,
        "X-Archestra-Virtual-Key": passthroughKey,
        "Content-Type": "application/json",
        // What chatops-manager -> a2a-manager -> llm-client put on the wire.
        "X-Archestra-Source": SLACK_SOURCE,
        // ChatOps derives this from the Slack thread so a whole thread is one
        // session in the logs (buildChatOpsSessionId).
        "X-Archestra-Session-Id": sessionId,
      },
      data: {
        model: "gpt-6",
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
            `?limit=1&sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!sessions.ok()) return -1;
        const body = await sessions.json();
        return body.data.some(
          (session: { sessionId: string | null }) =>
            session.sessionId === sessionId,
        );
      },
      {
        timeout: 30_000,
        message:
          "A Slack ChatOps stream that reported no usage was never recorded as an interaction",
      },
    )
    .toBe(true);

  return { sessionId };
}

test.describe("LLM Logs - Slack (ChatOps) source", {
  tag: ["@firefox", "@webkit"],
}, () => {
  test("lists a Slack ChatOps run and keeps it under the Slack client filter", async ({
    request,
    adminPage,
    goToAdminPage,
    getLlmProxy,
    makeApiRequest,
  }) => {
    // The organization's singleton LLM Proxy (created on first use); its id
    // in the proxy URL collapses to the singleton.
    const proxyResponse = await getLlmProxy(request);
    const proxy = await proxyResponse.json();
    const proxyId = proxy.id;

    const passthroughKey = (await (
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/llm-virtual-keys",
        data: {
          name: `slack-source-${crypto.randomUUID().slice(0, 8)}`,
          keyType: "passthrough",
        },
      })
    ).json()) as { id: string; value: string };

    try {
      await runSlackLogsChecks({
        request,
        adminPage,
        goToAdminPage,
        proxyId,
        passthroughKey: passthroughKey.value,
      });
    } finally {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/llm-virtual-keys/${passthroughKey.id}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
  });
});

async function runSlackLogsChecks({
  request,
  adminPage,
  goToAdminPage,
  proxyId,
  passthroughKey,
}: {
  request: APIRequestContext;
  adminPage: Page;
  goToAdminPage: (path: string) => Promise<unknown>;
  proxyId: string;
  passthroughKey: string;
}) {
  const { sessionId } = await runSlackChatOpsCompletion({
    request,
    proxyId,
    passthroughKey,
  });
  // The search narrows the page to this run, so its request is the one row
  // that links to the session.
  const rowFor = () => adminPage.getByRole("link").filter({ hasText: /gpt-6/ });

  // 1. No client filter: the run is listed (the bug left it out entirely).
  await goToAdminPage(llmLogsPath({ q: sessionId }));
  await expect(
    rowFor(),
    "The Slack ChatOps run is missing from the LLM Proxy logs",
  ).toHaveCount(1, { timeout: 20_000 });

  // 2. The Client filter is URL-driven, so this takes the same path as
  //    picking "Slack" in it.
  await goToAdminPage(llmLogsPath({ q: sessionId, client: SLACK_CLIENT }));
  await expect(
    rowFor(),
    `The Slack ChatOps run disappeared under the "${SLACK_CLIENT}" client filter`,
  ).toHaveCount(1, { timeout: 20_000 });

  // 3. ...and the filter genuinely filters: under another client the same
  //    run is gone, otherwise step 2 proves nothing.
  await goToAdminPage(llmLogsPath({ q: sessionId, client: "Chat" }));
  await expect(adminPage.getByText("No events match")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    rowFor(),
    "The Slack ChatOps run is still listed under another client filter",
  ).toHaveCount(0);
}
