import { E2eTestId } from "@shared";
import { WIREMOCK_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";
import {
  expectChatReady,
  getRuntimeModelForProvider,
  goToChat,
  selectApiKeyForProvider,
  selectRuntimeModelFromDialog,
} from "../utils";

// Run all provider tests sequentially to avoid WireMock stub timing issues.
// Retries handle transient streaming/WireMock flakiness in CI.
test.describe.configure({ mode: "serial", retries: 2 });

// Warm up WireMock's SSE streaming pipeline before the first test.
// The Anthropic test (first in sequence) flakes ~41% of runs because the first
// streaming request through WireMock takes >90s in CI due to cold-start overhead.
// This throwaway request primes the connection so the real test succeeds immediately.
test.beforeAll(async () => {
  try {
    await fetch(`${WIREMOCK_BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "chat-ui-e2e-test warmup" }],
      }),
    });
  } catch {
    // Warm-up failure is non-fatal — the test will retry if needed
  }
});

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

const skippedProviders = new Set<string>();

for (const config of testConfigs) {
  test.describe(`Chat-UI-${config.providerName}`, () => {
    if (skippedProviders.has(config.providerName)) {
      test.skip();
    }
    // Increase timeout for chat tests since they involve streaming responses
    test.setTimeout(120_000);

    test(`can send a message and receive a response from ${config.providerDisplayName}`, async ({
      page,
      makeRandomString,
    }) => {
      await goToChat(page);
      await expectChatReady(page);
      const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);

      const runtimeModel = await getRuntimeModelForProvider(
        page,
        config.providerName,
      );
      test.skip(
        !runtimeModel,
        `${config.providerDisplayName} is not configured in this test environment`,
      );
      if (!runtimeModel) {
        return;
      }

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
      const testMessageId = makeRandomString(8, config.wiremockStubId);
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
