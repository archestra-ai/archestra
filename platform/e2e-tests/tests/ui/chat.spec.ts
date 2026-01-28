import type { Page } from "@playwright/test";
import { E2eTestId, type SupportedProvider } from "@shared";
import { UI_BASE_URL } from "../../consts";
import { expect, test } from "../../fixtures";

// Run all provider tests sequentially to avoid WireMock stub timing issues
test.describe.configure({ mode: "serial" });

/**
 * Creates an API key for a provider and waits for models to sync.
 * This is required because models are stored in the database and linked to API keys.
 */
async function setupApiKeyForProvider(
  page: Page,
  provider: SupportedProvider,
): Promise<string> {
  // Create API key via API
  const response = await page.request.post(
    `${UI_BASE_URL}/api/chat-api-keys`,
    {
      data: {
        name: `E2E Test ${provider} Key`,
        provider,
        apiKey: `e2e-test-${provider}-key`,
        scope: "org_wide",
      },
    },
  );

  if (!response.ok()) {
    throw new Error(
      `Failed to create API key for ${provider}: ${response.status()}`,
    );
  }

  const apiKey = await response.json();

  // Wait for models to sync by polling the models endpoint
  // The sync happens asynchronously after API key creation
  const maxWaitMs = 10_000;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const modelsResponse = await page.request.get(
      `${UI_BASE_URL}/api/chat/models?provider=${provider}`,
    );
    if (modelsResponse.ok()) {
      const models = await modelsResponse.json();
      if (Array.isArray(models) && models.length > 0) {
        break;
      }
    }
    await page.waitForTimeout(500);
  }

  return apiKey.id;
}

/**
 * Deletes an API key by ID.
 */
async function cleanupApiKey(page: Page, apiKeyId: string): Promise<void> {
  await page.request.delete(`${UI_BASE_URL}/api/chat-api-keys/${apiKeyId}`);
}

interface ChatProviderTestConfig {
  providerName: string;
  /** Display name shown in model selector dropdown */
  providerDisplayName: string;
  /** Model ID to select from the dropdown */
  modelId: string;
  /** Model display name shown in selector */
  modelDisplayName: string;
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
  modelId: "claude-3-5-sonnet-20241022",
  modelDisplayName: "Claude 3.5 Sonnet",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// OpenAI - Uses OpenAI streaming format
const openaiConfig: ChatProviderTestConfig = {
  providerName: "openai",
  providerDisplayName: "OpenAI",
  modelId: "gpt-4o",
  modelDisplayName: "GPT-4o",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Gemini - Uses Google AI streaming format
const geminiConfig: ChatProviderTestConfig = {
  providerName: "gemini",
  providerDisplayName: "Google",
  modelId: "gemini-2.5-flash",
  modelDisplayName: "Gemini 2.5 Flash",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Cerebras - Uses OpenAI-compatible streaming format
// Note: Cerebras filters out models with "llama" in the name for chat, so we use cerebras-gpt
const cerebrasConfig: ChatProviderTestConfig = {
  providerName: "cerebras",
  providerDisplayName: "Cerebras",
  modelId: "cerebras-gpt-13b",
  modelDisplayName: "cerebras-gpt-13b",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Cohere - Uses Cohere v2 streaming format
const cohereConfig: ChatProviderTestConfig = {
  providerName: "cohere",
  providerDisplayName: "Cohere",
  modelId: "command-r-plus",
  modelDisplayName: "Command R+",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Mistral - Uses OpenAI-compatible streaming format
const mistralConfig: ChatProviderTestConfig = {
  providerName: "mistral",
  providerDisplayName: "Mistral",
  modelId: "mistral-large-latest",
  modelDisplayName: "Mistral Large",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// Ollama - Uses OpenAI-compatible streaming format
const ollamaConfig: ChatProviderTestConfig = {
  providerName: "ollama",
  providerDisplayName: "Ollama",
  modelId: "meta-llama/Llama-3.1-8B-Instruct",
  modelDisplayName: "Llama 3.1 8B Instruct",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// vLLM - Uses OpenAI-compatible streaming format
const vllmConfig: ChatProviderTestConfig = {
  providerName: "vllm",
  providerDisplayName: "vLLM",
  modelId: "meta-llama/Llama-3.1-8B-Instruct",
  modelDisplayName: "Llama 3.1 8B Instruct",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

// ZhipuAI - Uses OpenAI-compatible streaming format
const zhipuaiConfig: ChatProviderTestConfig = {
  providerName: "zhipuai",
  providerDisplayName: "ZhipuAI",
  modelId: "glm-4.5-flash",
  modelDisplayName: "GLM-4.5 Flash",
  wiremockStubId: "chat-ui-e2e-test",
  expectedResponse: "This is a mocked response for the chat UI e2e test.",
};

const testConfigs: ChatProviderTestConfig[] = [
  anthropicConfig,
  openaiConfig,
  geminiConfig,
  cerebrasConfig,
  cohereConfig,
  mistralConfig,
  ollamaConfig,
  vllmConfig,
  zhipuaiConfig,
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
      goToPage,
      makeRandomString,
    }) => {
      // Create API key for the provider before navigating to chat
      // This is required because models are stored in the database and linked to API keys
      const apiKeyId = await setupApiKeyForProvider(
        page,
        config.providerName as SupportedProvider,
      );

      try {
        // Skip onboarding if dialog is present
        const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);

        // Navigate to chat page
        await goToPage(page, "/chat");
        await page.waitForLoadState("networkidle");

        // Skip onboarding if it appears
        if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
          await skipButton.click();
          await page.waitForTimeout(500);
        }

        // Wait for the chat page to load - look for the prompt input area
        const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
        await expect(textarea).toBeVisible({ timeout: 15_000 });

        // Open model selector and choose the test model
        const modelSelectorTrigger = page.getByTestId(
          E2eTestId.ChatModelSelectorTrigger,
        );
        await expect(modelSelectorTrigger).toBeVisible({ timeout: 10_000 });
        await modelSelectorTrigger.click();

        // Wait for the model selector dialog to open
        await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

        // Search for the model if search input is available
        const searchInput = page.getByPlaceholder("Search models...");
        if (await searchInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await searchInput.fill(config.modelId);
          await page.waitForTimeout(500);
        }

        // Click on the model option that contains our model ID
        const modelOption = page
          .getByRole("option")
          .filter({ hasText: config.modelId });
        await expect(modelOption.first()).toBeVisible({ timeout: 5_000 });
        await modelOption.first().click();

        // Wait for dialog to close
        await expect(page.getByRole("dialog")).not.toBeVisible({
          timeout: 5_000,
        });

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
        await expect(page.getByText(config.expectedResponse)).toBeVisible({
          timeout: 30_000,
        });

        // Verify the user's message also appears in the chat
        await expect(page.getByText(testMessage)).toBeVisible();
      } finally {
        // Clean up the API key
        await cleanupApiKey(page, apiKeyId);
      }
    });
  });
}
