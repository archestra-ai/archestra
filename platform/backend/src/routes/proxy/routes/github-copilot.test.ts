/**
 * GitHub Copilot proxy route tests.
 *
 * Regression coverage for T-959: Copilot's /chat/completions can reject a
 * model that its own /models catalog advertises (and that we therefore
 * synced and offered in the picker) with a 400
 * `{"error":{"message":"The requested model is not supported.","type":"api_validation_error"}}`.
 *
 * These tests drive the real route, adapter, and Copilot fetch wrapper
 * (token exchange + editor-identity headers) with the network faked at the
 * wire, pinning:
 *   - the exact request Copilot receives (catalogued model name — never a
 *     models.id UUID — plus the exchanged bearer and integration headers)
 *   - how the upstream rejection surfaces to the proxy caller
 */
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { ApiError, GithubCopilot } from "@/types";
import githubCopilotProxyRoutes from "./github-copilot";

const COPILOT_TOKEN_EXCHANGE_URL =
  "https://api.github.com/copilot_internal/v2/token";
const COPILOT_CHAT_COMPLETIONS_URL =
  "https://api.githubcopilot.com/chat/completions";

/** The exact upstream rejection observed in T-959. */
const MODEL_NOT_SUPPORTED_BODY = {
  error: {
    message: GithubCopilot.API.MODEL_NOT_SUPPORTED_MESSAGE,
    type: "api_validation_error",
  },
};

// The Copilot bearer cache is keyed by the GitHub token, so each test uses a
// fresh token to stay independent of the singleton token manager's state.
let tokenCounter = 0;
function uniqueGithubToken(): string {
  tokenCounter += 1;
  return `gho_proxy_test_${Date.now()}_${tokenCounter}`;
}

function createTestApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { message: error.message, type: error.type },
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.status(500).send({
      error: { message, type: "api_internal_server_error" },
    });
  });
  return app;
}

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper (per-test MSW server), not a React hook
const server = useMswServer();

function stubTokenExchange() {
  server.use(
    http.get(COPILOT_TOKEN_EXCHANGE_URL, () =>
      HttpResponse.json({
        token: "copilot-bearer-test",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      }),
    ),
  );
}

describe("GitHub Copilot proxy — upstream model rejection (T-959)", () => {
  test("non-streaming: sends the catalogued model name with the exchanged bearer, surfaces Copilot's 400", async ({
    makeAgent,
  }) => {
    const app = createTestApp();
    await app.register(githubCopilotProxyRoutes);
    const agent = await makeAgent({ name: "Copilot Proxy Agent" });

    stubTokenExchange();
    let upstreamModel: unknown;
    let upstreamAuthorization: string | null = null;
    let upstreamIntegrationId: string | null = null;
    server.use(
      http.post(COPILOT_CHAT_COMPLETIONS_URL, async ({ request }) => {
        const body = (await request.json()) as { model?: unknown };
        upstreamModel = body.model;
        upstreamAuthorization = request.headers.get("authorization");
        upstreamIntegrationId = request.headers.get("copilot-integration-id");
        return HttpResponse.json(MODEL_NOT_SUPPORTED_BODY, { status: 400 });
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/github-copilot/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${uniqueGithubToken()}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    // What Copilot received: the catalogued model name (never a models.id
    // UUID), the exchanged short-lived bearer, and the editor identity.
    expect(upstreamModel).toBe("gpt-4");
    expect(upstreamAuthorization).toBe("Bearer copilot-bearer-test");
    expect(upstreamIntegrationId).toBe("vscode-chat");

    // The deterministic upstream rejection reaches the caller as a 400 with
    // the provider's message intact (not a masked 500).
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("The requested model is not supported.");
  });

  test("streaming: the same 400 surfaces instead of a stream", async ({
    makeAgent,
  }) => {
    const app = createTestApp();
    await app.register(githubCopilotProxyRoutes);
    const agent = await makeAgent({ name: "Copilot Proxy Streaming Agent" });

    stubTokenExchange();
    server.use(
      http.post(COPILOT_CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json(MODEL_NOT_SUPPORTED_BODY, { status: 400 }),
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/github-copilot/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${uniqueGithubToken()}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("The requested model is not supported.");
  });
});

describe("GitHub Copilot Responses account routing", () => {
  test.for([
    false,
    true,
  ])("completes a Responses request at the exchanged API endpoint (stream=%s)", async (stream, {
    makeAgent,
  }) => {
    const app = createTestApp();
    await app.register(githubCopilotProxyRoutes);
    const agent = await makeAgent({ name: "Copilot Responses Agent" });
    const model = "gpt-5.3-codex";
    const text = "Hello from Copilot";
    const result = {
      id: "resp_test",
      object: "response",
      created_at: 123,
      model,
      status: "completed",
      output: [
        {
          id: "msg_test",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
    let upstreamCalls = 0;
    // Drain MSW's response clone so the SDK can cancel its SSE reader when
    // the proxy stops at response.completed without waiting on the other tee.
    const drainResponse = ({ response }: { response: Response }) => {
      void response.arrayBuffer();
    };
    server.events.on("response:mocked", drainResponse);
    server.use(
      http.get(COPILOT_TOKEN_EXCHANGE_URL, () =>
        HttpResponse.json({
          token: "copilot-responses-bearer",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: "https://api.business.githubcopilot.com" },
        }),
      ),
      http.post("https://api.githubcopilot.com/responses", () =>
        HttpResponse.json(
          {
            error: { message: "", type: "api_not_found_error" },
          },
          { status: 404 },
        ),
      ),
      http.post(
        "https://api.business.githubcopilot.com/responses",
        async ({ request }) => {
          upstreamCalls++;
          expect(request.headers.get("authorization")).toBe(
            "Bearer copilot-responses-bearer",
          );
          expect(request.headers.get("copilot-integration-id")).toBe(
            "vscode-chat",
          );
          expect(await request.json()).toMatchObject({ model, stream });
          if (!stream) return HttpResponse.json(result);
          const events = [
            {
              type: "response.created",
              response: { ...result, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...result.output[0], content: [] },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              item_id: "msg_test",
              delta: text,
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: result.output[0],
            },
            { type: "response.completed", response: result },
          ];
          return new HttpResponse(
            events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        },
      ),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/github-copilot/${agent.id}/responses`,
        headers: { authorization: `Bearer ${uniqueGithubToken()}` },
        payload: { model, input: "Hello", stream },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain(text);
      expect(upstreamCalls).toBe(1);
      if (stream) expect(response.body).toContain("response.completed");
      else
        expect(response.json()).toMatchObject({ model, output: result.output });
    } finally {
      server.events.removeListener("response:mocked", drainResponse);
      await app.close();
    }
  });
});
