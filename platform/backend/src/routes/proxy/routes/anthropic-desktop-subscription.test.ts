import { CLAUDE_DESKTOP_CLIENT_ID } from "@archestra/shared/interactions/client";
import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { afterEach, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { useMswServer } from "@/test/msw";
import anthropicProxyRoutes from "./anthropic";

// biome-ignore lint/correctness/useHookAtTopLevel: Registers HTTP-boundary lifecycle hooks.
const upstream = useMswServer();
setupTestCacheManager();

const preamble = "You are Claude Code, Anthropic's official CLI for Claude.";
const model = "claude-haiku-4-5-20251001";
let app: FastifyInstanceWithZod;
let url: string;
let passthrough: string;
let requests: Record<string, unknown>[];
let providerLimited: boolean;
let providerRequiresPreamble: boolean;

beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
  config.llm.anthropic.vertexAi.enabled = false;
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id);
  const agent = await makeAgent({ organizationId: organization.id });
  passthrough = await makePassthroughCredential({
    organizationId: organization.id,
    ownerId: user.id,
  });
  app = createFastifyInstance();
  await app.register(anthropicProxyRoutes);
  url = `/v1/anthropic/${agent.id}/v1/messages`;
  requests = [];
  providerLimited = false;
  providerRequiresPreamble = true;
  upstream.use(
    http.post("https://api.anthropic.com/v1/messages", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const system = JSON.stringify(body.system);
      if (
        providerLimited ||
        (providerRequiresPreamble && !system?.includes(preamble))
      ) {
        return HttpResponse.json(
          {
            type: "error",
            error: { type: "rate_limit_error", message: "Error" },
          },
          { status: 429 },
        );
      }
      return HttpResponse.json({
        id: "msg_connection_test",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    }),
  );
});

afterEach(async () => app.close());

function send(
  options: { system?: unknown; credential?: string; clientId?: string } = {},
) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${options.credential ?? "sk-ant-oat-test-subscription"}`,
      "x-archestra-virtual-key": passthrough,
      "x-archestra-agent-id": options.clientId ?? CLAUDE_DESKTOP_CLIENT_ID,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    },
    payload: {
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
      ...(options.system === undefined ? {} : { system: options.system }),
    },
  });
}

test("Desktop's native subscription health probe reaches the provider with its client preamble", async () => {
  url = url.replace("/v1/", "/v1/connection-setup/cps1_e30.c2ln/");
  const response = await send();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().content).toEqual([{ type: "text", text: "OK" }]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    max_tokens: 1,
    messages: [{ role: "user", content: "." }],
    system: [{ type: "text", text: preamble }],
  });
});

test.each([
  "Generate a short title.",
  [
    {
      type: "text",
      text: "Generate a short title.",
      cache_control: { type: "ephemeral" },
    },
  ],
])("preserves Desktop's title instructions and cache directives (%j)", async (system) => {
  const response = await send({ system });
  expect(response.statusCode, response.body).toBe(200);
  expect(requests[0].system).toEqual([
    { type: "text", text: preamble },
    ...(typeof system === "string" ? [{ type: "text", text: system }] : system),
  ]);
});

test("keeps the existing CLI-backed inference preamble without duplicating it", async () => {
  const system = [
    { type: "text", text: preamble, cache_control: { type: "ephemeral" } },
    { type: "text", text: "Help with the task." },
  ];
  expect((await send({ system })).statusCode).toBe(200);
  expect(requests[0].system).toEqual(system);
});

test.each([
  { credential: "sk-ant-api-test-metered" },
  { clientId: "custom-client" },
])("leaves metered keys and other clients' prompts unchanged (%j)", async (options) => {
  const system = "Keep these instructions.";
  expect((await send({ ...options, system })).statusCode).toBe(429);
  expect(requests[0].system).toBe(system);
});

test("relays a genuine provider rate limit after preparing a Desktop subscription request", async () => {
  providerLimited = true;
  const response = await send();
  expect(response.statusCode).toBe(429);
  expect(response.json()).toMatchObject({
    type: "error",
    error: { type: "rate_limit_error", message: "Error" },
  });
  expect(requests).toHaveLength(1);
});

test("relays ordinary metered Anthropic requests when cache usage fields are absent", async () => {
  providerRequiresPreamble = false;
  const system = "Keep these instructions.";
  const response = await send({
    credential: "sk-ant-api-test-metered",
    clientId: "custom-client",
    system,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(requests).toHaveLength(1);
  expect(requests[0].system).toBe(system);
  expect(response.json().content).toEqual([{ type: "text", text: "OK" }]);
  expect(response.json().usage).toMatchObject({
    input_tokens: 10,
    output_tokens: 1,
  });
});
