import { createServer } from "node:http";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import ModelModel from "@/models/model";
import { expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import cohereRoutes from "./cohere";
import ollamaRoutes from "./ollama";
import ollamaNativeRoutes from "./ollama-native";

test.for([
  {
    provider: "ollama-native",
    routes: ollamaNativeRoutes,
    paths: ["/api/generate", "/api/embed", "/api/embeddings"],
    metadata: "/api/show",
  },
  {
    provider: "ollama",
    routes: ollamaRoutes,
    paths: ["/api/generate", "/api/embed"],
    metadata: "/api/show",
  },
  {
    provider: "cohere",
    routes: cohereRoutes,
    paths: ["/v2/rerank", "/v2/embed", "/v1/generate"],
    metadata: "/v1/tokenize",
  },
] as const)("$provider catch-all refuses hidden inference and preserves metadata and restoration", async ({
  provider,
  routes,
  paths,
  metadata,
}, { makeAgent, makeUser, makeMember }) => {
  const agent = await makeAgent({ agentType: "llm_proxy" });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId, { role: "admin" });
  const token = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: user.id,
  });
  const model = await ModelModel.create({
    provider,
    modelId: "synthetic-model",
    externalId: `${provider}/synthetic-model`,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  await ModelModel.update(model.id, { ignored: true });
  const hits: Array<{ url: string; body: unknown }> = [];
  const upstream = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    hits.push({
      url: request.url ?? "",
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing upstream");
  config.llm[provider].baseUrl = `http://127.0.0.1:${address.port}`;
  if (provider === "ollama") config.llm.ollama.enabled = true;
  const app = createFastifyInstance();
  await app.register(routes);
  const ask = (path: string, modelId = model.modelId) =>
    app.inject({
      method: "POST",
      url: `/v1/${provider}/${agent.id}${path}`,
      headers: {
        "x-archestra-virtual-key": token,
        authorization: "Bearer synthetic-key",
      },
      payload: {
        model: modelId,
        prompt: "Hello",
        input: "Hello",
        query: "Hello",
        documents: ["Hello"],
      },
    });
  try {
    for (const path of paths) {
      const response = await ask(path);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.body).toContain("hidden");
    }
    if (provider === "ollama" || provider === "ollama-native") {
      for (const contentType of ["text/plain", undefined]) {
        const response = await app.inject({
          method: "POST",
          url: `/v1/${provider}/${agent.id}${paths[0]}`,
          headers: {
            "x-archestra-virtual-key": token,
            ...(contentType ? { "content-type": contentType } : {}),
          },
          payload: Buffer.from(
            JSON.stringify({ Model: model.modelId, prompt: "Hello" }),
          ),
        });
        expect(response.statusCode, response.body).toBe(403);
        expect(response.body).toContain("hidden");
      }
      for (const payload of [
        '{"model":"synthetic-model","Model":null}',
        '{"model":"synthetic-model","Model":"unknown-custom-model","model":"synthetic-model"}',
        '{"model":"synthetic-model","model":null}',
      ]) {
        const response = await app.inject({
          method: "POST",
          url: `/v1/${provider}/${agent.id}${paths[0]}`,
          headers: {
            "x-archestra-virtual-key": token,
            "content-type": "application/json",
          },
          payload,
        });
        expect(response.statusCode, response.body).toBe(400);
      }
    }
    expect(hits).toHaveLength(0);
    expect((await ask(metadata)).statusCode).toBe(200);
    expect((await ask(paths[0], "unknown-custom-model")).statusCode).toBe(200);
    await ModelModel.update(model.id, { ignored: false });
    expect((await ask(paths[0])).statusCode).toBe(200);
    expect(hits).toHaveLength(3);
    expect(hits[2].body).toMatchObject({
      model: model.modelId,
      prompt: "Hello",
    });
  } finally {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
