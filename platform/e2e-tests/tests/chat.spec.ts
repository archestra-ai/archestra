import { E2eTestId, requiresPerplexityAgentApi } from "@archestra/shared";
import type { Page } from "@playwright/test";
import { WIREMOCK_BASE_URL } from "../consts";
import {
  ensureWireMockAnthropicChatProvider,
  expectChatReady,
  getRuntimeModelForProviderFromApi,
  goToChat,
  selectApiKeyById,
  selectApiKeyForProvider,
  selectRuntimeModelFromDialog,
} from "../utils";
import { expect, test } from "./api-fixtures";

// Provider tests are mutually independent — each drives its own model in a fresh
// conversation, and the WireMock chat stubs are stateless (matched only on the
// "chat-ui-e2e-test" body marker), so they run in parallel to fill the CI workers
// instead of serializing all ~16 providers onto one. This matters twice over: serial
// mode both left 13 of the 14 CI workers idle behind one long provider chain (the
// dominant reason this file was the slow long-pole of e2e shard 1) and, because a
// serial group retries as a unit, let a single flaky provider skip and re-run every
// other provider. Parallel mode scopes each retry to the one provider that flaked.
// retries stay at 2 to absorb transient streaming/WireMock hiccups in CI.
test.describe.configure({ mode: "parallel", retries: 2 });

interface ChatProviderTestConfig {
  providerName: string;
  /** Display name shown in model selector provider grouping */
  providerDisplayName: string;
  /** Unique identifier used in wiremock mapping to match this test's requests (must appear in message body) */
  wiremockStubId: string;
  /** Expected response text from the mocked LLM */
  expectedResponse: string;
  /**
   * Narrows which catalogued model the test drives. Only needed for providers
   * that serve several upstream APIs, where the default (first model by id)
   * could pick a model whose transport this test's WireMock stub doesn't mock.
   */
  matchModel?: (model: { id: string }) => boolean;
}

// =============================================================================
// Provider Test Configurations
// =============================================================================

