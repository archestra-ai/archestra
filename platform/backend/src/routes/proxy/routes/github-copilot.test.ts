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
import { http, HttpResponse } from "msw";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { ApiError } from "@/types";
import githubCopilotProxyRoutes from "./github-copilot";

const COPILOT_TOKEN_EXCHANGE_URL =
  "https://api.github.com/copilot_internal/v2/token";
const COPILOT_CHAT_COMPLETIONS_URL =
  "https://api.githubcopilot.com/chat/completions";

/** The exact upstream rejection observed in T-959. */
const MODEL_NOT_SUPPORTED_BODY = {
  error: {
    message: "The requested model is not supported.",
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
