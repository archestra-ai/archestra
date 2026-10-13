/**
 * Jev decisions proxy route: the request body reaches the configured decisions
 * endpoint unchanged, the answers come back unchanged, and the call is logged
 * as a `jev:decisions` interaction. The upstream is faked at the network
 * boundary, so the real adapter and HTTP client run.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import { InteractionModel, VirtualApiKeyModel } from "@/models";
import authRoutes from "@/routes/auth";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { useMswServer } from "@/test/msw";
import type { Agent } from "@/types";
import jevProxyRoutes from "./jev";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

const DECISIONS_REQUEST = {
  model: "jev-1.13.0",
  state: { tool: "github__delete_repo", arguments: { repo: "acme/site" } },
  questions: {
    requires_trusted: {
      type: "noul",
      instructions: "Does this call need a trusted context?",
      criteria: { true: "It changes shared state", false: "It only reads" },
    },
    delta_trust: {
      type: "choice",
      instructions: "How trustworthy is the result?",
      criteria: { trusted: "Comes from the user", suspicious: "Third party" },
    },
  },
};

const DECISIONS_RESPONSE = {
  id: "dec-1",
  model: "jev-1.13.0",
  answers: {
    requires_trusted: { type: "noul", noul: 0.91 },
    delta_trust: {
      type: "choice",
      choice: "trusted",
      probabilities: { trusted: 0.8, suspicious: 0.2 },
    },
  },
  usage: { input_tokens: 120, output_tokens: 4 },
};

describe("Jev decisions proxy route", () => {
  const server = useMswServer();
  let app: FastifyInstance;
  let agent: Agent;

  beforeEach(async ({ makeAgent }) => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(authRoutes);
    await app.register(jevProxyRoutes);
    // The default LLM proxy, so interactions are logged under this agent.
    agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  });

  afterEach(async () => {
    await app.close();
  });

  test("forwards the request to TypeSafe and logs the decision", async () => {
    const upstream = captureUpstream(TYPESAFE_ENDPOINT, DECISIONS_RESPONSE);

    const response = await send({ token: "sk-typesafe" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(DECISIONS_RESPONSE);
    expect(upstream.requests).toEqual([
      { authorization: "Bearer sk-typesafe", body: DECISIONS_REQUEST },
    ]);

    const [interaction] = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interaction).toMatchObject({
      type: "jev:decisions",
      model: "jev-1.13.0",
      inputTokens: 120,
      outputTokens: 4,
    });
  });

  test("reaches Jev through OpenRouter when a key points at its decisions endpoint", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const upstream = captureUpstream(OPENROUTER_ENDPOINT, DECISIONS_RESPONSE);
    const secret = await makeSecret({ secret: { apiKey: "sk-or-v1-test" } });
    const key = await makeLlmProviderApiKey(agent.organizationId, secret.id, {
      name: "Jev via OpenRouter",
      provider: "jev",
      baseUrl: OPENROUTER_ENDPOINT,
    });
    const { value } = await VirtualApiKeyModel.create({
      name: "jev-openrouter-vk",
      providerApiKeys: [{ provider: "jev", providerApiKeyId: key.id }],
      ...accessGrants("org"),
    });

    const response = await send({
      token: value,
      body: { ...DECISIONS_REQUEST, model: "typesafe/jev-1.13" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(upstream.requests).toEqual([
      {
        authorization: "Bearer sk-or-v1-test",
        body: { ...DECISIONS_REQUEST, model: "typesafe/jev-1.13" },
      },
    ]);
  });

  test("relays the upstream status when Jev rejects the request", async () => {
    server.use(
      http.post(TYPESAFE_ENDPOINT, () =>
        HttpResponse.json(
          { error: { code: 402, message: "Insufficient credits" } },
          { status: 402 },
        ),
      ),
    );

    const response = await send({ token: "sk-typesafe" });

    expect(response.statusCode).toBe(402);
    expect(response.body).toContain("Insufficient credits");
  });

  function send(params: { token: string; body?: object }) {
    return app.inject({
      method: "POST",
      url: `/v1/jev/${agent.id}/decisions`,
      // Non-loopback: the credential, not a localhost bypass, authorizes it.
      remoteAddress: "203.0.113.5",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${params.token}`,
      },
      payload: params.body ?? DECISIONS_REQUEST,
    });
  }

  function captureUpstream(url: string, reply: object) {
    const requests: { authorization: string | null; body: unknown }[] = [];
    server.use(
      http.post(url, async ({ request }) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return HttpResponse.json(reply);
      }),
    );
    return { requests };
  }
});
