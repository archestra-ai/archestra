import { makeAgent } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";
import { makeConversation } from "./helpers/chat-conversation";

// The chat renders before permissions are known (see WithPagePermissions), so
// the queries that need provider, model or agent grants must still wait for
// them: a role without those grants must not see refusals.
const GATED = [
  "/api/llm-provider-api-keys",
  "/api/llm-provider-api-keys/available",
  "/api/llm-models",
  "/api/llm-models/available",
  "/api/agents/chat-roster",
];

test("a role without provider, model and agent read gets no refusals on its conversation", async ({
  page,
  mswControl,
}) => {
  const agent = makeAgent();
  const conversation = makeConversation({
    id: "30000000-0000-4000-8000-0000000000d4",
    title: "Member chat",
    agentId: agent.id,
    messageCount: 2,
  });
  const chatOnly = { chat: ["read", "create", "update", "delete"] };
  await mswControl.registerMany([
    { method: "get", url: "/api/user/permissions", body: chatOnly },
    { method: "get", url: "/api/scoped-capabilities", body: [] },
    {
      method: "get",
      url: "/api/chat/conversations",
      body: [{ ...conversation, messages: [] }],
    },
    {
      method: "get",
      url: `/api/chat/conversations/${conversation.id}`,
      body: conversation,
    },
    {
      method: "get",
      url: `/api/chat/conversations/${conversation.id}/files`,
      body: [],
    },
    {
      method: "get",
      url: `/api/chat/conversations/${conversation.id}/share`,
      body: null,
    },
    { method: "get", url: `/api/agents/${agent.id}`, body: agent },
    { method: "get", url: "/api/agents/credential-readiness", body: [] },
    {
      method: "get",
      url: "/api/members/default-model",
      body: { modelId: null, chatApiKeyId: null },
    },
    // Should anything ask anyway, it is refused, as the backend would.
    ...GATED.map((url) => ({
      method: "get" as const,
      url,
      status: 403,
      body: {
        error: { message: "Forbidden", type: "api_authorization_error" },
      },
    })),
  ]);
  const requested: string[] = [];
  page.on("request", (request) => {
    requested.push(new URL(request.url()).pathname);
  });
  const failedResponses: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedResponses.push(
        `${response.status()} ${new URL(response.url()).pathname}`,
      );
  });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Failed requests are checked by URL below. The script-tag warning is the
    // MSW harness's: MswInit mounts the app client-side (no hydration), so
    // the theme provider's inline script is created by React in dev mode.
    if (text.startsWith("Failed to load resource")) return;
    if (text.startsWith("Encountered a script tag")) return;
    consoleErrors.push(text);
  });

  await page.goto(`/chat/${conversation.id}`);
  // Without a provider-key grant this role is offered to connect a provider
  // (as before the optimistic shell); what matters is how it gets there.
  await expect(
    page.getByRole("heading", { name: "Connect an LLM provider" }),
  ).toBeVisible();
  // Let every query the page starts settle.
  await page.waitForLoadState("networkidle");

  expect(requested.filter((path) => GATED.includes(path))).toEqual([]);
  await expect(
    page.locator("[data-sonner-toast][data-type=error]"),
  ).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  // Only the mock's own "bootstrap unavailable" answer, which the shell
  // falls back from by design.
  expect(failedResponses).toEqual(["401 /api/bootstrap"]);
});
