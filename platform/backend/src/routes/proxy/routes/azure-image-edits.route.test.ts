import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import OpenAI, { AzureOpenAI, toFile } from "openai";
import sharp from "sharp";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel, VirtualApiKeyModel } from "@/models";
import LimitModel from "@/models/limit";
import { test as baseTest, expect } from "@/test";
import azureRoutes from "./azure";

interface UpstreamRequest {
  path: string;
  apiKey: string | string[] | undefined;
  authorization: string | undefined;
  platformHeader: string | string[] | undefined;
  fields: [string, string][];
  files: { field: string; hash: string; mime: string }[];
}

const test = baseTest.extend<{
  media: {
    client: OpenAI;
    baseUrl: string;
    key: string;
    agentId: string;
    image: Buffer;
    requests: UpstreamRequest[];
    respond: (
      handler: (req: IncomingMessage, res: ServerResponse) => void,
    ) => void;
  };
}>({
  media: async ({ makeAgent, makeSecret, makeLlmProviderApiKey }, use) => {
    const image = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 2, g: 3, b: 4, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const requests: UpstreamRequest[] = [];
    let respond = (_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: image.toString("base64") }],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
      );
    };
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const form = await new Request("http://upstream.example/", {
        method: "POST",
        headers: { "content-type": request.headers["content-type"] ?? "" },
        body,
      }).formData();
      const fields: [string, string][] = [];
      const files: UpstreamRequest["files"] = [];
      for (const [name, value] of form.entries()) {
        if (typeof value === "string") fields.push([name, value]);
        else
          files.push({
            field: name,
            hash: createHash("sha256")
              .update(Buffer.from(await value.arrayBuffer()))
              .digest("hex"),
            mime: value.type,
          });
      }
      requests.push({
        path: request.url ?? "",
        apiKey: request.headers["api-key"],
        authorization: request.headers.authorization,
        platformHeader: request.headers["x-archestra-virtual-key"],
        fields,
        files,
      });
      respond(request, response);
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("No upstream port");
    const baseUrl = `http://127.0.0.1:${address.port}/openai/v1`;
    // The selected managed key must win over the catch-all's configured endpoint.
    config.llm.azure.baseUrl = "https://unselected.example/openai/v1";
    config.llmProxy.plugins = [];
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const secret = await makeSecret({
      secret: { apiKey: "fixture-image-provider-key" },
    });
    const providerKey = await makeLlmProviderApiKey(
      agent.organizationId,
      secret.id,
      { provider: "azure", baseUrl },
    );
    const key = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "image SDK tests",
      providerApiKeys: [
        { provider: "azure", providerApiKeyId: providerKey.id },
      ],
    });
    const app = createFastifyInstance();
    await app.register(azureRoutes);
    const local = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      await use({
        client: new OpenAI({
          baseURL: `${local}/v1/azure`,
          apiKey: key.value,
          maxRetries: 0,
          timeout: 10_000,
        }),
        baseUrl: `${local}/v1/azure`,
        key: key.value,
        agentId: agent.id,
        image,
        requests,
        respond: (handler) => {
          respond = handler;
        },
      });
    } finally {
      await app.close();
      await new Promise<void>((done) => upstream.close(() => done()));
    }
  },
});

test("real SDK edits preserve multiple inputs and a mask with governed credential selection and metadata-only audit", async ({
  media,
}) => {
  const second = await sharp(media.image).resize(32, 16).png().toBuffer();
  const result = await media.client.images.edit({
    model: "gpt-image-1",
    prompt: "Add a blue circle.",
    image: [
      await toFile(media.image, "one.png"),
      await toFile(second, "two.png"),
    ],
    mask: await toFile(media.image, "mask.png"),
    input_fidelity: "high",
    n: 1,
    output_format: "png",
    stream: false,
  });
  expect(result.data?.[0].b64_json).toBe(media.image.toString("base64"));
  expect(media.requests).toHaveLength(1);
  const forwarded = media.requests[0];
  expect(forwarded).toMatchObject({
    path: "/openai/v1/images/edits",
    apiKey: "fixture-image-provider-key",
    platformHeader: undefined,
  });
  expect(forwarded.authorization).not.toContain(media.key);
  expect(forwarded.files.map((file) => file.hash)).toEqual(
    [media.image, second, media.image].map((data) =>
      createHash("sha256").update(data).digest("hex"),
    ),
  );
  expect(Object.fromEntries(forwarded.fields)).toMatchObject({
    model: "gpt-image-1",
    prompt: "Add a blue circle.",
    input_fidelity: "high",
    stream: "false",
    n: "1",
  });
  const interactions = await InteractionModel.getAllInteractionsForProfile(
    media.agentId,
  );
  expect(interactions).toHaveLength(1);
  expect(interactions[0]).toMatchObject({
    type: "azure:images",
    model: "gpt-image-1",
    inputTokens: 2,
    outputTokens: 3,
    cost: null,
    request: {
      input_files: {
        images: [{ filename: "one.png" }, { filename: "two.png" }],
        mask: { filename: "mask.png" },
      },
    },
  });
  expect(JSON.stringify(interactions[0].request)).not.toContain(
    media.image.toString("base64"),
  );
  expect(JSON.stringify(interactions[0].request)).not.toContain(
    "fixture-image-provider-key",
  );
});

