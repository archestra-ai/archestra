import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import OpenAI, { toFile } from "openai";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  InteractionModel,
  LlmProviderApiKeyModel,
  VirtualApiKeyModel,
} from "@/models";
import LimitModel from "@/models/limit";
import { test as baseTest, expect } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import azureRoutes from "./azure";

setupTestCacheManager();

const test = baseTest.extend<{
  files: {
    client: OpenAI;
    other: OpenAI;
    agentId: string;
    base: string;
    token: string;
    providerKeyId: string;
    virtualKeyId: string;
    calls: { path: string; method: string }[];
    remote: Map<
      string,
      { data: Buffer; filename: string; expires_at?: number }
    >;
    failure: (status: number | null, invalidMetadata?: boolean) => void;
  };
}>({
  files: async ({ makeAgent, makeSecret, makeLlmProviderApiKey }, use) => {
    const calls: { path: string; method: string }[] = [];
    const remote = new Map<
      string,
      { data: Buffer; filename: string; expires_at?: number }
    >();
    let failure: number | null = null;
    let invalidMetadata = false;
    let nextId = 0;
    const upstream = createServer(async (request, response) => {
      const path = request.url?.split("?")[0] ?? "";
      calls.push({ path, method: request.method ?? "" });
      expect(request.headers["api-key"]).toBe("fixture-file-provider-key");
      expect(request.headers["x-archestra-virtual-key"]).toBeUndefined();
      response.setHeader("content-type", "application/json");
      if (failure) {
        response.writeHead(failure);
        response.end(
          JSON.stringify({
            error: {
              message: "fixture-file-provider-key must never leak",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      if (request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const form = await new Request("http://upstream.example", {
          method: "POST",
          headers: { "content-type": request.headers["content-type"] ?? "" },
          body: Buffer.concat(chunks),
        }).formData();
        const file = form.get("file") as File;
        const data = Buffer.from(await file.arrayBuffer());
        expect(form.get("purpose")).toBe("user_data");
        const id = `file-native-${++nextId}`;
        const seconds = Number(form.get("expires_after[seconds]"));
        const value = {
          data,
          filename: file.name,
          ...(seconds && {
            expires_at: Math.floor(Date.now() / 1000) + seconds,
          }),
        };
        remote.set(id, value);
        response.writeHead(201);
        response.end(
          JSON.stringify({
            id,
            object: "file",
            filename: file.name,
            bytes: invalidMetadata ? data.length + 1 : data.length,
            created_at: Math.floor(Date.now() / 1000),
            purpose: "user_data",
            status: "processed",
            ...(value.expires_at && { expires_at: value.expires_at }),
          }),
        );
        return;
      }
      const id = path.split("/").at(path.endsWith("/content") ? -2 : -1) ?? "";
      const file = remote.get(id);
      if (!file) {
        response.writeHead(404);
        response.end(
          JSON.stringify({ error: { message: "Missing fixture file" } }),
        );
        return;
      }
      if (request.method === "DELETE") {
        remote.delete(id);
        response.end(JSON.stringify({ id, object: "file", deleted: true }));
        return;
      }
      if (path.endsWith("/content")) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(file.data);
        return;
      }
      response.end(
        JSON.stringify({
          id,
          object: "file",
          filename: file.filename,
          bytes: file.data.length,
          created_at: 1,
          purpose: "user_data",
          status: "processed",
          ...(file.expires_at && { expires_at: file.expires_at }),
        }),
      );
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("No upstream port");
    config.llm.azure.entraIdEnabled = false;
    config.llm.azure.baseUrl = "https://unselected.example/openai/v1";
    config.llmProxy.plugins = [];
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const secret = await makeSecret({
      secret: { apiKey: "fixture-file-provider-key" },
    });
    const providerKey = await makeLlmProviderApiKey(
      agent.organizationId,
      secret.id,
      {
        provider: "azure",
        baseUrl: `http://127.0.0.1:${address.port}/openai/v1`,
      },
    );
    const createKey = (name: string) =>
      VirtualApiKeyModel.create({
        organizationId: agent.organizationId,
        name,
        providerApiKeys: [
          { provider: "azure", providerApiKeyId: providerKey.id },
        ],
      });
    const first = await createKey("file owner");
    const second = await createKey("other file owner");
    const app = createFastifyInstance();
    await app.register(azureRoutes);
    const local = await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `${local}/v1/azure`;
    try {
      await use({
        client: new OpenAI({
          baseURL: base,
          apiKey: first.value,
          maxRetries: 0,
        }),
        other: new OpenAI({
          baseURL: base,
          apiKey: second.value,
          maxRetries: 0,
        }),
        agentId: agent.id,
        base,
        token: first.value,
        providerKeyId: providerKey.id,
        virtualKeyId: first.virtualKey.id,
        calls,
        remote,
        failure: (status, bad = false) => {
          failure = status;
          invalidMetadata = bad;
        },
      });
    } finally {
      vi.useRealTimers();
      await app.close();
      await new Promise<void>((done) => upstream.close(() => done()));
    }
  },
});

test("real SDK file lifecycle preserves arbitrary bytes and uses scoped local handles", async ({
  files,
}) => {
  const bytes = Buffer.from([0, 255, 1, 128, 13, 10, 0, 127]);
  const file = await files.client.files.create({
    file: await toFile(bytes, "fixture.bin"),
    purpose: "user_data",
  });
  expect(file.id).toMatch(/^file-archestra-/);
  expect(file.bytes).toBe(bytes.length);
  expect([...files.remote.values()][0].data).toEqual(bytes);
  expect((await files.client.files.retrieve(file.id)).id).toBe(file.id);
  expect((await files.client.files.list()).data.map((item) => item.id)).toEqual(
    [file.id],
  );
  const content = await files.client.files.content(file.id);
  expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes);
  expect(content.headers.get("content-disposition")).toContain("attachment");
  expect((await files.client.files.delete(file.id)).deleted).toBe(true);
  expect(files.remote.size).toBe(0);
  const calls = files.calls.length;
  await expect(files.client.files.retrieve(file.id)).rejects.toMatchObject({
    status: 404,
  });
  expect(files.calls).toHaveLength(calls);
  expect(
    await InteractionModel.getAllInteractionsForProfile(files.agentId),
  ).toEqual([]);
});

test("same-account callers cannot list, retrieve, download, or delete another principal's file", async ({
  files,
}) => {
  const file = await files.client.files.create({
    file: await toFile(Buffer.from("private fixture"), "fixture.txt"),
    purpose: "user_data",
  });
  const count = files.calls.length;
  expect((await files.other.files.list()).data).toEqual([]);
  for (const action of [
    () => files.other.files.retrieve(file.id),
    () => files.other.files.content(file.id),
    () => files.other.files.delete(file.id),
  ])
    await expect(action()).rejects.toMatchObject({ status: 404 });
  expect(files.calls).toHaveLength(count);
  expect(files.remote.size).toBe(1);
});

test.for([
  "agent",
  "virtual_key",
] as const)("blocks unpriced file uploads under %s financial budgets", async (entityType, {
  files,
}) => {
  await LimitModel.create({
    entityType,
    entityId: entityType === "agent" ? files.agentId : files.virtualKeyId,
    limitType: "token_cost",
    limitValue: 100,
    model: [],
    lastCleanup: new Date(),
  });
  await expect(
    files.client.files.create({
      file: await toFile(Buffer.from("fixture"), "fixture.bin"),
      purpose: "user_data",
    }),
  ).rejects.toMatchObject({ status: 422 });
  expect(files.calls).toHaveLength(0);
});

test("blocks file uploads under enforced accounting", async ({ files }) => {
  config.llmProxy.usageAccountingMode = "enforce";
  await expect(
    files.client.files.create({
      file: await toFile(Buffer.from("fixture"), "fixture.bin"),
      purpose: "user_data",
    }),
  ).rejects.toMatchObject({ status: 422 });
  expect(files.calls).toHaveLength(0);
});

test("account configuration changes and expired handles fail before upstream reads", async ({
  files,
}) => {
  const file = await files.client.files.create({
    file: await toFile(Buffer.from("fixture"), "fixture.bin"),
    purpose: "user_data",
    expires_after: { anchor: "created_at", seconds: 3600 },
  });
  const count = files.calls.length;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 7_200_000);
  await expect(files.client.files.content(file.id)).rejects.toMatchObject({
    status: 404,
  });
  expect((await files.client.files.list()).data).toEqual([]);
  vi.useRealTimers();
  await LlmProviderApiKeyModel.update(files.providerKeyId, {
    baseUrl: "http://127.0.0.1:1/openai/v1",
  });
  await expect(files.client.files.retrieve(file.id)).rejects.toMatchObject({
    status: 404,
  });
  expect(files.calls).toHaveLength(count);
});

test("rejects anonymous, unsupported purposes and inference file references without reaching upstream", async ({
  files,
}) => {
  const upload = await toFile(Buffer.from("fixture"), "fixture.bin");
  await expect(
    files.client
      .withOptions({ apiKey: "invalid-key" })
      .files.create({ file: upload, purpose: "user_data" }),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    files.client.files.create({ file: upload, purpose: "fine-tune" }),
  ).rejects.toMatchObject({ status: 400 });
  const response = await fetch(`${files.base}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${files.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file_id: "file-archestra-00000000-0000-0000-0000-000000000000",
            },
          ],
        },
      ],
    }),
  });
  expect(response.status).toBe(400);
  expect(files.calls).toHaveLength(0);
});

test("rolls back a remote upload when metadata cannot be safely registered", async ({
  files,
}) => {
  files.failure(null, true);
  await expect(
    files.client.files.create({
      file: await toFile(Buffer.from("fixture"), "fixture.bin"),
      purpose: "user_data",
    }),
  ).rejects.toMatchObject({ status: 502 });
  expect(files.calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
  expect(files.remote.size).toBe(0);
  expect((await files.client.files.list()).data).toEqual([]);
});

test.for([
  400, 429, 500,
])("relays file upstream %i once and redacts credential echoes", async (status, {
  files,
}) => {
  files.failure(status);
  try {
    await files.client.files.create({
      file: await toFile(Buffer.from("fixture"), "fixture.bin"),
      purpose: "user_data",
    });
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toMatchObject({ status });
    expect(JSON.stringify(error)).not.toContain("fixture-file-provider-key");
  }
  expect(files.calls).toHaveLength(1);
});

test("rejects an empty upstream upload response without inventing a handle", async ({
  files,
}) => {
  files.failure(204);
  await expect(
    files.client.files.create({
      file: await toFile(Buffer.from("fixture"), "fixture.bin"),
      purpose: "user_data",
    }),
  ).rejects.toMatchObject({ status: 502 });
  expect(files.calls).toHaveLength(1);
  expect((await files.client.files.list()).data).toEqual([]);
});

test("rejects missing provider content or deletion confirmation without deleting the ledger", async ({
  files,
}) => {
  const file = await files.client.files.create({
    file: await toFile(Buffer.from("fixture"), "fixture.bin"),
    purpose: "user_data",
  });
  files.failure(204);
  await expect(files.client.files.content(file.id)).rejects.toMatchObject({
    status: 409,
  });
  await expect(files.client.files.delete(file.id)).rejects.toMatchObject({
    status: 502,
  });
  files.failure(null);
  expect((await files.client.files.retrieve(file.id)).id).toBe(file.id);
  expect(files.remote.size).toBe(1);
});

test("current external Python and JavaScript SDK file APIs make byte-exact full lifecycle roundtrips", async ({
  files,
}) => {
  await files.client.files.list();
  if (!process.env.MEDIA_PYTHON || !process.env.MEDIA_SDK_ENTRY) return;
  const directory = await mkdtemp(join(tmpdir(), "files-sdk-"));
  const bytes = Buffer.from([0, 1, 255, 128, 10, 13, 0]);
  const image = join(directory, "fixture.bin");
  await writeFile(image, bytes);
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
            MEDIA_SDK_BASE_URL: files.base,
            MEDIA_SDK_API_KEY: files.token,
            MEDIA_SDK_IMAGE: image,
            MEDIA_SDK_OPERATION: "files",
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
    if (results.some((item) => item.status !== 200))
      throw new Error(JSON.stringify(results));
    expect(results.map((item) => item.status)).toEqual([200, 200, 200, 200]);
    expect(results.map((item) => item.response.content)).toEqual([
      bytes.toString("base64"),
      bytes.toString("base64"),
      bytes.toString("base64"),
      bytes.toString("base64"),
    ]);
    expect(files.remote.size).toBe(0);
    if (process.env.MEDIA_EVIDENCE_PATH)
      await writeFile(
        process.env.MEDIA_EVIDENCE_PATH,
        JSON.stringify(
          {
            versions: { javascript: "7.41.0", python: "3.36.0" },
            results,
            upstreamCalls: files.calls,
          },
          null,
          2,
        ),
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
