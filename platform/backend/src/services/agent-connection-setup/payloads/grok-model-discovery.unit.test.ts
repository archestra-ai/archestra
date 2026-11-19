import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { GROK_MODEL_DISCOVERY } from "./grok-model-discovery";

function fixture() {
  const state = {
    recommendation: "grok-4.7",
    models: [
      { id: "grok-4.7", created: 30 },
      { id: "grok-4.6", created: 20 },
      { id: "grok-4.20-0309-reasoning", created: 10 },
    ],
    unsupported: new Set<string>(),
  };
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/models.md"))
      return new Response(
        `### Text API Pricing\n| grok-4.20-0309-reasoning | text |\n| grok-4.6 | text |\n| grok-4.7 | text |\n### Other\nCode: [Recommended](/developers/models/${state.recommendation})\n`,
      );
    if (
      url === "https://proxy.example/v1/proxy/xai/models" ||
      url === "http://127.0.0.1:9002/v1/proxy/xai/models"
    ) {
      expect(options?.headers).toMatchObject({
        Authorization: "Bearer synthetic-local-key",
      });
      return new Response(JSON.stringify({ data: state.models }));
    }
    const name = url.split("/").at(-1)?.replace(/\.md$/, "");
    return new Response(
      `**Model name:** \`${name}\`\r\n**Modalities:** text, image → text\r\n**Function calling:** ${state.unsupported.has(name || "") ? "No" : "Yes"}\r\n`,
    );
  });
  const run = (options = {}) =>
    runInNewContext(`${GROK_MODEL_DISCOVERY}\ndiscoverGrokModel(options)`, {
      options: {
        modelsUrl: "https://proxy.example/v1/proxy/xai/models",
        ...options,
      },
      process: { env: { XAI_API_KEY: "synthetic-local-key" } },
      Buffer,
      AbortSignal,
      URL,
      Headers,
      Response,
      require: createRequire(import.meta.url),
      fetch,
    }) as Promise<{ model: string; selectedBy: string }>;
  return { state, fetch, run };
}

test("uses live coding recommendations and account availability without code changes, numeric-version sorting or caching a stale recommendation", async () => {
  const current = fixture();
  current.state.recommendation = "grok-4.6";
  expect(await current.run()).toMatchObject({
    model: "grok-4.6",
    selectedBy: "official-coding-recommendation",
  });
  current.state.recommendation = "grok-4.7";
  expect(await current.run()).toMatchObject({ model: "grok-4.7" });
  current.state.recommendation = "grok-5";
  current.state.models.push({ id: "grok-5", created: 40 });
  expect(await current.run()).toMatchObject({ model: "grok-5" });
  for (const [url, options] of current.fetch.mock.calls)
    if (url.startsWith("https://docs.x.ai/"))
      expect(options?.headers).toBeUndefined();
});

test("falls back to verified available text/tool models by provider release timestamp, not the larger 4.20 version string", async () => {
  const current = fixture();
  current.state.models = current.state.models.filter(
    (model) => model.id !== "grok-4.7",
  );
  expect(await current.run()).toMatchObject({
    model: "grok-4.6",
    selectedBy: "available-release-timestamp",
  });
  current.state.unsupported.add("grok-4.6");
  expect(await current.run()).toMatchObject({
    model: "grok-4.20-0309-reasoning",
  });
});

test("never chooses unverified models, plan-only Fast, media, embedding or multi-agent candidates", async () => {
  const current = fixture();
  current.state.models = [
    "grok-fast",
    "grok-image",
    "grok-voice",
    "grok-embedding",
    "grok-4.20-multi-agent",
    "private-model",
  ].map((id) => ({ id, created: 999 }));
  await expect(current.run()).rejects.toThrow("No available xAI coding model");
});

test("rejects model IDs that could alter an endpoint and refuses redirect replay on every discovery request", async () => {
  const current = fixture();
  current.state.models = [{ id: "../grok-4.7?key=secret", created: 999 }];
  await expect(current.run()).rejects.toThrow("No available xAI coding model");
  const valid = fixture();
  await valid.run();
  expect(
    valid.fetch.mock.calls.every(
      ([, options]) =>
        options?.redirect === "error" &&
        options?.cache === "no-store" &&
        options?.signal,
    ),
  ).toBe(true);
});

test("offline, malformed or missing release metadata fails explicitly without using a stale or static fallback", async () => {
  const current = fixture();
  await current.run();
  current.fetch.mockRejectedValue(new Error("network failure"));
  await expect(current.run()).rejects.toThrow("unavailable");
  const missing = fixture();
  missing.state.models = [{ id: "grok-4.6", created: 0 }];
  await expect(missing.run()).rejects.toThrow("No available");
});

test.each([
  "http://external.example/models",
  "http://stack2.localhost.external.example/models",
  "http://notlocalhost/models",
  "ftp://stack2.localhost/models",
  "https://user:secret@proxy.example/models",
  "https://proxy.example/other",
  "https://proxy.example/models?key=secret",
])("refuses unapproved credential transports before fetching: %s", async (modelsUrl) => {
  const current = fixture();
  await expect(current.run({ modelsUrl })).rejects.toThrow("approved HTTPS");
  expect(current.fetch).not.toHaveBeenCalled();
});

test("routes named localhost discovery to loopback while preserving the proxy host and credentials", async () => {
  const current = fixture();
  const requests: { host?: string; authorization?: string; agent?: string }[] =
    [];
  const server = createServer((request, response) => {
    requests.push({
      host: request.headers.host,
      authorization: request.headers.authorization,
      agent: request.headers["x-archestra-agent-id"] as string | undefined,
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: current.state.models }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `stack2.localhost:${(server.address() as { port: number }).port}`;
  try {
    expect(
      await current.run({
        modelsUrl: `http://${host}/v1/proxy/xai/models`,
        headers: { "X-Archestra-Agent-Id": "grok-build" },
      }),
    ).toMatchObject({ model: "grok-4.7" });
    expect(requests).toEqual([
      {
        host,
        authorization: "Bearer synthetic-local-key",
        agent: "grok-build",
      },
    ]);
    for (const [, options] of current.fetch.mock.calls)
      expect(options?.headers).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("limits response bytes and never puts raw authentication errors or malformed responses in output", async () => {
  const current = fixture();
  current.fetch.mockResolvedValue(new Response("x".repeat(1048577)));
  await expect(current.run()).rejects.toThrow("size limit");
  const invalid = fixture();
  invalid.fetch.mockImplementation(async (url: string) =>
    url.endsWith("/models.md")
      ? new Response("Code: [Code](/developers/models/grok-4.7)")
      : new Response("synthetic-local-key malformed response"),
  );
  await expect(invalid.run()).rejects.toThrow("invalid JSON");
});

import { createServer } from "node:http";
import { createRequire } from "node:module";
