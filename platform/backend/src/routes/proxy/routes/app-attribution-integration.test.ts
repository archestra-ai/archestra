/**
 * Integration tests for per-app attribution of app-runtime LLM spend.
 *
 * `archestra.llm.complete()` runs as the organization's shared App Runtime
 * agent, so without the app-id header every app's runtime cost collapses into
 * one row and "what does this app cost to run" has no answer. These tests drive
 * the real proxy — only the upstream LLM client is faked — and assert what
 * lands on the persisted interaction, including the cases where a header must
 * be refused.
 */

import { APP_ID_HEADER } from "@archestra/shared";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type OpenAI from "openai";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { openaiAdapterFactory } from "../adapters/openai";
import openAiProxyRoutes from "./openai";

const OPENAI_ENDPOINT = (agentId: string) =>
  `/v1/openai/${agentId}/chat/completions`;

const OPENAI_HEADERS = {
  Authorization: "Bearer test-key",
  "Content-Type": "application/json",
};

const PAYLOAD = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
};

function fakeOpenAiClient() {
  return {
    chat: {
      completions: {
        create: async (
          request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
        ) => ({
          id: "chatcmpl-app-attribution",
          object: "chat.completion",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant" as const,
                content: "Mocked response",
                refusal: null,
              },
              finish_reason: "stop" as const,
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        }),
      },
    },
  };
}

/** The app id recorded on the single interaction the request produced. */
async function recordedAppId(agentId: string): Promise<string | null> {
  const [interaction] = await db
    .select({ appId: schema.interactionsTable.appId })
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.profileId, agentId));
  return interaction?.appId ?? null;
}

describe("app-runtime interaction attribution (integration)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  async function setupRoute() {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => fakeOpenAiClient() as never,
    );
    await app.register(openAiProxyRoutes);
  }

  test("records the calling app on the interaction", async ({
    makeOrganization,
    makeAgent,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "App Runtime LLM Agent",
    });
    const ownedApp = await makeApp({ organizationId: org.id });

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: { ...OPENAI_HEADERS, [APP_ID_HEADER]: ownedApp.id },
      payload: PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    expect(await recordedAppId(agent.id)).toBe(ownedApp.id);
  });

  test("ignores the header from a non-loopback peer", async ({
    makeOrganization,
    makeAgent,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const ownedApp = await makeApp({ organizationId: org.id });

    await setupRoute();

    // Only in-process callers may attribute spend to an app; an external client
    // must not be able to bill its usage to somebody's app.
    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      remoteAddress: "203.0.113.7",
      headers: { ...OPENAI_HEADERS, [APP_ID_HEADER]: ownedApp.id },
      payload: PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    expect(await recordedAppId(agent.id)).toBeNull();
  });

  test("ignores an app belonging to another organization", async ({
    makeOrganization,
    makeAgent,
    makeApp,
  }) => {
    const [org, otherOrg] = await Promise.all([
      makeOrganization(),
      makeOrganization(),
    ]);
    const agent = await makeAgent({ organizationId: org.id });
    const foreignApp = await makeApp({ organizationId: otherOrg.id });

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: { ...OPENAI_HEADERS, [APP_ID_HEADER]: foreignApp.id },
      payload: PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    expect(await recordedAppId(agent.id)).toBeNull();
  });

  test("a malformed app header is ignored, not fatal", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });

    await setupRoute();

    // A non-uuid value must not reach the uuid-typed lookup and 500 the call.
    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: { ...OPENAI_HEADERS, [APP_ID_HEADER]: "not-a-uuid" },
      payload: PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    expect(await recordedAppId(agent.id)).toBeNull();
  });

  test("leaves the app id null on an ordinary request", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS,
      payload: PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    expect(await recordedAppId(agent.id)).toBeNull();
  });
});
