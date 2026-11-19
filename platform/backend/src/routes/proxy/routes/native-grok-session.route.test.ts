import { createServer } from "node:http";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  InteractionModel,
  OrganizationModel,
  VirtualApiKeyModel,
} from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { asRecord } from "@/utils/as-record";
import xaiProxyRoutes from "./xai";

setupTestCacheManager();

test("native markers cannot escape through any catchall method, while metered metadata and inference keep their credentials", async ({
  makeAgent,
  makeUser,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const captured: {
    path: string;
    authorization: string | undefined;
    cookie: boolean;
    native: boolean;
    platform: boolean;
  }[] = [];
  let nativeCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/native/")) {
      nativeCalls++;
      response.writeHead(401).end();
      return;
    }
    captured.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      cookie: Boolean(request.headers.cookie),
      native: Boolean(
        request.headers["x-authenticateresponse"] ||
          request.headers["x-grok-session-id"] ||
          request.headers["x-userid"] ||
          request.headers["x-xai-token-auth"],
      ),
      platform: Boolean(request.headers["x-archestra-virtual-key"]),
    });
    let text = "";
    for await (const chunk of request) text += chunk;
    response.setHeader("Content-Type", "application/json");
    response.end(
      text
        ? JSON.stringify({
            id: "synthetic",
            object: "chat.completion",
            created: 1,
            model: "synthetic-metered",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Synthetic." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        : "{}",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind");
  const oldApi = config.llm.xai.baseUrl;
  const oldNative = config.llm.xai.subscription.baseUrl;
  config.llm.xai.baseUrl = `http://127.0.0.1:${address.port}/api-key`;
  config.llm.xai.subscription.baseUrl = `http://127.0.0.1:${address.port}/native`;
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  await OrganizationModel.patch(agent.organizationId, {
    allowUnauthenticatedLlmProxyRequests: true,
  });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId);
  const platform = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: user.id,
  });
  const secret = await makeSecret({
    secret: { apiKey: "xai-synthetic-mapped" },
  });
  const provider = await makeLlmProviderApiKey(
    agent.organizationId,
    secret.id,
    { provider: "xai" },
  );
  const virtual = await VirtualApiKeyModel.create({
    organizationId: agent.organizationId,
    name: "Synthetic native boundary",
    providerApiKeys: [{ provider: "xai", providerApiKeyId: provider.id }],
  });
  const app = createFastifyInstance();
  await app.register(xaiProxyRoutes);
  try {
    const results: { method: string; suffix: string; status: number }[] = [];
    for (const credentials of [
      {
        authorization: "Bearer synthetic-native-session",
        "x-archestra-virtual-key": platform,
      },
      {
        authorization: `Bearer ${virtual.value}`,
        "x-archestra-virtual-key": "",
      },
      {
        authorization: "Bearer synthetic-native-session",
        "x-archestra-virtual-key": "",
      },
    ]) {
      for (const marker of [
        { "x-xai-token-auth": "xai-grok-cli" },
        { "x-archestra-grok-credential-mode": "native-session" },
      ]) {
        for (const prefix of ["/v1/xai", `/v1/xai/${agent.id}`]) {
          for (const suffix of [
            "/chat/completions",
            "/responses",
            "/unknown",
            "/metadata",
          ]) {
            for (const method of ["GET", "POST", "DELETE"] as const) {
              if (
                method === "POST" &&
                ["/chat/completions", "/responses"].includes(suffix)
              )
                continue;
              const result = await app.inject({
                method,
                url: prefix + suffix,
                headers: {
                  ...credentials,
                  ...marker,
                  cookie: "synthetic=private",
                  "x-authenticateresponse": "synthetic-private",
                  "x-userid": "synthetic-user",
                },
                ...(method === "POST" ? { payload: {} } : {}),
              });
              results.push({ method, suffix, status: result.statusCode });
            }
          }
        }
      }
    }
    expect(captured).toEqual([]);
    expect(results.filter((result) => result.status !== 400)).toEqual([]);
    for (const prefix of ["/v1/xai", `/v1/xai/${agent.id}`]) {
      for (const suffix of ["/chat/completions", "/responses"]) {
        for (const marker of [
          { "x-xai-token-auth": "xai-grok-cli" },
          { "x-archestra-grok-credential-mode": "native-session" },
        ]) {
          const result = await app.inject({
            method: "POST",
            url: prefix + suffix,
            headers: {
              authorization: "Bearer xai-consolekey-synthetic",
              "x-archestra-virtual-key": platform,
              ...marker,
            },
            payload:
              suffix === "/responses"
                ? { model: "synthetic", input: "Synthetic." }
                : {
                    model: "synthetic",
                    messages: [{ role: "user", content: "Synthetic." }],
                  },
          });
          expect(result.statusCode, result.body).toBe(401);
        }
      }
    }
    expect(nativeCalls).toBe(0);
    expect(captured).toEqual([]);
    const metadata = await app.inject({
      method: "GET",
      url: "/v1/xai/metadata",
      headers: {
        authorization: "Bearer xai-synthetic-metered",
        "x-archestra-virtual-key": platform,
        cookie: "synthetic=private",
        "x-authenticateresponse": "synthetic-private",
        "x-userid": "synthetic-user",
        "x-grok-session-id": "synthetic-session",
      },
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(captured).toEqual([
      {
        path: "/api-key/metadata",
        authorization: "Bearer xai-synthetic-metered",
        cookie: false,
        native: false,
        platform: false,
      },
    ]);
    const inference = await app.inject({
      method: "POST",
      url: "/v1/xai/chat/completions",
      headers: {
        authorization: "Bearer xai-synthetic-metered",
        "x-archestra-virtual-key": platform,
      },
      payload: {
        model: "synthetic-metered",
        messages: [{ role: "user", content: "Synthetic." }],
      },
    });
    expect(inference.statusCode, inference.body).toBe(200);
    expect(captured.at(-1)?.authorization).toBe("Bearer xai-synthetic-metered");
    expect(
      (await InteractionModel.getAllInteractionsForProfile(agent.id)).map(
        (row) => row.billingMode,
      ),
    ).toEqual(["metered"]);
    const bridged = await app.inject({
      method: "POST",
      url: "/v1/xai/responses",
      headers: {
        authorization: "Bearer xai-synthetic-metered",
        "x-archestra-virtual-key": platform,
      },
      payload: {
        model: "synthetic-metered",
        input: "Synthetic bridge.",
        tools: [
          { type: "function", name: "lookup", parameters: { type: "object" } },
        ],
      },
    });
    expect(bridged.statusCode, bridged.body).toBe(200);
    expect(captured.at(-1)?.path).toBe("/api-key/chat/completions");
    expect(captured.at(-1)?.authorization).toBe("Bearer xai-synthetic-metered");
    expect(
      (await InteractionModel.getAllInteractionsForProfile(agent.id)).map(
        (row) => row.billingMode,
      ),
    ).toEqual(["metered", "metered"]);
  } finally {
    config.llm.xai.baseUrl = oldApi;
    config.llm.xai.subscription.baseUrl = oldNative;
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("native billing requires accepted native inference, never client markers or failed native authentication", async ({
  makeAgent,
  makeUser,
  makeMember,
}) => {
  const nativeHits: { authorization: string; path: string }[] = [];
  let truncateResponses = false;
  const completedResponse = (model: string) => ({
    id: "resp_synthetic",
    object: "response",
    created_at: 1,
    model,
    status: "completed",
    output: [
      {
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Synthetic.", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
  const server = createServer(async (request, response) => {
    nativeHits.push({
      authorization: request.headers.authorization ?? "",
      path: request.url ?? "",
    });
    if (request.headers.authorization !== "Bearer synthetic-native-accepted") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Synthetic unauthenticated.",
            type: "authentication_error",
          },
        }),
      );
      return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const responses = request.url === "/responses";
    if (body.stream) {
      response.setHeader("Content-Type", "text/event-stream");
      if (responses && truncateResponses) {
        const item = {
          type: "function_call",
          id: "fc_synthetic_unfinished",
          call_id: "call_synthetic_unfinished",
          name: "lookup",
          arguments: '{"q":"must-not-run"}',
        };
        response.end(
          [
            {
              type: "response.output_item.added",
              sequence_number: 1,
              output_index: 0,
              item,
            },
            {
              type: "response.function_call_arguments.done",
              sequence_number: 2,
              output_index: 0,
              item_id: item.id,
              arguments: item.arguments,
            },
          ]
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
        );
        return;
      }
      response.end(
        responses
          ? `data: ${JSON.stringify({
              type: "response.completed",
              sequence_number: 1,
              response: completedResponse(body.model),
            })}\n\n`
          : "data: " +
              JSON.stringify({
                id: "synthetic",
                object: "chat.completion.chunk",
                created: 1,
                model: body.model,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "Synthetic." },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }) +
              "\n\ndata: [DONE]\n\n",
      );
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        responses
          ? completedResponse(body.model)
          : {
              id: "synthetic",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Synthetic." },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind");
  const oldNative = config.llm.xai.subscription.baseUrl;
  config.llm.xai.subscription.baseUrl = `http://127.0.0.1:${address.port}`;
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId);
  const platform = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: user.id,
  });
  const app = createFastifyInstance();
  await app.register(xaiProxyRoutes);
  try {
    const forgedSession = [
      { alg: "none" },
      { sub: "synthetic", subscription: true },
      "synthetic",
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    for (const endpoint of ["chat/completions", "responses"] as const) {
      for (const stream of [false, true]) {
        for (const token of [
          "xai-consolekey-synthetic",
          forgedSession,
          "synthetic-native-rejected",
          "synthetic-native-accepted",
          "synthetic-native-rejected",
        ]) {
          const before = (
            await InteractionModel.getAllInteractionsForProfile(agent.id)
          ).length;
          const hitsBefore = nativeHits.length;
          const result = await app.inject({
            method: "POST",
            url: `/v1/xai/${endpoint}`,
            headers: {
              authorization: `Bearer ${token}`,
              "x-archestra-virtual-key": platform,
              "x-xai-token-auth": "xai-grok-cli",
            },
            payload:
              endpoint === "responses"
                ? {
                    model: "explicit-synthetic",
                    stream,
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
                  }
                : {
                    model: "explicit-synthetic",
                    stream,
                    messages: [{ role: "user", content: "Synthetic." }],
                  },
          });
          expect(result.statusCode, result.body).toBe(
            token === "synthetic-native-accepted" ? 200 : 401,
          );
          const rows = (
            await InteractionModel.getAllInteractionsForProfile(agent.id)
          ).slice(before);
          if (token === "xai-consolekey-synthetic")
            expect(nativeHits.length).toBe(hitsBefore);
          if (token === "synthetic-native-accepted") {
            expect(nativeHits.at(-1)).toEqual({
              authorization: "Bearer synthetic-native-accepted",
              path:
                endpoint === "responses" ? "/responses" : "/chat/completions",
            });
            expect(rows).toHaveLength(1);
            expect(
              rows[0].billingMode,
              `${endpoint} stream=${stream} type=${rows[0].type} body=${result.body}`,
            ).toBe("subscription");
            expect(rows[0].type).toBe(
              endpoint === "responses"
                ? "xai:responses"
                : "xai:chatCompletions",
            );
          } else {
            expect(rows.every((row) => row.billingMode === "metered")).toBe(
              true,
            );
          }
        }
      }
    }
    truncateResponses = true;
    const hitsBefore = nativeHits.length;
    const truncated = await app.inject({
      method: "POST",
      url: "/v1/xai/responses",
      headers: {
        authorization: "Bearer synthetic-native-accepted",
        "x-archestra-virtual-key": platform,
        "x-xai-token-auth": "xai-grok-cli",
      },
      payload: {
        model: "synthetic-truncated-model",
        input: "Synthetic.",
        stream: true,
        tools: [
          {
            type: "function",
            name: "lookup",
            parameters: { type: "object" },
          },
        ],
      },
    });
    expect(nativeHits).toHaveLength(hitsBefore + 1);
    expect(truncated.body).not.toContain('"type":"response.completed"');
    expect(truncated.body).not.toContain("must-not-run");
    const failed = (
      await InteractionModel.getAllInteractionsForProfile(agent.id)
    ).find((row) => asRecord(row.response)?.status === "incomplete");
    expect(failed?.type).toBe("xai:responses");
    expect(failed?.billingMode).toBe("metered");
    expect(asRecord(failed?.response)?.output).toEqual([]);
  } finally {
    config.llm.xai.subscription.baseUrl = oldNative;
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("native session requests authenticate before discovery, use the current native default, and never send session credentials to the API-key upstream", async ({
  makeAgent,
  makeUser,
  makeMember,
}) => {
  let recommended = "synthetic-native-new";
  let mode = "ok";
  let settingsCalls = 0;
  let catalogCalls = 0;
  let escapedCalls = 0;
  const requests: {
    path: string;
    model: string;
    input: string;
    tool: string | undefined;
    nativeAuth: boolean;
    platformHeader: boolean;
  }[] = [];
  const metadata = () => settingsCalls + catalogCalls;
  const server = createServer(async (request, response) => {
    if (request.url === "/escape") {
      escapedCalls++;
      response.end();
      return;
    }
    if (
      request.url === "/native/settings" ||
      request.url === "/native/models"
    ) {
      const settings = request.url === "/native/settings";
      if (settings) settingsCalls++;
      else catalogCalls++;
      if (mode === "redirect" || (settings && mode === "settings-redirect")) {
        response.writeHead(302, { location: "/escape" });
        response.end();
        return;
      }
      if (
        mode === "unauthorized" ||
        mode === "forbidden" ||
        (settings &&
          (mode === "settings-unauthorized" || mode === "settings-forbidden"))
      ) {
        response.writeHead(
          mode.endsWith("forbidden") || mode === "forbidden" ? 403 : 401,
        );
        response.end("synthetic private upstream body must not be exposed");
        return;
      }
      if (mode === "bounds") {
        response.setHeader("Content-Type", "application/json");
        response.end(`{"default_model":"${"x".repeat(2 * 1024 * 1024 + 8)}"}`);
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (settings) {
        response.end(
          JSON.stringify(
            mode === "settings-missing"
              ? {}
              : {
                  default_model:
                    mode === "settings-invalid" ? "unsafe\nmodel" : recommended,
                },
          ),
        );
        return;
      }
      response.end(
        JSON.stringify({
          data:
            mode === "missing"
              ? [{ id: "unrelated-synthetic" }]
              : [
                  {
                    id: recommended,
                    ...(mode === "id-only"
                      ? {}
                      : {
                          model:
                            mode === "invalid-id"
                              ? "unsafe\nmodel"
                              : recommended,
                        }),
                    ...(mode === "camel-responses"
                      ? { apiBackend: "responses" }
                      : {
                          api_backend:
                            mode === "chat-backend"
                              ? "chat_completions"
                              : "responses",
                        }),
                    ...(mode === "foreign-base"
                      ? { baseUrl: "https://untrusted.example/v1" }
                      : {}),
                    ...(mode === "hidden" ? { _meta: { hidden: true } } : {}),
                  },
                ],
        }),
      );
      return;
    }
    if (
      request.url !== "/native/responses" &&
      request.url !== "/native/chat/completions"
    ) {
      escapedCalls++;
      response.writeHead(500);
      response.end();
      return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({
      path: request.url,
      model: body.model,
      input: body.input,
      tool: body.tools?.[0]?.name,
      nativeAuth:
        request.headers.authorization === "Bearer synthetic-native-access" &&
        request.headers["x-xai-token-auth"] === "xai-grok-cli",
      platformHeader: Boolean(request.headers["x-archestra-virtual-key"]),
    });
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/native/responses"
          ? {
              id: "resp_native",
              object: "response",
              created_at: 1,
              model: body.model,
              status: "completed",
              output: [
                {
                  id: "msg_native",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: "Synthetic native session.",
                      annotations: [],
                    },
                  ],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }
          : {
              id: "synthetic",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "Synthetic native session.",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  config.llm.xai.subscription.baseUrl = `${base}/native`;
  config.llm.xai.baseUrl = `${base}/wrong-api-key-upstream`;
  const app = createFastifyInstance();
  await app.register(xaiProxyRoutes);
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId);
  const platform = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: user.id,
  });
  const headers = {
    authorization: "Bearer synthetic-native-access",
    "x-archestra-grok-credential-mode": "native-session",
    "x-archestra-virtual-key": platform,
  };
  const payload = (model: string) => ({
    model,
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
  const turn = (
    model = "archestra-native-default",
    auth = headers,
    endpoint: "responses" | "chat/completions" = "responses",
  ) =>
    app.inject({
      method: "POST",
      url: `/v1/xai/${endpoint}`,
      headers: auth,
      payload:
        endpoint === "responses"
          ? payload(model)
          : { model, messages: [{ role: "user", content: "Synthetic." }] },
    });
  try {
    const anonymous = await turn("archestra-native-default", {
      ...headers,
      "x-archestra-virtual-key": "",
    });
    expect([401, 403]).toContain(anonymous.statusCode);
    expect(metadata()).toBe(0);
    const first = await turn();
    expect(first.statusCode, first.body).toBe(200);
    recommended = "synthetic-native-newer";
    const newer = await turn();
    expect(newer.statusCode, newer.body).toBe(200);
    const beforePin = metadata();
    mode = "missing";
    const pinned = await turn("explicit-pinned-model");
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(metadata()).toBe(beforePin);
    expect(settingsCalls).toBe(2);
    expect(catalogCalls).toBe(2);
    for (const rejected of [
      "settings-missing",
      "settings-invalid",
      "missing",
      "foreign-base",
      "invalid-id",
      "hidden",
      "bounds",
    ]) {
      mode = rejected;
      const before = requests.length;
      const rejectedTurn = await turn();
      expect(rejectedTurn.statusCode, `${rejected}: ${rejectedTurn.body}`).toBe(
        502,
      );
      expect(requests.length).toBe(before);
    }
    for (const rejected of ["redirect", "settings-redirect"]) {
      mode = rejected;
      const before = requests.length;
      expect((await turn()).statusCode).toBe(502);
      expect(requests.length).toBe(before);
    }
    for (const [failure, status] of [
      ["unauthorized", 401],
      ["forbidden", 403],
      ["settings-unauthorized", 401],
      ["settings-forbidden", 403],
    ] as const) {
      mode = failure;
      const before = requests.length;
      const result = await turn();
      expect(result.statusCode).toBe(status);
      expect(result.body).not.toContain("synthetic private upstream body");
      expect(requests.length).toBe(before);
    }
    {
      mode = "chat-backend";
      const before = requests.length;
      const result = await turn();
      expect(result.statusCode, result.body).toBe(400);
      expect(result.body).toContain("Reconnect");
      expect(requests.length).toBe(before);
    }
    mode = "id-only";
    expect((await turn()).statusCode).toBe(200);
    for (const accepted of ["camel-responses", "snake-responses", "ok"]) {
      mode = accepted;
      expect((await turn()).statusCode).toBe(200);
    }
    mode = "ok";
    const chatMismatch = await turn(
      "archestra-native-default",
      headers,
      "chat/completions",
    );
    expect(chatMismatch.statusCode, chatMismatch.body).toBe(400);
    expect(chatMismatch.body).toContain("Reconnect");
    expect(
      requests.every((request) => request.path === "/native/responses"),
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/xai/unrecognized-native-endpoint",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/v1/xai/models", headers }))
        .statusCode,
    ).toBe(400);
    expect(requests.map((request) => request.model)).toEqual([
      "synthetic-native-new",
      "synthetic-native-newer",
      "explicit-pinned-model",
      recommended,
      recommended,
      recommended,
      recommended,
    ]);
    expect(requests.every((request) => request.input === "Synthetic.")).toBe(
      true,
    );
    expect(requests.every((request) => request.tool === "lookup")).toBe(true);
    expect(
      requests.every(
        (request) => request.nativeAuth && !request.platformHeader,
      ),
    ).toBe(true);
    const accepted = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(
      accepted
        .filter((row) => row.billingMode === "subscription")
        .map((row) => row.type),
    ).toEqual(Array(requests.length).fill("xai:responses"));
    expect(escapedCalls).toBe(0);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
