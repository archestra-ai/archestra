import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import config from "@/config";
import { ResponsesStreamIncompleteError } from "./openai-responses";
import {
  fetchNativeGrokMetadata,
  nativeGrokSessionAdapter,
  resolveNativeGrokDefault,
} from "./xai-native-session";

const NATIVE = "synthetic-native-access";
const headers = {
  authorization: `Bearer ${NATIVE}`,
  "x-archestra-grok-credential-mode": "native-session",
  "x-xai-token-auth": "xai-grok-cli",
  "x-userid": "synthetic-user",
  "x-grok-session-id": "synthetic-session",
  cookie: "synthetic=private",
  "x-env-fallback": "must-not-forward",
};

function responsesAdapter(
  inbound: Record<string, string | undefined> = headers,
) {
  const adapter = nativeGrokSessionAdapter(inbound, "responses");
  if (!adapter) throw new Error("Expected a native Responses adapter");
  return adapter;
}

describe("native Grok Responses factory", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  const previous = config.llm.xai.subscription.baseUrl;
  afterEach(async () => {
    config.llm.xai.subscription.baseUrl = previous;
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function stubNative(
    handler: (request: {
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }) => { status: number; body: string; stream?: boolean },
  ) {
    const captured: {
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const record = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      };
      captured.push(record);
      const result = handler(record);
      response.writeHead(result.status, {
        "content-type": result.stream
          ? "text/event-stream"
          : "application/json",
      });
      response.end(result.body);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    config.llm.xai.subscription.baseUrl = `http://127.0.0.1:${address.port}/native/v1`;
    return captured;
  }

  test.each([
    "models",
    "settings",
    "login-config",
    "user",
  ] as const)("metadata selects the fixed native %s endpoint", async (name) => {
    const captured = await stubNative(() => ({
      status: 200,
      body: '{"data":[]}',
    }));
    await fetchNativeGrokMetadata({
      name,
      headers,
      signal: AbortSignal.timeout(1000),
    });
    expect(captured.map((request) => request.url)).toEqual([
      `/native/v1/${name}`,
    ]);
  });

  test.each([
    "../user",
    "https://other.example",
    "models?extra=1",
    "__proto__",
  ])("metadata refuses an unsupported runtime name before fetching (%s)", async (name) => {
    const captured = await stubNative(() => ({
      status: 200,
      body: "{}",
    }));
    await expect(
      fetchNativeGrokMetadata({
        name: name as "models",
        headers,
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(captured).toEqual([]);
  });

  test("explicit native mode supplies the upstream auth header and keeps only allowlisted headers", async () => {
    const captured = await stubNative(() => ({
      status: 200,
      body: JSON.stringify({
        id: "resp_native",
        object: "response",
        created_at: 1,
        model: "grok-4.7",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_flat",
            name: "lookup",
            arguments: '{"q":"synthetic"}',
            status: "completed",
          },
        ],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      }),
    }));
    const adapter = responsesAdapter({
      ...headers,
      "x-xai-token-auth": undefined,
    });
    const client = adapter.createClient(NATIVE, { source: "api" });
    const response = await adapter.execute(client, {
      model: "grok-4.7",
      input: "Synthetic.",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            additionalProperties: false,
          },
          strict: false,
        },
      ],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("/native/v1/responses");
    expect(captured[0]?.headers.authorization).toBe(`Bearer ${NATIVE}`);
    expect(captured[0]?.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(captured[0]?.headers["x-userid"]).toBe("synthetic-user");
    expect(captured[0]?.headers["x-grok-session-id"]).toBe("synthetic-session");
    expect(captured[0]?.headers.cookie).toBeUndefined();
    expect(captured[0]?.headers["x-env-fallback"]).toBeUndefined();
    expect(captured[0]?.url).not.toContain("api.openai.com");
    expect(captured[0]?.url).not.toContain("api.x.ai");
    expect(JSON.parse(captured[0]?.body ?? "{}")).toMatchObject({
      model: "grok-4.7",
      tools: [{ type: "function", name: "lookup" }],
    });
    expect(adapter.createResponseAdapter(response).getToolCalls()).toEqual([
      {
        id: "call_flat",
        name: "lookup",
        kind: "function",
        arguments: { q: "synthetic" },
      },
    ]);
    expect(adapter.isSubscriptionCredential?.(NATIVE)).toBe(true);
  });

  test("does not accept subscription billing when native inference fails", async () => {
    await stubNative(() => ({
      status: 401,
      body: JSON.stringify({
        error: {
          message: "Synthetic rejection.",
          type: "authentication_error",
        },
      }),
    }));
    const adapter = responsesAdapter();
    const client = adapter.createClient(NATIVE, { source: "api" });
    await expect(
      adapter.execute(client, {
        model: "grok-4.7",
        input: "Synthetic.",
      }),
    ).rejects.toThrow();
    expect(adapter.isSubscriptionCredential?.(NATIVE)).toBe(false);
  });

  test("fails an incomplete Responses stream and does not bill it as subscription", async () => {
    await stubNative(() => ({
      status: 200,
      stream: true,
      body: 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    }));
    const adapter = responsesAdapter();
    const client = adapter.createClient(NATIVE, { source: "api" });
    let accepted = 0;
    const stream = await adapter.executeStream(
      client,
      {
        model: "grok-4.7",
        input: "Synthetic.",
      },
      () => {
        accepted++;
      },
    );
    expect(accepted).toBe(1);
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          /* drain */
        }
      })(),
    ).rejects.toBeInstanceOf(ResponsesStreamIncompleteError);
    expect(adapter.isSubscriptionCredential?.(NATIVE)).toBe(false);
  });

  test.each([
    "xai-console-key",
    "sk-synthetic",
  ])("rejects API-key prefix %s before any upstream request", (token) => {
    expect(() =>
      nativeGrokSessionAdapter(
        { ...headers, authorization: `Bearer ${token}` },
        "responses",
      ),
    ).toThrow(/API keys cannot authenticate/);
  });

  test("rejects a provider key and a non-native upstream", async () => {
    const adapter = responsesAdapter();
    expect(() =>
      adapter.createClient(NATIVE, {
        source: "api",
        llmProviderApiKeyId: "synthetic-key",
      }),
    ).toThrow(/provider key/);
    expect(() =>
      adapter.createClient(NATIVE, {
        source: "api",
        baseUrl: "https://api.x.ai/v1",
      }),
    ).toThrow(/custom upstream/);
  });

  test("chat remains the default and provider identity stays xAI", () => {
    const chat = nativeGrokSessionAdapter(headers);
    const responses = responsesAdapter();
    expect(chat?.interactionType).toBe("xai:chatCompletions");
    expect(responses.interactionType).toBe("xai:responses");
    expect(responses.provider).toBe("xai");
    expect(responses.getBaseUrl()).toBe(config.llm.xai.subscription.baseUrl);
  });

  test("selects the current settings default from the authenticated Responses catalog without an alias guess", async () => {
    let selected = "grok-synthetic-default";
    const captured = await stubNative(({ url }) => ({
      status: 200,
      body: JSON.stringify(
        url?.endsWith("/settings")
          ? { default_model: selected }
          : {
              data: [
                { id: "grok-build", model: "wrong-alias" },
                { id: selected, api_backend: "responses" },
              ],
            },
      ),
    }));
    const automatic = () =>
      resolveNativeGrokDefault({
        model: "archestra-native-default",
        headers,
        apiBackend: "responses",
      });
    expect(await automatic()).toBe(selected);
    selected = "grok-synthetic-new-default";
    expect(await automatic()).toBe(selected);
    expect(captured.map(({ url }) => url)).toEqual([
      "/native/v1/settings",
      "/native/v1/models",
      "/native/v1/settings",
      "/native/v1/models",
    ]);
    for (const request of captured) {
      expect(request.method).toBe("GET");
      expect(request.headers.authorization).toBe(`Bearer ${NATIVE}`);
      expect(request.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
      expect(request.headers["accept-encoding"]).toBe("identity");
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers["x-env-fallback"]).toBeUndefined();
    }
  });

  test.each([
    "missing-setting",
    "invalid-setting",
    "missing-model",
    "hidden-model",
    "foreign-base",
    "oversized-settings",
    "oversized-catalog",
  ])("rejects %s without attempting inference", async (failure) => {
    const captured = await stubNative(({ url }) => ({
      status: 200,
      body:
        (failure === "oversized-settings" && url?.endsWith("/settings")) ||
        (failure === "oversized-catalog" && url?.endsWith("/models"))
          ? " ".repeat(2 * 1024 * 1024 + 1)
          : JSON.stringify(
              url?.endsWith("/settings")
                ? {
                    default_model:
                      failure === "missing-setting"
                        ? undefined
                        : failure === "invalid-setting"
                          ? "unsafe\nmodel"
                          : "grok-synthetic-default",
                  }
                : {
                    data:
                      failure === "missing-model"
                        ? [{ id: "grok-build", model: "wrong-alias" }]
                        : [
                            {
                              id: "grok-synthetic-default",
                              api_backend: "responses",
                              hidden: failure === "hidden-model",
                              ...(failure === "foreign-base"
                                ? { base_url: "https://api.x.ai/v1" }
                                : {}),
                            },
                          ],
                  },
            ),
    }));
    await expect(
      resolveNativeGrokDefault({
        model: "archestra-native-default",
        headers,
        apiBackend: "responses",
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(captured.every(({ method }) => method === "GET")).toBe(true);
  });

  test.each([
    401, 403,
  ])("preserves metadata authentication failure %s without exposing its body", async (status) => {
    await stubNative(() => ({ status, body: "private upstream detail" }));
    const result = resolveNativeGrokDefault({
      model: "archestra-native-default",
      headers,
      apiBackend: "responses",
    });
    await expect(result).rejects.toMatchObject({ statusCode: status });
    await expect(result).rejects.not.toThrow("private upstream detail");
  });

  test("preserves explicit pins without metadata calls", async () => {
    const captured = await stubNative(() => ({ status: 503, body: "{}" }));
    expect(
      await resolveNativeGrokDefault({
        model: "grok-synthetic-pinned",
        headers,
        apiBackend: "responses",
      }),
    ).toBe("grok-synthetic-pinned");
    expect(captured).toEqual([]);
  });
});
