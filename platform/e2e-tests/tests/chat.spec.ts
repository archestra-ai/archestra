import type { Page } from "@playwright/test";
import { E2eTestId } from "@shared";
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

// Run all provider tests sequentially to avoid WireMock stub timing issues.
// Retries handle transient streaming/WireMock flakiness in CI.
test.describe.configure({ mode: "serial", retries: 2 });

interface ChatProviderTestConfig {
  providerName: string;
  /** Display name shown in model selector provider grouping */
  providerDisplayName: string;
  /** Unique identifier used in wiremock mapping to match this test's requests (must appear in message body) */
  wiremockStubId: string;
  /** Expected response text from the mocked LLM */
  expectedResponse: string;
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

// Perplexity - Uses OpenAI-compatible streaming format
const perplexityConfig: ChatProviderTestConfig = {
  providerName: "perplexity",
  providerDisplayName: "Perplexity",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
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

// cerebras: model selector intermittently never renders in CI (15s timeout).
// Tracked alongside MQ flakiness from https://github.com/archestra-ai/archestra/actions/runs/26282803981.
const skippedProviders = new Set<string>(["cerebras"]);

for (const config of testConfigs) {
  test.describe(`Chat-UI-${config.providerName}`, () => {
    if (skippedProviders.has(config.providerName)) {
      test.skip();
    }
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

      // Wait for the response to appear
      // The mocked response should contain our expected text
      // Use generous timeout - streaming responses in CI can be slow
      // (WireMock + streaming + CI resource contention can take >60s)
      await expect(page.getByText(config.expectedResponse)).toBeVisible({
        timeout: 90_000,
      });

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
