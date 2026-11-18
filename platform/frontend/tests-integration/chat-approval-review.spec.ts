import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";
import { makeConversation } from "./helpers/chat-conversation";

const key = makeLlmProviderApiKey({ provider: "openai" });
const agent = makeAgent({ llmApiKeyId: key.id });
const conversation = makeConversation({
  id: "20000000-0000-4000-8000-000000002416",
  title: "Review a tool call",
  agentId: agent.id,
  messageCount: 1,
});
const coverage = [
  "After this, the agent can't use `knowledge__retrieve_document`, `browser__console_messages`, `browser__fill_form`, `browser__hover`, `browser__install` and 191 more in this conversation.",
  "After this, `workspace__add_team_external_group`, `workspace__assign_knowledge_base_to_agent`, `workspace__assign_knowledge_connector_to_agent` and 73 more will need approval in this conversation.",
  "Other tools may also need approval, decided call by call.",
];

// The real chat consumes a synthetic pending-review stream. Browser layout
// catches the original regression: long consequences squeezed beside actions.
for (const viewport of [
  { width: 1280, height: 1000 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width}px approval review`, () => {
    test.use({
      viewport,
      colorScheme: viewport.width === 390 ? "dark" : "light",
    });

    test("keeps labeled arguments and full consequences above the decision buttons", async ({
      page,
      mswControl,
    }, testInfo) => {
      await mswControl.registerMany([
        { method: "get", url: "/api/agents/chat-roster", body: [agent] },
        { method: "get", url: `/api/agents/${agent.id}`, body: agent },
        { method: "get", url: "/api/agents/credential-readiness", body: [] },
        { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
        {
          method: "get",
          url: "/api/llm-provider-api-keys/available",
          body: [key],
        },
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
      ]);
      await page.addInitScript(
        ({ id, coverage }) => {
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
            if (!url.endsWith(`/api/chat/conversations/${id}/active-run`)) {
              return originalFetch(input, init);
            }
            const chunks = [
              { type: "start", messageId: "assistant-review" },
              {
                type: "data-mcp-elicitation",
                data: {
                  id: "review-2416",
                  conversationId: id,
                  toolName: "archestra__execute_remedy_plan",
                  mode: "form",
                  kind: "openappa_review",
                  message: "Review the file deletion.",
                  reviewedTool: "github__delete_file",
                  reviewedArguments: JSON.stringify({
                    path: "README.md",
                    repo: "example-project",
                    owner: "example-team",
                    branch: "main",
                    message: "Delete README.md\n\nRemove the outdated guide.",
                  }),
                  reviewedCoverage: coverage,
                  requestedSchema: {
                    type: "object",
                    properties: {
                      action: { type: "string", enum: ["approve", "deny"] },
                    },
                    required: ["action"],
                  },
                },
              },
            ];
            const encoder = new TextEncoder();
            return new Response(
              new ReadableStream({
                start(controller) {
                  for (const chunk of chunks) {
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                    );
                  }
                  init?.signal?.addEventListener(
                    "abort",
                    () =>
                      controller.error(
                        new DOMException("Aborted", "AbortError"),
                      ),
                    { once: true },
                  );
                },
              }),
              {
                headers: {
                  "content-type": "text/event-stream",
                  "x-vercel-ai-ui-message-stream": "v1",
                },
              },
            );
          };
        },
        { id: conversation.id, coverage },
      );
      await page.goto(`/chat/${conversation.id}`);

      const card = page.getByTestId("mcp-elicitation-card");
      const consequences = card.getByRole("list", {
        name: "Approval consequences",
      });
      await expect(consequences.getByRole("listitem")).toHaveText(coverage);
      await expect(card.getByRole("term")).toHaveText([
        "path",
        "repo",
        "owner",
        "branch",
        "message",
      ]);
      const approve = card.getByRole("button", {
        name: "Approve",
        exact: true,
      });
      const deny = card.getByRole("button", { name: "Deny", exact: true });
      await expect(approve).toBeEnabled();
      await expect(deny).toBeEnabled();

      // All consequences use the card's width; neither button can sit beside
      // or overlap them, even on a phone.
      // Read all positions in one frame: the chat scrolls to follow the
      // incoming review, so separate boundingBox calls can observe different
      // scroll offsets even though the elements never overlap.
      const layout = await page.evaluate(
        ({ list, approve, deny, card }) => {
          if (!list || !approve || !deny || !card) {
            throw new Error("Approval review is missing content or actions");
          }
          const listBox = list.getBoundingClientRect();
          const approveBox = approve.getBoundingClientRect();
          const denyBox = deny.getBoundingClientRect();
          return {
            actionsBelow: approveBox.top > listBox.bottom,
            actionsAligned: approveBox.top === denyBox.top,
            rightEdge: denyBox.right,
            noOverflow: card.scrollWidth <= card.clientWidth,
          };
        },
        {
          list: await consequences.elementHandle(),
          approve: await approve.elementHandle(),
          deny: await deny.elementHandle(),
          card: await card.elementHandle(),
        },
      );
      expect(layout.actionsBelow).toBe(true);
      expect(layout.actionsAligned).toBe(true);
      expect(layout.rightEdge).toBeLessThanOrEqual(viewport.width);
      expect(layout.noOverflow).toBe(true);

      if (viewport.width === 1280) {
        await card.screenshot({ path: testInfo.outputPath("review.png") });
      }
      await card.getByRole("button", { name: /github__delete_file/ }).click();
      await expect(card.getByRole("term")).toHaveCount(0);
      await expect(consequences).toBeVisible();
      await expect(approve).toBeEnabled();
      await expect(deny).toBeEnabled();
      await card.screenshot({
        path: testInfo.outputPath("review-collapsed.png"),
      });
    });
  });
}