// Anthropic - Uses SSE streaming format
const anthropicConfig: ChatProviderTestConfig = {
  providerName: "anthropic",
  providerDisplayName: "Anthropic",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// OpenAI - Uses OpenAI streaming format
const openaiConfig: ChatProviderTestConfig = {
  providerName: "openai",
  providerDisplayName: "OpenAI",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Gemini - Uses Google AI streaming format
const geminiConfig: ChatProviderTestConfig = {
  providerName: "gemini",
  providerDisplayName: "Google",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Cerebras - Uses OpenAI-compatible streaming format
// Note: Cerebras filters out models with "llama" in the name for chat, so we use cerebras-gpt
const cerebrasConfig: ChatProviderTestConfig = {
  providerName: "cerebras",
  providerDisplayName: "Cerebras",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Cohere - Uses Cohere v2 streaming format
const cohereConfig: ChatProviderTestConfig = {
  providerName: "cohere",
  providerDisplayName: "Cohere",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Mistral - Uses OpenAI-compatible streaming format
const mistralConfig: ChatProviderTestConfig = {
  providerName: "mistral",
  providerDisplayName: "Mistral",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Perplexity - Uses OpenAI-compatible streaming format.
// Pinned to the chat-completions half of the catalogue: the vendor-prefixed
// models go to Perplexity's Agent API instead, which this stub doesn't mock.
const perplexityConfig: ChatProviderTestConfig = {
  providerName: "perplexity",
  providerDisplayName: "Perplexity",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
  matchModel: ({ id }) => !requiresPerplexityAgentApi(id),
};

// Ollama - Uses OpenAI-compatible streaming format
const ollamaConfig: ChatProviderTestConfig = {
  providerName: "ollama",
  providerDisplayName: "Ollama",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// vLLM - Uses OpenAI-compatible streaming format
const vllmConfig: ChatProviderTestConfig = {
  providerName: "vllm",
  providerDisplayName: "vLLM",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// ZhipuAI - Uses OpenAI-compatible streaming format
const zhipuaiConfig: ChatProviderTestConfig = {
  providerName: "zhipuai",
  providerDisplayName: "ZhipuAI",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// DeepSeek - Uses OpenAI-compatible streaming format
const deepseekConfig: ChatProviderTestConfig = {
  providerName: "deepseek",
  providerDisplayName: "DeepSeek",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Groq - Uses OpenAI-compatible streaming format
const groqConfig: ChatProviderTestConfig = {
  providerName: "groq",
  providerDisplayName: "Groq",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// xAI - Uses OpenAI-compatible streaming format
const xaiConfig: ChatProviderTestConfig = {
  providerName: "xai",
  providerDisplayName: "xAI",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// OpenRouter - Uses OpenAI-compatible streaming format
const openrouterConfig: ChatProviderTestConfig = {
  providerName: "openrouter",
  providerDisplayName: "OpenRouter",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// MiniMax - Uses OpenAI-compatible streaming format
const minimaxConfig: ChatProviderTestConfig = {
  providerName: "minimax",
  providerDisplayName: "MiniMax",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

const azureConfig: ChatProviderTestConfig = {
  providerName: "azure",
  providerDisplayName: "Azure AI Foundry",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked Azure AI Foundry response.",
};

const testConfigs: ChatProviderTestConfig[] = [
  anthropicConfig,
  openaiConfig,
  geminiConfig,
  cerebrasConfig,
  cohereConfig,
  mistralConfig,
  perplexityConfig,
  groqConfig,
  xaiConfig,
  openrouterConfig,
  ollamaConfig,
  vllmConfig,
  zhipuaiConfig,
  deepseekConfig,
  minimaxConfig,
  azureConfig,
];

// =============================================================================
// Test Suite
// =============================================================================

for (const config of testConfigs) {
  test.describe(`Chat-UI-${config.providerName}`, () => {
    // Increase timeout for chat tests since they involve streaming responses
    test.setTimeout(120_000);

    test(`can send a message and receive a response from ${config.providerDisplayName}`, async ({
      page,
      request,
      makeApiRequest,
    }) => {
      const runtimeModel = await getRuntimeModelForProviderFromApi(
        makeApiRequest,
        request,
        config.providerName,
        config.matchModel,
      );
      test.skip(
        !runtimeModel,
        `${config.providerDisplayName} is not configured in this test environment`,
      );
      if (!runtimeModel) {
        return;
      }

      await goToChat(page);
      await expectChatReady(page);
      const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);

      await selectApiKeyForProvider(page, runtimeModel.provider);

      // Open model selector and choose the test model
      const modelSelectorTrigger = page
        .getByTestId(E2eTestId.ChatModelSelectorTrigger)
        .or(page.getByRole("button", { name: /select model/i }))
        .or(
          page.getByRole("button", {
            name: /claude|gpt|gemini|command|mistral|sonar|llama|grok|glm|minimax/i,
          }),
        )
        .first();
      await expect(modelSelectorTrigger).toBeVisible({ timeout: 10_000 });
      await modelSelectorTrigger.click();

      const modelDialog = page.getByRole("dialog", { name: "Select Model" });
      await expect(modelDialog).toBeVisible({ timeout: 5_000 });

      await selectRuntimeModelFromDialog(page, runtimeModel);

      // Generate a unique message that contains our wiremock stub ID for matching
      // The wiremock mapping matches on bodyPatterns: [{ "contains": "chat-ui-e2e-test" }]
      const testMessageId = makeTestMessageId(config.wiremockStubId);
      const testMessage = `Test message ${testMessageId}: Please respond with a simple greeting.`;

      // Type and send the message
      await textarea.fill(testMessage);

      // Submit the message by pressing Enter
      await page.keyboard.press("Enter");

      // Wait for the response to appear.
      // The mocked response should contain our expected text. Use a generous
      // timeout — streaming responses in CI can be slow (WireMock + streaming +
      // CI resource contention can take >60s).
      // Scope to the first settled assistant bubble while the stream is still
      // reconciling its temporary client placeholder.
      await expect(page.getByText(config.expectedResponse).first()).toBeVisible(
        {
          timeout: 90_000,
        },
      );

      // Verify the user's message also appears in the chat
      // Use .first() because the message text may also appear in the sidebar title
      await expect(page.getByText(testMessage).first()).toBeVisible();
    });
  });
}

test.describe("Chat active run reconnect", () => {
  test.setTimeout(120_000);

  test("continues a streaming assistant turn after page reload", async ({
    page,
    request,
    makeApiRequest,
    syncModels,
  }) => {
    await expectWireMockReady();

    const { apiKeyId, runtimeModel } =
      await ensureWireMockAnthropicChatProvider({
        request,
        makeApiRequest,
        syncModels,
      });

    await goToChat(page);
    await expectChatReady(page);

    await selectApiKeyById(page, apiKeyId);

    const modelSelectorTrigger = page
      .getByTestId(E2eTestId.ChatModelSelectorTrigger)
      .or(page.getByRole("button", { name: /select model/i }))
      .or(page.getByRole("button", { name: /claude|gpt|gemini/i }))
      .first();
    await expect(modelSelectorTrigger).toBeVisible({ timeout: 10_000 });
    await modelSelectorTrigger.click();

    const modelDialog = page.getByRole("dialog", { name: "Select Model" });
    await expect(modelDialog).toBeVisible({ timeout: 5_000 });
    await selectRuntimeModelFromDialog(page, runtimeModel);

    const testMessageId = makeTestMessageId("chat-reconnect-e2e-test");
    const testMessage = `Test message ${testMessageId}: stream slowly.`;
    const expectedResponse =
      "Reconnect stream part one part two part three part four part five done.";
    const firstChunk = page.getByText("Reconnect stream part one", {
      exact: false,
    });
    const middleChunk = page.getByText("part three", { exact: false });
    const lateChunk = page.getByText("part five done", { exact: false });
    const finalResponse = page.getByText(expectedResponse, { exact: true });

    await page.getByTestId(E2eTestId.ChatPromptTextarea).fill(testMessage);
    await page.keyboard.press("Enter");

    const conversationId = await waitForConversationId(page);
    await expect(firstChunk).toBeVisible({ timeout: 60_000 });
    expect(await middleChunk.isVisible()).toBe(false);
    expect(await lateChunk.isVisible()).toBe(false);
    expect(await finalResponse.isVisible()).toBe(false);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expectChatReady(page);

    await expect(middleChunk).toBeVisible({ timeout: 90_000 });
    await expect(lateChunk).toBeVisible({ timeout: 90_000 });
    await expect(finalResponse).toBeVisible({ timeout: 90_000 });

    await expect(async () => {
      const transcript = await fetchConversationTranscript(
        page,
        conversationId,
      );
      expect(transcript.userMessages).toEqual([testMessage]);
      expect(transcript.assistantMessages).toEqual([expectedResponse]);
    }).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });
  });
});

test.describe("Chat thinking block layout", () => {
  test.setTimeout(120_000);

  // A thinking block renders markdown, so it can hold a code line or a URL that
  // has no break opportunity to shrink at. Those must scroll inside the block:
  // if they size the block instead, the conversation itself scrolls sideways.
  test("keeps a streaming thinking block within the conversation width", async ({
    page,
    request,
    makeApiRequest,
    syncModels,
  }) => {
    await expectWireMockReady();

    const { apiKeyId, runtimeModel } =
      await ensureWireMockAnthropicChatProvider({
        request,
        makeApiRequest,
        syncModels,
      });

    await goToChat(page);
    await expectChatReady(page);
    await selectApiKeyById(page, apiKeyId);

    const modelSelectorTrigger = page
      .getByTestId(E2eTestId.ChatModelSelectorTrigger)
      .or(page.getByRole("button", { name: /select model/i }))
      .or(page.getByRole("button", { name: /claude|gpt|gemini/i }))
      .first();
    await expect(modelSelectorTrigger).toBeVisible({ timeout: 10_000 });
    await modelSelectorTrigger.click();

    const modelDialog = page.getByRole("dialog", { name: "Select Model" });
    await expect(modelDialog).toBeVisible({ timeout: 5_000 });
    await selectRuntimeModelFromDialog(page, runtimeModel);

    const testMessageId = makeTestMessageId("chat-thinking-overflow-e2e-test");
    await page
      .getByTestId(E2eTestId.ChatPromptTextarea)
      .fill(`Test message ${testMessageId}: think it through.`);
    await page.keyboard.press("Enter");

    // A live block is expanded while it streams, so this is the state the
    // overflow shows up in. Wait for the widest content — the long code line —
    // to be on screen before measuring.
    const thinkingCodeLine = page.getByText("reconcileEverything").first();
    await expect(thinkingCodeLine).toBeVisible({ timeout: 90_000 });
    expect(await conversationHorizontalOverflow(page)).toBeLessThanOrEqual(1);
    // Nothing here should scroll sideways: not the conversation, and not the
    // block either. The long identifier in the thinking text has to wrap
    // instead. The code line is the one thing that may still scroll, and it
    // does so on its own tinted panel — never spilling off the end of it.
    const streaming = await thinkingLayout(page);
    expect(streaming.blockOverflow).toBeLessThanOrEqual(1);
    expect(streaming.proseOverflow).toBeLessThanOrEqual(1);
    expect(streaming.codePanelOverflow).toBeLessThanOrEqual(1);

    // And again once the block has settled and the reader reopens it. Wait for
    // the block's own auto-collapse rather than racing it: clicking the trigger
    // while it is still open would close the block instead of reopening it.
    await expect(
      page.getByText("The helper reconciles every knob").first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect(thinkingCodeLine).toBeHidden({ timeout: 30_000 });
    await page
      .getByText(/Thought for/)
      .first()
      .click();
    await expect(thinkingCodeLine).toBeVisible({ timeout: 10_000 });
    expect(await conversationHorizontalOverflow(page)).toBeLessThanOrEqual(1);

    // Settled, the thinking text reads on the same line length as the answer
    // below it — both are capped at the same share of the transcript column,
    // so the block is not a wider column of its own.
    const settled = await thinkingLayout(page);
    expect(settled.blockOverflow).toBeLessThanOrEqual(1);
    expect(settled.proseOverflow).toBeLessThanOrEqual(1);
    expect(
      Math.abs(settled.proseWidth - settled.answerWidth),
    ).toBeLessThanOrEqual(2);
  });
});

/**
 * Widest horizontal overflow, in pixels, of the conversation transcript and of
 * the page itself — the two surfaces a too-wide message part pushes a scrollbar
 * onto. Content that legitimately scrolls (a code block, a wide table) does so
 * inside its own container and is not counted here.
 */
async function conversationHorizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    if (!log) {
      throw new Error("Conversation transcript (role=log) not found");
    }
    const candidates = [
      document.documentElement,
      log,
      // use-stick-to-bottom owns the scrolling element inside the transcript.
      ...log.querySelectorAll(":scope > div"),
    ];
    return Math.max(
      ...candidates.map((element) => element.scrollWidth - element.clientWidth),
    );
  });
}

/**
 * How the thinking block lays its markdown out: whether the block or its prose
 * has to scroll sideways to show it, and the line length the prose wraps at
 * next to the answer's. `answerWidth` is 0 until the answer has rendered.
 */
async function thinkingLayout(page: Page): Promise<{
  blockOverflow: number;
  proseOverflow: number;
  codePanelOverflow: number;
  proseWidth: number;
  answerWidth: number;
}> {
  return page.evaluate(() => {
    const prose = [...document.querySelectorAll("p")].find((paragraph) =>
      paragraph.textContent?.startsWith("Let me re-read the helper"),
    );
    if (!prose?.parentElement) {
      throw new Error("Thinking paragraph not rendered");
    }
    // The markdown root the thinking text renders into — the element that
    // would carry the scrollbar if the content could not fit.
    const block = prose.parentElement;
    const answer = [...document.querySelectorAll(".is-assistant p")].find(
      (paragraph) =>
        paragraph.textContent?.startsWith("The helper reconciles every knob"),
    );
    // The tinted panel the code sits on. It may be wider than the block — its
    // own container scrolls — but never narrower than the code, which would
    // draw the line off the end of its own background.
    const codePanel = block.querySelector(
      "[data-streamdown='code-block-body'] pre",
    );
    return {
      blockOverflow: block.scrollWidth - block.clientWidth,
      proseOverflow: prose.scrollWidth - prose.clientWidth,
      codePanelOverflow: codePanel
        ? codePanel.scrollWidth - codePanel.clientWidth
        : 0,
      proseWidth: Math.round(prose.getBoundingClientRect().width),
      answerWidth: answer
        ? Math.round(answer.getBoundingClientRect().width)
        : 0,
    };
  });
}

async function expectWireMockReady() {
  try {
    const response = await fetch(`${WIREMOCK_BASE_URL}/__admin/health`);
    if (response.ok) {
      return;
    }

    throw new Error(`${response.status} ${await response.text()}`);
  } catch (error) {
    throw new Error(
      `WireMock is not reachable at ${WIREMOCK_BASE_URL}. Run tilt trigger e2e-test-dependencies before the chat reconnect e2e. ${String(
        error,
      )}`,
    );
  }
}

async function waitForConversationId(page: Page) {
  await expect(async () => {
    expect(extractConversationId(page.url())).toBeTruthy();
  }).toPass({ timeout: 10_000, intervals: [250, 500, 1000] });

  const conversationId = extractConversationId(page.url());
  if (!conversationId) {
    throw new Error(`Could not find conversation id in URL: ${page.url()}`);
  }
  return conversationId;
}

async function fetchConversationTranscript(page: Page, conversationId: string) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/chat/conversations/${id}`, {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch conversation: ${response.status}`);
    }

    const conversation = (await response.json()) as {
      messages: Array<{ role: string; parts?: Array<{ text?: string }> }>;
    };
    const textFor = (message: { parts?: Array<{ text?: string }> }) =>
      message.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim() ?? "";

    return {
      userMessages: conversation.messages
        .filter((message) => message.role === "user")
        .map(textFor),
      assistantMessages: conversation.messages
        .filter((message) => message.role === "assistant")
        .map(textFor),
    };
  }, conversationId);
}

function makeTestMessageId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractConversationId(url: string): string | null {
  return (
    new URL(url).pathname.match(
      /^\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    )?.[1] ?? null
  );
}
