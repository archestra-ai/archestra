import { expect, test } from "../fixtures";

// =============================================================================
// Test Configuration Interface
// =============================================================================

interface CompressionTestConfig {
  providerName: string;
  endpoint: (profileId: string) => string;
  headers: (wiremockStub: string) => Record<string, string>;
  buildRequestWithToolResult: () => object;
  // Extract tool result content from the processedRequest for verification
  extractToolResultContent: (processedRequest: unknown) => string | null;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a string is valid JSON
 */
function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if content appears to be TOON-encoded (not valid JSON but contains data)
 * TOON format is a compact representation that is NOT valid JSON
 */
function isToonEncoded(content: string): boolean {
  // TOON-encoded content:
  // 1. Should NOT be valid JSON
  // 2. Should contain some content (not empty)
  // 3. Should be shorter or similar length to original
  return content.length > 0 && !isValidJson(content);
}

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

  // OpenAI format: tool results are in "tool" role messages
  extractToolResultContent: (processedRequest: unknown) => {
    const req = processedRequest as {
      messages?: Array<{ role: string; content?: string }>;
    };
    const toolMessage = req.messages?.find((m) => m.role === "tool");
    return toolMessage?.content ?? null;
  },

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
        content: JSON.stringify({
          files: [
            { name: "README.md", size: 1024, type: "file" },
            { name: "src", size: 4096, type: "directory" },
            { name: "package.json", size: 512, type: "file" },
            { name: "tsconfig.json", size: 256, type: "file" },
            { name: "node_modules", size: 102400, type: "directory" },
          ],
          totalCount: 5,
          directory: ".",
        }),
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
  extractToolResultContent: (processedRequest: unknown) => {
    const req = processedRequest as {
      messages?: Array<{
        role: string;
        content?: Array<{ type: string; content?: string }>;
      }>;
    };
    // Find user message with tool_result content
    for (const msg of req.messages || []) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const toolResult = msg.content.find((c) => c.type === "tool_result");
        if (toolResult?.content) {
          return toolResult.content;
        }
      }
    }
    return null;
  },

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
            content: JSON.stringify({
              files: [
                { name: "README.md", size: 1024, type: "file" },
                { name: "src", size: 4096, type: "directory" },
                { name: "package.json", size: 512, type: "file" },
                { name: "tsconfig.json", size: 256, type: "file" },
                { name: "node_modules", size: 102400, type: "directory" },
              ],
              totalCount: 5,
              directory: ".",
            }),
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
  // When compressed, response becomes { toon: "compressed string" }
  extractToolResultContent: (processedRequest: unknown) => {
    const req = processedRequest as {
      contents?: Array<{
        role: string;
        parts?: Array<{
          functionResponse?: {
            response?: unknown;
          };
        }>;
      }>;
    };
    // Find user content with functionResponse
    for (const content of req.contents || []) {
      if (content.role === "user" && content.parts) {
        for (const part of content.parts) {
          if (part.functionResponse?.response) {
            const response = part.functionResponse.response;
            // When compressed, response is { toon: "..." }
            if (
              typeof response === "object" &&
              response !== null &&
              "toon" in response
            ) {
              return (response as { toon: string }).toon;
            }
            // When not compressed, response is the original object
            return JSON.stringify(response);
          }
        }
      }
    }
    return null;
  },

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
              response: {
                files: [
                  { name: "README.md", size: 1024, type: "file" },
                  { name: "src", size: 4096, type: "directory" },
                  { name: "package.json", size: 512, type: "file" },
                  { name: "tsconfig.json", size: 256, type: "file" },
                  { name: "node_modules", size: 102400, type: "directory" },
                ],
                totalCount: 5,
                directory: ".",
              },
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

    const wiremockStub = `${config.providerName.toLowerCase()}-compression-test`;

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
      getInteractions,
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
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(profileId),
        headers: config.headers(wiremockStub),
        data: config.buildRequestWithToolResult(),
      });

      expect(response.ok()).toBeTruthy();

      // 4. Wait for async interaction recording
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 5. Query interactions to verify compression stats
      const interactionsResponse = await getInteractions(request, {
        profileId,
        sortBy: "createdAt",
        sortDirection: "desc",
        limit: 1,
      });
      const interactions = await interactionsResponse.json();

      expect(interactions.data.length).toBeGreaterThan(0);
      const interaction = interactions.data[0];

      // Verify compression stats were recorded
      expect(interaction.toonTokensBefore).not.toBeNull();
      expect(interaction.toonTokensAfter).not.toBeNull();
      expect(interaction.toonTokensBefore).toBeGreaterThan(0);
      expect(interaction.toonTokensAfter).toBeGreaterThan(0);
      // Compression should reduce tokens
      expect(interaction.toonTokensBefore).toBeGreaterThan(
        interaction.toonTokensAfter,
      );

      // Verify actual content was compressed in processedRequest
      expect(interaction.processedRequest).not.toBeNull();
      const toolResultContent = config.extractToolResultContent(
        interaction.processedRequest,
      );
      expect(toolResultContent).not.toBeNull();
      // TOON-encoded content should NOT be valid JSON
      expect(isToonEncoded(toolResultContent!)).toBe(true);
    });

    test("does not compress tool results when compression is disabled", async ({
      request,
      createAgent,
      updateOrganization,
      getInteractions,
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
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: config.endpoint(profileId),
        headers: config.headers(wiremockStub),
        data: config.buildRequestWithToolResult(),
      });

      expect(response.ok()).toBeTruthy();

      // 4. Wait for async interaction recording
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 5. Query interactions to verify no compression stats
      const interactionsResponse = await getInteractions(request, {
        profileId,
        sortBy: "createdAt",
        sortDirection: "desc",
        limit: 1,
      });
      const interactions = await interactionsResponse.json();

      expect(interactions.data.length).toBeGreaterThan(0);
      const interaction = interactions.data[0];

      // Verify compression stats were NOT recorded
      expect(interaction.toonTokensBefore).toBeNull();
      expect(interaction.toonTokensAfter).toBeNull();
      expect(interaction.toonCostSavings).toBeNull();

      // Verify actual content was NOT compressed in processedRequest
      expect(interaction.processedRequest).not.toBeNull();
      const toolResultContent = config.extractToolResultContent(
        interaction.processedRequest,
      );
      expect(toolResultContent).not.toBeNull();
      // Non-compressed content should be valid JSON
      expect(isValidJson(toolResultContent!)).toBe(true);
    });

    test.afterEach(
      async ({ request, deleteAgent, updateOrganization }) => {
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
      },
    );
  });
}
