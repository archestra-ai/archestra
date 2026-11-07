import { createServer } from "node:http";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { VirtualApiKeyModel } from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import xaiProxyRoutes from "./xai";

setupTestCacheManager();

test("xAI account discovery authenticates passthrough and resolves virtual keys before a bounded upstream request", async ({
  makeAgent,
  makeUser,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const upstreamRequests: {
    auth: string | undefined;
    platformHeader: boolean;
    path: string | undefined;
  }[] = [];
  let mode: "ok" | "redirect" | "failure" | "malformed" | "oversized" = "ok";
  let redirected = 0;
  const upstream = createServer((request, response) => {
    if (request.url === "/redirected") {
      redirected++;
      response.end("unexpected");
      return;
    }
    upstreamRequests.push({
      auth: request.headers.authorization,
      platformHeader: Boolean(request.headers["x-archestra-virtual-key"]),
      path: request.url,
    });
    if (mode === "redirect") {
      response.writeHead(302, { location: "/redirected" });
      response.end();
      return;
    }
    if (mode === "failure") {
      response.writeHead(401);
      response.end("synthetic-caller-key must never leak");
      return;
    }
    if (mode === "malformed") {
      response.end("synthetic-caller-key not JSON");
      return;
    }
    if (mode === "oversized") {
      response.end("x".repeat(1048577));
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        data: [
          { id: "grok-4.7", created: 1700000000 },
          { id: "grok-4.6", created: 1600000000 },
          { id: "plan-only", supportedInApi: false },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind");
  const oldBase = config.llm.xai.baseUrl;
  config.llm.xai.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const app = createFastifyInstance();
  await app.register(xaiProxyRoutes);
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId);
  const passthrough = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: user.id,
  });
  const secret = await makeSecret({
    secret: { apiKey: "synthetic-mapped-key" },
  });
  const provider = await makeLlmProviderApiKey(
    agent.organizationId,
    secret.id,
    { provider: "xai" },
  );
  const virtual = await VirtualApiKeyModel.create({
    organizationId: agent.organizationId,
    name: "Synthetic xAI discovery",
    providerApiKeys: [{ provider: "xai", providerApiKeyId: provider.id }],
  });
  const headers = {
    authorization: "Bearer synthetic-caller-key",
    "x-archestra-virtual-key": passthrough,
    "X-Archestra-Agent-Id": "grok-build",
  };
  try {
    const denied = await app.inject({
      method: "GET",
      url: `/v1/xai/${agent.id}/models`,
      headers: { authorization: headers.authorization },
    });
    expect(denied.statusCode).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
    const caller = await app.inject({
      method: "GET",
      url: `/v1/xai/${agent.id}/models`,
      headers,
    });
    expect(caller.statusCode, caller.body).toBe(200);
    expect(caller.json().data).toEqual([
      { id: "grok-4.7", object: "model", created: 1700000000, owned_by: "xai" },
      { id: "grok-4.6", object: "model", created: 1600000000, owned_by: "xai" },
    ]);
    expect(upstreamRequests.at(-1)).toEqual({
      auth: "Bearer synthetic-caller-key",
      platformHeader: false,
      path: "/v1/models",
    });
    const mapped = await app.inject({
      method: "GET",
      url: "/v1/xai/models",
      headers: { authorization: `Bearer ${virtual.value}` },
    });
    expect(mapped.statusCode, mapped.body).toBe(200);
    expect(upstreamRequests.at(-1)?.auth).toBe("Bearer synthetic-mapped-key");
    for (const failure of [
      "redirect",
      "failure",
      "malformed",
      "oversized",
    ] as const) {
      mode = failure;
      const result = await app.inject({
        method: "GET",
        url: `/v1/xai/${agent.id}/models`,
        headers,
      });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.body).not.toContain("synthetic-caller-key");
    }
    expect(redirected).toBe(0);
  } finally {
    config.llm.xai.baseUrl = oldBase;
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