test("current external JavaScript and Python SDKs work with only URL/key changes when installed for a smoke run", async ({
  media,
}) => {
  const file = await toFile(media.image, "one.png");
  await media.client.images.edit({
    model: "gpt-image-1",
    prompt: "Add a circle.",
    image: file,
  });
  if (!process.env.MEDIA_PYTHON || !process.env.MEDIA_SDK_ENTRY) return;
  const directory = await mkdtemp(join(tmpdir(), "image-sdk-"));
  const image = join(directory, "reference.png");
  await writeFile(image, media.image);
  try {
    const results = [];
    for (const { language, azure } of [
      { language: "javascript", azure: undefined },
      { language: "python", azure: undefined },
      { language: "javascript", azure: "true" },
      { language: "python", azure: "true" },
    ]) {
      const { stdout } = await promisify(execFile)(
        language === "python" ? process.env.MEDIA_PYTHON : process.execPath,
        [
          resolve(
            `src/test/media-sdk-client.${language === "python" ? "py" : "mjs"}`,
          ),
        ],
        {
          env: {
            PATH: process.env.PATH,
            MEDIA_SDK_BASE_URL: media.baseUrl,
            MEDIA_SDK_API_KEY: media.key,
            MEDIA_SDK_IMAGE: image,
            MEDIA_SDK_ENTRY: process.env.MEDIA_SDK_ENTRY,
            MEDIA_SDK_AZURE: azure,
          },
          timeout: 20_000,
        },
      );
      results.push({
        language,
        client: azure ? "AzureOpenAI" : "OpenAI",
        ...JSON.parse(stdout),
      });
    }
    expect(results.map((result) => result.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(media.requests).toHaveLength(5);
    expect(
      media.requests.every(
        (request) => request.apiKey === "fixture-image-provider-key",
      ),
    ).toBe(true);
    if (process.env.MEDIA_EVIDENCE_PATH)
      await writeFile(
        process.env.MEDIA_EVIDENCE_PATH,
        JSON.stringify(
          {
            versions: { javascript: "7.41.0", python: "3.36.0" },
            results,
            requests: media.requests.map(
              ({ apiKey: _key, authorization: _authorization, ...request }) =>
                request,
            ),
          },
          null,
          2,
        ),
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing provider usage stays null rather than becoming zero tokens or free cost", async ({
  media,
}) => {
  media.respond((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        created: 1,
        data: [{ b64_json: media.image.toString("base64") }],
      }),
    );
  });
  await media.client.images.edit({
    model: "gpt-image-1",
    prompt: "A circle.",
    image: await toFile(media.image, "one.png"),
  });
  const interactions = await InteractionModel.getAllInteractionsForProfile(
    media.agentId,
  );
  expect(interactions.at(-1)).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    cost: null,
  });
});

test("blocks image edits before dispatch under an applicable financial budget", async ({
  media,
}) => {
  await LimitModel.create({
    entityType: "agent",
    entityId: media.agentId,
    limitType: "token_cost",
    limitValue: 100,
    model: ["gpt-image-1"],
    lastCleanup: new Date(),
  });
  await expect(
    media.client.images.edit({
      model: "gpt-image-1",
      prompt: "A circle.",
      image: await toFile(media.image, "one.png"),
    }),
  ).rejects.toMatchObject({ status: 422 });
  expect(media.requests).toHaveLength(0);
});

test("native Azure SDK deployment path overrides form model and preserves api-version", async ({
  media,
}) => {
  const client = new AzureOpenAI({
    endpoint: media.baseUrl,
    apiKey: media.key,
    apiVersion: "2025-04-01-preview",
    deployment: "image-alias",
    maxRetries: 0,
  });
  await client.images.edit({
    model: "different-body-model",
    prompt: "A circle.",
    image: await toFile(media.image, "one.png"),
  });
  expect(Object.fromEntries(media.requests[0].fields).model).toBe(
    "image-alias",
  );
  expect(media.requests[0].path).toBe(
    "/openai/v1/images/edits?api-version=2025-04-01-preview",
  );
  expect(
    (await InteractionModel.getAllInteractionsForProfile(media.agentId)).at(-1)
      ?.model,
  ).toBe("image-alias");
});

