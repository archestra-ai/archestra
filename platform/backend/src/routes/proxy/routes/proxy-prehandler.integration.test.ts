import { createServer } from "node:http";
import {
  gunzipSync,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
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
    modelId:
      provider === "cohere" ? "synthetic-model" : "synthetic-model:latest",
    externalId: `${provider}/synthetic-model`,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  await ModelModel.update(model.id, { ignored: true });
  const hits: Array<{ url: string; body: unknown; raw: Buffer }> = [];
  const upstream = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const decoded =
      request.headers["content-encoding"] === "zstd"
        ? zstdDecompressSync(raw)
        : request.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw)
          : raw;
    const multipart = request.headers["content-type"]?.startsWith(
      "multipart/form-data",
    )
      ? await new Response(new Uint8Array(raw), {
          headers: { "content-type": request.headers["content-type"] },
        }).formData()
      : undefined;
    hits.push({
      url: request.url ?? "",
      raw,
      body: request.url?.includes("/api/blobs/")
        ? raw
        : multipart
          ? {
              model:
                new URL(
                  request.url ?? "",
                  "http://upstream.invalid",
                ).searchParams.get("model") ?? multipart.get("model"),
            }
          : JSON.parse(decoded.toString()),
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
  const compressed = zstdCompressSync(
    Buffer.from(
      JSON.stringify({ model: model.modelId, input: "Hello", prompt: "Hello" }),
    ),
  );
  const askCompressed = () =>
    app.inject({
      method: "POST",
      url: `/v1/${provider}/${agent.id}${provider === "ollama" ? "/responses" : "/v1/responses"}`,
      headers: {
        "x-archestra-virtual-key": token,
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      payload: compressed,
    });
  const gzipBytes = gzipSync(
    Buffer.from(
      JSON.stringify({
        model: model.modelId,
        query: "Hello",
        documents: ["Hello"],
      }),
    ),
  );
  const askGzip = () =>
    app.inject({
      method: "POST",
      url: `/v1/${provider}/${agent.id}${paths[0]}`,
      headers: {
        "x-archestra-virtual-key": token,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      payload: gzipBytes,
    });
  const form = new FormData();
  form.set("model", model.modelId);
  form.set(
    "file",
    new Blob(["synthetic audio"], { type: "audio/wav" }),
    "sample.wav",
  );
  const multipartRequest = new Request("http://synthetic.invalid", {
    method: "POST",
    body: form,
  });
  const multipartBytes = Buffer.from(await multipartRequest.arrayBuffer());
  const askMultipart = (query = "", bytes = multipartBytes) =>
    app.inject({
      method: "POST",
      url: `/v1/${provider}/${agent.id}${provider === "ollama" ? "/audio/transcriptions" : "/v1/audio/transcriptions"}${query}`,
      headers: {
        "x-archestra-virtual-key": token,
        "content-type": multipartRequest.headers.get("content-type") ?? "",
      },
      payload: bytes,
    });
  try {
    for (const path of paths) {
      const response = await ask(path);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.body).toContain("hidden");
    }
    if (provider === "ollama" || provider === "ollama-native") {
      for (const alias of [
        "synthetic-model",
        "LIBRARY/synthetic-model:latest",
        "registry.ollama.ai/library/synthetic-model",
      ]) {
        const hiddenAlias = await ask(paths[0], alias);
        expect(hiddenAlias.statusCode, hiddenAlias.body).toBe(403);
      }
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
        '{"model":"synthetic-model"}{}',
        '{"model":"synthetic-model"}x',
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
      const encodedHeader = await app.inject({
        method: "POST",
        url: `/v1/${provider}/${agent.id}${paths[0]}`,
        headers: {
          "x-archestra-virtual-key": token,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        payload: JSON.stringify({ model: model.modelId }),
      });
      expect(encodedHeader.statusCode, encodedHeader.body).toBe(403);
      const encoded = await askCompressed();
      expect(encoded.statusCode, encoded.body).toBe(403);
      const multipart = await askMultipart();
      expect(multipart.statusCode, multipart.body).toBe(403);
      // Go's FormValue selects a query model before the multipart field.
      const visibleOverride = await askMultipart("?model=unknown-custom-model");
      expect(visibleOverride.statusCode, visibleOverride.body).toBe(200);
      expect(hits.pop()?.body).toMatchObject({ model: "unknown-custom-model" });
      for (const query of ["?model=bad%ZZ", "?model=bad;value"]) {
        const ambiguous = await askMultipart(query);
        expect(ambiguous.statusCode, ambiguous.body).toBe(400);
      }
      const queryOnlyBytes = Buffer.from(
        multipartBytes.toString().replace(model.modelId, ""),
      );
      const queryOnly = await askMultipart(
        `?model=${encodeURIComponent(model.modelId)}`,
        queryOnlyBytes,
      );
      expect(queryOnly.statusCode, queryOnly.body).toBe(403);
    }
    if (provider === "cohere") {
      const compressedHidden = await askGzip();
      expect(compressedHidden.statusCode, compressedHidden.body).toBe(403);
      const unsupported = await app.inject({
        method: "POST",
        url: `/v1/${provider}/${agent.id}${paths[0]}`,
        headers: {
          "x-archestra-virtual-key": token,
          "content-type": "application/json",
          "content-encoding": "constructor",
        },
        payload: { model: model.modelId },
      });
      expect(unsupported.statusCode, unsupported.body).toBe(415);
    }
    expect(hits).toHaveLength(0);
    const nativeOllama = provider === "ollama" || provider === "ollama-native";
    if (nativeOllama) {
      const bytes = Buffer.from([0, 255, 1, 2, 3]);
      const upload = await app.inject({
        method: "POST",
        url: `/v1/${provider}/${agent.id}/api/blobs/sha256:${"a".repeat(64)}`,
        headers: {
          "x-archestra-virtual-key": token,
          "content-type": "application/octet-stream",
        },
        payload: bytes,
      });
      expect(upload.statusCode, upload.body).toBe(200);
      expect(hits.at(-1)?.body).toEqual(bytes);
    }
    expect((await ask(metadata)).statusCode).toBe(200);
    expect((await ask(paths[0], "unknown-custom-model")).statusCode).toBe(200);
    await ModelModel.update(model.id, { ignored: false });
    expect((await ask(paths[0])).statusCode).toBe(200);
    if (nativeOllama) {
      const encoded = await askCompressed();
      expect(encoded.statusCode, encoded.body).toBe(200);
      expect(hits.at(-1)?.raw).toEqual(compressed);
      const multipart = await askMultipart();
      expect(multipart.statusCode, multipart.body).toBe(200);
      expect(hits.at(-1)?.raw).toEqual(multipartBytes);
      const hiddenOverrideModel = await ModelModel.create({
        provider,
        modelId: "hidden-query-model",
        externalId: `${provider}/hidden-query-model`,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });
      await ModelModel.update(hiddenOverrideModel.id, { ignored: true });
      const hiddenOverride = await askMultipart("?model=hidden-query-model");
      expect(hiddenOverride.statusCode, hiddenOverride.body).toBe(403);
      expect(hits).toHaveLength(6);
    }
    if (provider === "cohere") {
      const compressedVisible = await askGzip();
      expect(compressedVisible.statusCode, compressedVisible.body).toBe(200);
      expect(hits.pop()?.raw).toEqual(gzipBytes);
    }
    expect(hits).toHaveLength(nativeOllama ? 6 : 3);
    expect(hits.at(-1)?.body).toMatchObject({
      model: model.modelId,
    });
  } finally {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
