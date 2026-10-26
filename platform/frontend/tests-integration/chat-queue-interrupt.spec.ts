import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

// The real app and AI SDK run here. Only HTTP/model streams are synthetic.
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width}px queue`, () => {
    test.use({ viewport });
    test("interrupts a reconnected response from the keyboard and drains FIFO once", async ({
      page,
      mswControl,
    }, testInfo) => {
      const conversationId = "10000000-0000-4000-8000-000000000017";
      const now = "2026-10-26T12:00:00.000Z";
      const conversation = {
        id: conversationId,
        userId: "test-user-admin",
        organizationId: "test-org",
        agentId: "test-agent",
        title: "Synthetic queue interruption demo",
        titleIsPlaceholder: false,
        origin: "web",
        projectId: null,
        modelId: null,
        selectedModel: "gpt-4o",
        selectedProvider: "openai",
        chatApiKeyId: null,
        thinkingEffort: "low",
        hasCustomToolSelection: false,
        hooksDebugEnabled: false,
        encryptedChat: false,
        todoList: null,
        artifact: null,
        pinnedAt: null,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
        deletedAt: null,
        agent: {
          id: "test-agent",
          name: "Schedule agent",
          agentType: "agent",
          systemPrompt: null,
          toolExposureMode: "full",
          llmApiKeyId: null,
        },
        share: null,
        chatErrors: [],
        compactions: [],
        messages: [
          {
            id: "prompt-1",
            role: "user",
            parts: [{ type: "text", text: "Check the weekly report" }],
          },
        ],
      };

      await mswControl.registerMany([
        { method: "get", url: "/api/agents/chat-roster", body: [makeAgent()] },
        { method: "get", url: "/api/agents/credential-readiness", body: [] },
        {
          method: "get",
          url: "/api/llm-provider-api-keys",
          body: [makeLlmProviderApiKey({ provider: "openai" })],
        },
        {
          method: "get",
          url: "/api/llm-provider-api-keys/available",
          body: [makeLlmProviderApiKey({ provider: "openai" })],
        },
        {
          method: "get",
          url: `/api/chat/conversations/${conversationId}`,
          body: conversation,
        },
        {
          method: "get",
          url: `/api/chat/conversations/${conversationId}/files`,
          body: [],
        },
        {
          method: "get",
          url: `/api/chat/conversations/${conversationId}/share`,
          body: null,
        },
      ]);
      await page.addInitScript(
        ({ id }) => {
          if (!localStorage.getItem(`fixture-seeded-${id}`)) {
            localStorage.setItem(`fixture-seeded-${id}`, "true");
            localStorage.setItem(
              `archestra_chat_queue_${id}`,
              JSON.stringify([
                {
                  id: "queued-1",
                  text: "Focus on the risks first",
                  queuedAt: new Date().toISOString(),
                },
                {
                  id: "queued-2",
                  text: "Then give a short summary",
                  queuedAt: new Date().toISOString(),
                },
              ]),
            );
          }
          const sent: string[][] = [];
          Object.defineProperty(window, "__queueInterruptSent", {
            value: sent,
          });
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
            if (url.endsWith(`/api/chat/conversations/${id}/stop`)) {
              await new Promise((resolve) => setTimeout(resolve, 300));
              return Response.json({ stopped: true });
            }
            if (
              url.endsWith(`/api/chat/conversations/${id}/active-run`) ||
              (url.endsWith("/api/chat") && init?.method === "POST")
            ) {
              const isSend = url.endsWith("/api/chat");
              if (isSend) {
                const body = JSON.parse(String(init?.body));
                sent.push(
                  body.messages
                    .filter(
                      (message: { role: string }) => message.role === "user",
                    )
                    .map(
                      (message: { parts: { type: string; text?: string }[] }) =>
                        message.parts
                          .filter((part) => part.type === "text")
                          .map((part) => part.text)
                          .join(""),
                    ),
                );
              }
              const chunks = isSend
                ? [
                    { type: "start", messageId: crypto.randomUUID() },
                    { type: "text-start", id: "reply" },
                    {
                      type: "text-delta",
                      id: "reply",
                      delta: "Synthetic response: correction received.",
                    },
                    { type: "text-end", id: "reply" },
                    { type: "finish", finishReason: "stop" },
                  ]
                : [
                    { type: "start", messageId: "assistant-in-progress" },
                    { type: "text-start", id: "progress" },
                    {
                      type: "text-delta",
                      id: "progress",
                      delta: "Synthetic stream: preparing a detailed report…",
                    },
                  ];
              const encoder = new TextEncoder();
              return new Response(
                new ReadableStream({
                  start(controller) {
                    for (const chunk of chunks)
                      controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                      );
                    if (isSend) controller.close();
                    else
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
            }
            return originalFetch(input, init);
          };
        },
        { id: conversationId },
      );
      await page.goto(`/chat/${conversationId}`);
      const action = page.getByRole("button", {
        name: "Interrupt & send",
        exact: true,
      });
      await expect(action).toBeEnabled();
      await expect(
        page.getByTestId(E2eTestId.ChatMessageQueueItem),
      ).toHaveCount(2);
      await page.reload();
      await expect(action).toBeEnabled();
      await expect(
        page.getByTestId(E2eTestId.ChatMessageQueueItem),
      ).toHaveCount(2);
      await action.focus();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toHaveText("Stop and send queued messages.");
      const tooltipPanel = page.locator('[data-slot="tooltip-content"]');
      await expect(tooltipPanel).toHaveCSS("opacity", "1");
      const tooltipBox = await tooltipPanel.boundingBox();
      if (!tooltipBox) throw new Error("Queue action tooltip is not visible");
      expect(tooltipBox.width).toBeLessThanOrEqual(240);
      const textAndPaddingWidth = await tooltipPanel.evaluate((element) => {
        const range = document.createRange();
        const text = Array.from(element.childNodes).find(
          (node) => node.nodeType === Node.TEXT_NODE,
        );
        if (!text) throw new Error("Missing visible tooltip text");
        range.selectNodeContents(text);
        const style = getComputedStyle(element);
        return (
          range.getBoundingClientRect().width +
          parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.borderRightWidth)
        );
      });
      expect(tooltipBox.width).toBeLessThanOrEqual(textAndPaddingWidth + 1);
      expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
      expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(
        viewport.width,
      );
      await expect(page.getByText(/sends in order/i)).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("queue-interrupt-before.png"),
        fullPage: true,
      });
      // Native Tab/Enter activation is sufficient; no new global shortcut to conflict.
      await action.focus();
      await expect(action).toBeFocused();
      await action.press("Enter");
      await expect(
        page.getByRole("button", { name: "Interrupting…" }),
      ).toBeDisabled();
      await expect(
        page.getByText("Focus on the risks first", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Then give a short summary", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByTestId(E2eTestId.ChatMessageQueueItem),
      ).toHaveCount(0);
      expect(
        await page.evaluate(
          () =>
            (window as typeof window & { __queueInterruptSent: string[][] })
              .__queueInterruptSent,
        ),
      ).toEqual([
        [
          "Check the weekly report",
          "Focus on the risks first",
          "Then give a short summary",
        ],
      ]);
      await page.screenshot({
        path: testInfo.outputPath("queue-interrupt-after.png"),
        fullPage: true,
      });
    });
  });
}
