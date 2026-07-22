/**
 * E2E test for Bedrock tool-name encoding through the LLM Proxy.
 *
 * Bedrock's Converse API constrains toolSpec names to ^[a-zA-Z0-9_-]{1,64}$ and
 * rejects the request outright when a name falls outside it. Proxy clients bring
 * their own tool definitions, so names with dots/spaces/@ reach us routinely.
 *
 * The WireMock stub (bedrock-tool-name-sanitization.json) only matches when the
 * *sanitized* name is present in the Converse body it receives, so an unencoded
 * name means no stub match (404) and this test fails. The response then carries
 * the provider-facing name back, proving the proxy restores the client's original.
 */
import { API_BASE_URL } from "../../consts";
import { expect, test } from "../api-fixtures";

/** Every character class Bedrock rejects: dot, space, and @. */
const CLIENT_TOOL_NAME = "weather.get current@v2";
/** What the proxy must send upstream — matches the WireMock stub. */
const PROVIDER_TOOL_NAME = "weather_get_current_v2";

test.describe("LLM Proxy - Bedrock tool name encoding", () => {
  test("sanitizes tool names Bedrock rejects and restores the client's name", async ({
    request,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResponse = await createLlmProxy(
      request,
      `Bedrock Tool Names ${Date.now()}`,
      "personal",
    );
    const proxy = await proxyResponse.json();
    const proxyId = proxy.id;

    try {
      const response = await request.post(
        `${API_BASE_URL}/v1/bedrock/${proxyId}/converse`,
        {
          headers: {
            Authorization: "Bearer bedrock-tool-name-sanitization",
            "Content-Type": "application/json",
          },
          data: {
            modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
            messages: [{ role: "user", content: [{ text: "weather?" }] }],
            toolConfig: {
              tools: [
                {
                  toolSpec: {
                    name: CLIENT_TOOL_NAME,
                    description: "gets weather",
                    inputSchema: {
                      json: {
                        type: "object",
                        properties: { city: { type: "string" } },
                      },
                    },
                  },
                },
              ],
              toolChoice: { tool: { name: CLIENT_TOOL_NAME } },
            },
          },
        },
      );

      // Read the body FIRST so we can include it in the assertion error message.
      const body = await response.json();
      expect(
        response.status(),
        `Expected 200 but got ${response.status()}. A 404 means WireMock matched no stub — ` +
          `the proxy sent a tool name other than "${PROVIDER_TOOL_NAME}". Response body: ${JSON.stringify(body)}`,
      ).toBe(200);

      // The client gets back the name it sent, not the provider-facing one.
      expect(body.output.message.content[0].toolUse.name).toBe(
        CLIENT_TOOL_NAME,
      );
    } finally {
      await deleteAgent(request, proxyId);
    }
  });
});
