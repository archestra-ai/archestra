import { expect, test } from "../fixtures";

// All compression tests must run serially because they modify shared organization settings
test.describe.configure({ mode: "serial" });

// =============================================================================
// Test Configuration Interface
// =============================================================================

interface CompressionTestConfig {
  providerName: string;
  endpoint: (profileId: string) => string;
  headers: (wiremockStub: string) => Record<string, string>;
  buildRequestWithToolResult: () => object;
}

// =============================================================================
// Shared Test Data
// =============================================================================

/**
 * The tool result data used across all provider tests.
 * WireMock stubs use body pattern matching to verify:
 * - Compression enabled: matches "files[5]{name,size,type}" (TOON format)
 * - Compression disabled: matches '{"files":[{"name":"README.md","size":1024' (JSON format)
 */
const TOOL_RESULT_DATA = {
  files: [
    { name: "README.md", size: 1024, type: "file" },
    { name: "src", size: 4096, type: "directory" },
    { name: "package.json", size: 512, type: "file" },
    { name: "tsconfig.json", size: 256, type: "file" },
    { name: "node_modules", size: 102400, type: "directory" },
  ],
  totalCount: 5,
  directory: ".",
};

// =============================================================================
// Test Configurations
// =============================================================================

const openaiConfig: CompressionTestConfig = {
  providerName: "OpenAI",

  endpoint: (profileId) => `/v1/openai/${profileId}/chat/completions`,

  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),

  // OpenAI format: tool results are sent as separate "tool" role messages
  buildRequestWithToolResult: () => ({
    model: "gpt-4",
    messages: [
      { role: "user", content: "What files are in the current directory?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "list_files",
              arguments: '{"directory": "."}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: JSON.stringify(TOOL_RESULT_DATA),
      },
    ],
  }),
};

const anthropicConfig: CompressionTestConfig = {
  providerName: "Anthropic",

  endpoint: (profileId) => `/v1/anthropic/${profileId}/v1/messages`,

  headers: (wiremockStub) => ({
    "x-api-key": wiremockStub,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  }),

  // Anthropic format: tool results are in user messages as tool_result blocks
  buildRequestWithToolResult: () => ({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "What files are in the current directory?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_123",
            name: "list_files",
            input: { directory: "." },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: JSON.stringify(TOOL_RESULT_DATA),
          },
        ],
      },
    ],
  }),
};

const geminiConfig: CompressionTestConfig = {
  providerName: "Gemini",

  endpoint: (profileId) =>
    `/v1/gemini/${profileId}/v1beta/models/gemini-2.5-pro:generateContent`,

  headers: (wiremockStub) => ({
    "x-goog-api-key": wiremockStub,
    "Content-Type": "application/json",
  }),

  // Gemini format: tool results are functionResponse parts in user content
  buildRequestWithToolResult: () => ({
    contents: [
      {
        role: "user",
        parts: [{ text: "What files are in the current directory?" }],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "list_files",
              args: { directory: "." },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "list_files",
              response: TOOL_RESULT_DATA,
            },
          },
        ],
      },
    ],
  }),
};

// =============================================================================
// Test Suite
// =============================================================================

const testConfigs: CompressionTestConfig[] = [
  openaiConfig,
  anthropicConfig,
  geminiConfig,
];

for (const config of testConfigs) {
  test.describe(`LLMProxy-ToolResultCompression-${config.providerName}`, () => {
    let profileId: string;
    let originalCompressionEnabled: boolean;
    let originalCompressionScope: "organization" | "team";

    // WireMock stubs match on this API key prefix
    const wiremockStub = `${config.providerName.toLowerCase()}-compression`;

    test.beforeEach(async ({ request, getOrganization }) => {
      // Store original organization compression settings to restore later
      const orgResponse = await getOrganization(request);
      const org = await orgResponse.json();
      originalCompressionEnabled = org.convertToolResultsToToon;
      originalCompressionScope = org.compressionScope || "organization";
    });

    test("compresses tool results when compression is enabled", async ({
      request,
      createAgent,
      updateOrganization,
      makeApiRequest,
    }) => {
      // 1. Enable compression at organization level
      await updateOrganization(request, {
        convertToolResultsToToon: true,
        compressionScope: "organization",
      });

      // 2. Create a test profile
      const createResponse = await createAgent(
        request,
        `${config.providerName} Compression Enabled Test Profile`,
      );
      const profile = await createResponse.json();
      profileId = profile.id;

      // 3. Make request with tool result
      // WireMock stub matches on body containing "files[5]{name,size,type}" (TOON format)
      // If compression works correctly, request will match and return 200
      // If compression fails, request won't match any stub and will fail
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(profileId),
        headers: config.headers(wiremockStub),
        data: config.buildRequestWithToolResult(),
      });

      expect(response.ok()).toBeTruthy();
    });

    test("does not compress tool results when compression is disabled", async ({
      request,
      createAgent,
      updateOrganization,
      makeApiRequest,
    }) => {
      // 1. Disable compression at organization level
      await updateOrganization(request, {
        convertToolResultsToToon: false,
        compressionScope: "organization",
      });

      // 2. Create a test profile
      const createResponse = await createAgent(
        request,
        `${config.providerName} Compression Disabled Test Profile`,
      );
      const profile = await createResponse.json();
      profileId = profile.id;

      // 3. Make request with tool result
      // WireMock stub matches on body containing JSON format
      // If compression is correctly disabled, request will match and return 200
      // If compression incorrectly happens, request won't match and will fail
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(profileId),
        headers: config.headers(wiremockStub),
        data: config.buildRequestWithToolResult(),
      });

      expect(response.ok()).toBeTruthy();
    });

    test.afterEach(async ({ request, deleteAgent, updateOrganization }) => {
      // Restore original compression settings
      await updateOrganization(request, {
        convertToolResultsToToon: originalCompressionEnabled,
        compressionScope: originalCompressionScope,
      }).catch(() => {});

      // Clean up test profile
      if (profileId) {
        await deleteAgent(request, profileId).catch(() => {});
        profileId = "";
      }
    });
  });
}