test("client cancellation aborts the in-flight image provider request without retry", async ({
  media,
}) => {
  let began: () => void = () => undefined;
  let closed: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  media.respond((_request, response) => {
    response.once("close", closed);
    began();
  });
  const controller = new AbortController();
  const form = new FormData();
  form.set("model", "gpt-image-1");
  form.set("prompt", "A circle.");
  form.set("image", new Blob([new Uint8Array(media.image)]), "one.png");
  const request = fetch(`${media.baseUrl}/images/edits`, {
    method: "POST",
    headers: { authorization: `Bearer ${media.key}` },
    body: form,
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await expect(request).rejects.toThrow();
  await Promise.race([
    upstreamClosed,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Provider request was not cancelled")),
        2000,
      ),
    ),
  ]);
  expect(media.requests).toHaveLength(1);
});

test("rejects unauthenticated calls and enforced accounting before any upstream request", async ({
  media,
}) => {
  const request = {
    model: "gpt-image-1",
    prompt: "A circle.",
    image: await toFile(media.image, "one.png"),
  };
  await expect(
    media.client.withOptions({ apiKey: "invalid-key" }).images.edit(request),
  ).rejects.toMatchObject({ status: 401 });
  config.llmProxy.usageAccountingMode = "enforce";
  await expect(media.client.images.edit(request)).rejects.toMatchObject({
    status: 422,
  });
  expect(media.requests).toHaveLength(0);
});

test("rejects unsupported stream/partial fields, duplicate masks, invalid MIME and malformed multipart before upstream", async ({
  media,
}) => {
  for (const options of [
    { stream: "true" },
    { partial_images: "1" },
    { unexpected: "value" },
  ]) {
    const form = new FormData();
    form.set("model", "gpt-image-1");
    form.set("prompt", "A circle.");
    form.set("image", new Blob([new Uint8Array(media.image)]), "image.png");
    for (const [key, value] of Object.entries(options)) form.set(key, value);
    const response = await fetch(`${media.baseUrl}/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${media.key}` },
      body: form,
    });
    expect(response.status).toBe(400);
  }
  const duplicateMask = new FormData();
  duplicateMask.set("model", "gpt-image-1");
  duplicateMask.set("prompt", "A circle.");
  duplicateMask.set(
    "image",
    new Blob([new Uint8Array(media.image)]),
    "image.png",
  );
  duplicateMask.append(
    "mask",
    new Blob([new Uint8Array(media.image)]),
    "mask.png",
  );
  duplicateMask.append(
    "mask",
    new Blob([new Uint8Array(media.image)]),
    "again.png",
  );
  expect(
    (
      await fetch(`${media.baseUrl}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${media.key}` },
        body: duplicateMask,
      })
    ).status,
  ).toBe(400);
  const malformed = await fetch(`${media.baseUrl}/images/edits`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${media.key}`,
      "content-type": "multipart/form-data; boundary=missing",
    },
    body: "incomplete",
  });
  expect(malformed.status).toBe(400);
  expect(media.requests).toHaveLength(0);
});

test.for([
  400, 401, 429, 500,
])("relays upstream HTTP %i without retrying a paid edit", async (status, {
  media,
}) => {
  media.respond((_request, response) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "retry-after": "3600",
    });
    response.end(
      JSON.stringify({
        error: {
          message: "Fixture upstream rejection",
          type: "invalid_request_error",
        },
      }),
    );
  });
  await expect(
    media.client.images.edit({
      model: "gpt-image-1",
      prompt: "A circle.",
      image: await toFile(media.image, "one.png"),
    }),
  ).rejects.toMatchObject({ status });
  expect(media.requests).toHaveLength(1);
});

test.for([
  "empty",
  "malformed-json",
  "oversized",
])("rejects %s provider output without reporting success or retrying", async (kind, {
  media,
}) => {
  media.respond((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      ...(kind === "oversized" && {
        "content-length": String(config.api.bodyLimit + 1),
      }),
    });
    response.end(
      kind === "malformed-json"
        ? "invalid-json"
        : JSON.stringify({ created: 1, data: [] }),
    );
  });
  await expect(
    media.client.images.edit({
      model: "gpt-image-1",
      prompt: "A circle.",
      image: await toFile(media.image, "one.png"),
    }),
  ).rejects.toMatchObject({ status: 502 });
  expect(media.requests).toHaveLength(1);
});
