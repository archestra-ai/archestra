import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, vi } from "vitest";
import {
  guardrailCallHeader,
  internalCallHeader,
} from "@/clients/internal-call";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { beforeEach, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import anthropicProxyRoutes from "./anthropic";
import openaiProxyRoutes from "./openai";

describe("guardrail call disconnect", () => {
  let upstream: Server;
  let app: ReturnType<typeof createFastifyInstance>;
  let agentId: string;
  let platformCredential: string;
  let received: number;
  let abandoned: number;

  beforeEach(async ({ makeAgent, makeMember, makeUser }) => {
    received = 0;
    abandoned = 0;
    // Holds every call open, as a slow model would.
    upstream = createServer((request, response) => {
      request.resume();
      received++;
      response.on("close", () => {
        if (!response.writableEnded) abandoned++;
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    config.llm.anthropic.baseUrl = upstreamUrl;
    config.llm.anthropic.vertexAi.enabled = false;
    config.llm.openai.baseUrl = `${upstreamUrl}/v1`;
    const agent = await makeAgent({ name: "Guardrail disconnect test" });
    agentId = agent.id;
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    platformCredential = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    app = createFastifyInstance();
    await app.register(anthropicProxyRoutes);
    await app.register(openaiProxyRoutes);
  });

  afterEach(async () => {
    await app?.close();
    upstream?.closeAllConnections();
    if (upstream)
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const calls = {
    anthropic: {
      path: "v1/messages",
      headers: { "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
      body: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        messages: [{ role: "user", content: "Annotate" }],
      },
    },
    openai: {
      path: "chat/completions",
      headers: { authorization: "Bearer test-key" },
      body: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Annotate" }],
      },
    },
  };

  for (const [provider, call] of Object.entries(calls)) {
    test(`a disconnected guardrail call aborts its ${provider} upstream request`, async () => {
      // A real socket: app.inject cannot disconnect mid-request.
      const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
      const client = new AbortController();
      const pending = fetch(
        `${baseUrl}/v1/${provider}/${agentId}/${call.path}`,
        {
          method: "POST",
          headers: {
            ...internalCallHeader(),
            ...guardrailCallHeader(),
            ...call.headers,
            "x-archestra-virtual-key": platformCredential,
            "x-archestra-source": "guardrail:annotator",
            "content-type": "application/json",
          },
          body: JSON.stringify(call.body),
          signal: client.signal,
        },
      ).catch((error: unknown) => error);
      await vi.waitFor(() => expect(received).toBe(1), { timeout: 5000 });

      client.abort();
      await pending;

      await vi.waitFor(() => expect(abandoned).toBe(1), { timeout: 5000 });
      expect(received).toBe(1);
    });
  }
});
