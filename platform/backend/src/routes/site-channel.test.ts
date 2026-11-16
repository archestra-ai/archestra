import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { LlmProviderApiKeyModel, SiteModel } from "@/models";
import {
  RelayedUpstreamError,
  remoteSiteTransport,
} from "@/routes/proxy/remote-site-transport";
import { SITE_CHANNEL_PREFIX } from "@/routes/route-paths";
import { signSiteToken } from "@/sites/channel-auth";
import { SiteUnavailableError } from "@/sites/channel-client";
import { clearSitesCache } from "@/sites/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import siteChannelRoutes from "./site-channel";

const UPSTREAM = "https://openai.site-relay.test/v1";

/**
 * Two sites in one process: "azure-us" receives the client's request and
 * relays the upstream call to "gcp-us", whose channel route runs here. The
 * site name in config is switched while the serving site handles the call.
 */
describe("site channel LLM relay", () => {
  let upstreamAuth: string | null = null;
  useMswServer(
    http.post(`${UPSTREAM}/chat/completions`, async ({ request }) => {
      upstreamAuth = request.headers.get("authorization");
      const body = (await request.json()) as {
        model: string;
        stream?: boolean;
      };
      if (body.model === "rate-limited")
        return HttpResponse.json(
          { error: { message: "slow down", type: "rate_limit" } },
          { status: 429, headers: { "retry-after": "7" } },
        );
      if (body.stream) {
        const encoder = new TextEncoder();
        const chunk = (content: string) =>
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`;
        return new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(chunk("Hel")));
              controller.enqueue(encoder.encode(chunk("lo")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return HttpResponse.json({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    }),
  );

  let app: ReturnType<typeof createFastifyInstance>;
  let keyId: string;

  beforeEach(async ({ makeOrganization, makeSecret }) => {
    upstreamAuth = null;
    clearSitesCache();
    app = createFastifyInstance();
    await app.register(siteChannelRoutes);
    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-gcp-only" } });
    const key = await LlmProviderApiKeyModel.create(
      {
        organizationId: organization.id,
        secretId: secret.id,
        name: "GCP OpenAI",
        provider: "openai",
        scope: "org",
        userId: null,
        baseUrl: UPSTREAM,
        siteName: "gcp-us",
      },
      { publishToOrganization: true },
    );
    keyId = key.id;
    await SiteModel.upsert({
      name: "gcp-us",
      role: "secondary",
      internalUrl: "http://gcp-us.site-relay.test",
      version: "test",
      capabilities: { keylessProviders: [] },
    });
    config.site.name = "azure-us";
    // The receiving site's fetch lands on the serving site's route; the
    // provider call goes on to the mocked upstream.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host !== "gcp-us.site-relay.test") return realFetch(input, init);
      config.site.name = "gcp-us";
      try {
        const response = await app.inject({
          method: "POST",
          url: url.pathname,
          headers: init?.headers as Record<string, string>,
          payload: init?.body as string,
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as Record<string, string>,
        });
      } finally {
        config.site.name = "azure-us";
      }
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    config.site.name = "default";
    await app.close();
  });

  const transport = () =>
    remoteSiteTransport({
      siteName: "gcp-us",
      keyName: "GCP OpenAI",
      call: {
        providerApiKeyId: keyId,
        provider: "openai",
        inbound: "openai-chat",
        modelId: "gpt-test",
        mode: "member",
        headers: {},
        source: "api",
      },
    });

  test("the serving site calls the provider with its own key and returns the response", async () => {
    const response = await transport().execute({
      model: "pool-name",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response).toMatchObject({
      model: "gpt-test",
      choices: [{ message: { content: "Hello" } }],
    });
    expect(upstreamAuth).toBe("Bearer sk-gcp-only");
  });

  test("streams the provider's chunks back and fires onAccepted once accepted", async () => {
    const onAccepted = vi.fn();
    const stream = await transport().executeStream(
      {
        model: "pool-name",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
      onAccepted,
    );
    expect(onAccepted).toHaveBeenCalledOnce();
    const contents: string[] = [];
    for await (const chunk of stream as AsyncIterable<{
      choices: { delta: { content?: string } }[];
    }>)
      contents.push(chunk.choices[0]?.delta.content ?? "");
    expect(contents.join("")).toBe("Hello");
  });

  test("a provider error keeps its status and retry-after so a pool can fail over", async () => {
    const failing = remoteSiteTransport({
      siteName: "gcp-us",
      keyName: "GCP OpenAI",
      call: {
        providerApiKeyId: keyId,
        provider: "openai",
        inbound: "openai-chat",
        modelId: "rate-limited",
        mode: "member",
        headers: {},
        source: "api",
      },
    });
    const error = await failing
      .execute({ model: "x", messages: [{ role: "user", content: "hi" }] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayedUpstreamError);
    expect(error).toMatchObject({
      status: 429,
      headers: { "retry-after": "7" },
    });
  });

  test("a stale site is refused before any call, naming the key and the site", async () => {
    await SiteModel.upsert({
      name: "gcp-us",
      role: "secondary",
      internalUrl: "http://gcp-us.site-relay.test",
      version: "test",
      capabilities: { keylessProviders: [] },
    });
    await SiteModel.setDraining("gcp-us", true);
    clearSitesCache();
    const error = await transport()
      .execute({ model: "x", messages: [] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SiteUnavailableError);
    expect((error as Error).message).toBe(
      'Provider key "GCP OpenAI" is served by site "gcp-us", which is draining',
    );
    expect(upstreamAuth).toBeNull();
  });

  test("refuses a request without a valid site token", async () => {
    config.site.name = "gcp-us";
    const body = JSON.stringify({ providerApiKeyId: keyId });
    const unsigned = await app.inject({
      method: "POST",
      url: `${SITE_CHANNEL_PREFIX}/llm/call`,
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);

    const forAnotherSite = await app.inject({
      method: "POST",
      url: `${SITE_CHANNEL_PREFIX}/llm/call`,
      headers: {
        "content-type": "application/json",
        "x-archestra-site-token": signSiteToken({
          to: "gcp-eu",
          body,
          from: "azure-us",
        }),
      },
      payload: body,
    });
    expect(forAnotherSite.statusCode).toBe(401);
    expect(upstreamAuth).toBeNull();
  });

  test("the serving site refuses a key it does not serve", async () => {
    await LlmProviderApiKeyModel.update(keyId, { siteName: "gcp-eu" });
    const error = await transport()
      .execute({ model: "x", messages: [] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 502 });
    expect((error as Error).message).toContain(
      'Provider key "GCP OpenAI" is served by site "gcp-eu", not "gcp-us"',
    );
    expect(upstreamAuth).toBeNull();
  });
});
