import { createServer } from "node:http";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel } from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import xaiProxyRoutes from "./xai";

setupTestCacheManager();

test("native metadata validates platform attribution, forwards only the native credential to fixed metadata paths, and never admits inference", async ({
  makeAgent,
  makeUser,
  makeMember,
}) => {
  const observed: {
    url: string | undefined;
    headers: Record<string, string | string[] | undefined>;
  }[] = [];
  let malformed = false;
  const server = createServer((request, response) => {
    observed.push({ url: request.url, headers: request.headers });
    response.setHeader("Content-Type", "application/json");
    if (malformed) {
      response.end("synthetic-private-invalid-json");
    } else if (request.headers.authorization === "Bearer synthetic-expired") {
      response.writeHead(401).end('{"error":"synthetic-private-error"}');
    } else {
      response.end(
        JSON.stringify(
          request.url?.endsWith("/models")
            ? {
                data: [
                  {
                    id: "native-id",
                    model: "native-wire",
                    name: "Native Name",
                    reasoningEfforts: [{ value: "high" }],
                    api_backend: "responses",
                    supportsBackendSearch: true,
                    supports_backend_search: true,
                    _meta: { supportsBackendSearch: true },
                  },
                ],
              }
            : { default_model: "native-id" },
        ),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = config.llm.xai.subscription.baseUrl;
  config.llm.xai.subscription.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/subscription`;
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId);
  const token = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: user.id,
  });
  const app = createFastifyInstance();
  await app.register(xaiProxyRoutes);
  const headers = {
    authorization: "Bearer synthetic-native",
    "x-archestra-virtual-key": token,
    "x-archestra-grok-credential-mode": "native-session",
    "x-userid": "synthetic-user",
    cookie: "synthetic=private",
  };
  try {
    for (const prefix of ["/v1/xai", `/v1/xai/${agent.id}`]) {
      const models = await app.inject({
        method: "GET",
        url: prefix + "/native/models",
        headers,
      });
      expect(models.statusCode, models.body).toBe(200);
      expect(models.json()).toMatchObject({
        data: [
          {
            id: "native-id",
            name: "Native Name",
            reasoningEfforts: [{ value: "high" }],
            supportsBackendSearch: false,
            supports_backend_search: false,
            _meta: { supportsBackendSearch: false },
          },
        ],
      });
      expect(models.headers["cache-control"]).toBe("no-store");
      const settings = await app.inject({
        method: "GET",
        url: prefix + "/native/settings",
        headers,
      });
      expect(settings.statusCode, settings.body).toBe(200);
      expect(settings.json()).toEqual({ default_model: "native-id" });
      const count = observed.length;
      for (const kind of ["user", "responses", "settings?path=/responses"]) {
        const rejected = await app.inject({
          method: "GET",
          url: prefix + "/native/" + kind,
          headers,
        });
        expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
      }
      for (const overrides of [
        { authorization: "Bearer xai-synthetic-api-key" },
        { "x-archestra-virtual-key": "invalid-platform-key" },
        { "x-archestra-grok-credential-mode": "", "x-xai-token-auth": "" },
      ]) {
        const rejected = await app.inject({
          method: "GET",
          url: prefix + "/native/models",
          headers: { ...headers, ...overrides },
        });
        expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(observed).toHaveLength(count);
    }
    const expired = await app.inject({
      method: "GET",
      url: "/v1/xai/native/models",
      headers: { ...headers, authorization: "Bearer synthetic-expired" },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.body).not.toContain("synthetic-private-error");
    malformed = true;
    const invalid = await app.inject({
      method: "GET",
      url: "/v1/xai/native/models",
      headers,
    });
    expect(invalid.statusCode).toBe(502);
    expect(invalid.body).not.toContain("synthetic-private-invalid-json");
    expect(
      observed.every(
        (call) =>
          typeof call.headers.authorization === "string" &&
          call.headers.authorization.startsWith("Bearer synthetic-"),
      ),
    ).toBe(true);
    expect(
      observed.every(
        (call) =>
          !call.headers.cookie && !call.headers["x-archestra-virtual-key"],
      ),
    ).toBe(true);
    expect(observed.map((call) => call.url)).toEqual([
      "/subscription/models",
      "/subscription/settings",
      "/subscription/models",
      "/subscription/settings",
      "/subscription/models",
      "/subscription/models",
    ]);
    expect(
      (await InteractionModel.findAllPaginated({ limit: 10, offset: 0 })).data,
    ).toEqual([]);
  } finally {
    config.llm.xai.subscription.baseUrl = previous;
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
