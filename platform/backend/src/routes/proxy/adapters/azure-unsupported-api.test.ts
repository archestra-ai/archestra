import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import type { Azure } from "@/types";
import { azureAdapterFactory } from "./azure";

// biome-ignore lint/correctness/useHookAtTopLevel: This registers Vitest lifecycle hooks, not React hooks.
const server = useMswServer();

const baseUrl = "https://contoso-ai.services.ai.azure.com/openai/v1";

// What Microsoft Foundry answers when a Claude deployment is called over
// OpenAI Chat Completions.
const foundryApiNotSupported = () =>
  HttpResponse.json(
    {
      error: {
        code: "api_not_supported",
        message: "Requested API is currently not supported",
        details: "Requested API is currently not supported",
      },
    },
    { status: 404 },
  );

describe("Azure Chat Completions on a deployment that does not serve it", () => {
  test.each([
    ["execute", false],
    ["executeStream", true],
  ] as const)("%s explains what to call instead of relaying the opaque 404", async (method, stream) => {
    server.use(
      http.post(`${baseUrl}/chat/completions`, foundryApiNotSupported),
    );
    const client = azureAdapterFactory.createClient("azure-test-key", {
      baseUrl,
      source: "api",
    });
    const request = {
      model: "team-assistant",
      messages: [{ role: "user", content: "Hello!" }],
      stream,
    } as Azure.Types.ChatCompletionsRequest;

    const call =
      method === "execute"
        ? azureAdapterFactory.execute(client, request)
        : azureAdapterFactory.executeStream(client, request);

    await expect(call).rejects.toMatchObject({ statusCode: 400 });
    const message = await call.catch((error: Error) => error.message);
    expect(message).toContain(
      '"team-assistant" does not serve the OpenAI Chat Completions API',
    );
    expect(message).toContain("POST /v1/model-router/responses");
    expect(message).toContain(
      "base URL https://contoso-ai.services.ai.azure.com/anthropic,",
    );
    expect(message).toContain('call "anthropic:team-assistant"');
  });

  test("other upstream 404s pass through unchanged", async () => {
    server.use(
      http.post(`${baseUrl}/chat/completions`, () =>
        HttpResponse.json(
          {
            error: {
              code: "DeploymentNotFound",
              message: "The API deployment for this resource does not exist.",
            },
          },
          { status: 404 },
        ),
      ),
    );
    const client = azureAdapterFactory.createClient("azure-test-key", {
      baseUrl,
      source: "api",
    });

    await expect(
      azureAdapterFactory.execute(client, {
        model: "missing",
        messages: [{ role: "user", content: "Hello!" }],
      } as Azure.Types.ChatCompletionsRequest),
    ).rejects.toMatchObject({
      status: 404,
      error: { code: "DeploymentNotFound" },
    });
  });
});
