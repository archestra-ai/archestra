import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  renderOpenCodeRoutingPlugin,
  renderOpenCodeRoutingPluginV2,
} from "./opencode-routing-plugin";

const roots: string[] = [];
const globals = globalThis as unknown as Record<PropertyKey, unknown>;
const fetchGuard = Symbol.for("archestra.opencode.llmProxyFetchGuard");
const directFetch = Symbol.for("archestra.opencode.directFetch");
let originalFetch: typeof fetch;
let originalGuard: unknown;
let originalDirect: unknown;
let originalDataHome: string | undefined;
let originalHome: string | undefined;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalGuard = globals[fetchGuard];
  originalDirect = globals[directFetch];
  originalDataHome = process.env.XDG_DATA_HOME;
  originalHome = process.env.HOME;
  delete globals[fetchGuard];
  delete globals[directFetch];
});
const managedRoute = "https://deployment.example/v1/model-router/agent";
const nativeRoute = "https://deployment.example/v1/openai/agent";
const catalog = {
  providers: {
    "archestra-vendor": {
      name: "Vendor",
      npm: "@ai-sdk/openai" as const,
      options: { baseURL: managedRoute },
      models: {
        "fixture/model": {
          name: "Fixture",
          id: "vendor:fixture/model",
          limit: { context: 1000, output: 100 },
        },
      },
    },
  },
  routes: {
    "archestra-vendor": managedRoute,
    openai: nativeRoute,
  },
  twins: { vendor: "archestra-vendor" },
};

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalGuard === undefined) delete globals[fetchGuard];
  else globals[fetchGuard] = originalGuard;
  if (originalDirect === undefined) delete globals[directFetch];
  else globals[directFetch] = originalDirect;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed catalog plugin", () => {
  test("keeps native credentials and strips managed-alias headers across repeated config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-"));
    roots.push(root);
    process.env.XDG_DATA_HOME = path.join(root, "data");
    process.env.HOME = root;
    const revision = path.join(root, "revision");
    await mkdir(revision);
    const keyPath = path.join(root, ".archestra", "opencode-primary.key");
    await mkdir(path.dirname(keyPath));
    await writeFile(keyPath, "managed-secret\n", { mode: 0o600 });
    await writeFile(
      path.join(root, "params.json"),
      JSON.stringify({
        routes: { openai: "https://old.example/v1/openai" },
        headers: { "X-Archestra-Agent-Id": "opencode" },
        routeHeaders: {
          openai: {
            "X-Archestra-Virtual-Key": "passthrough-secret",
            Authorization: "Bearer passthrough-secret",
          },
        },
        providerTwins: {},
        clientId: "opencode",
        origin: "https://deployment.example",
        skipRelpath: ".archestra/skip",
        source: { token: "cru1_test" },
        mcp: null,
      }),
    );
    const file = path.join(revision, "routing.mjs");
    await writeFile(
      file,
      renderOpenCodeRoutingPlugin({
        runtime: true,
        routes: {},
        headers: {},
        catalog,
      }),
    );
    const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const hooks = await module.ArchestraLlmProxy();
    const config = () => ({
      model: "vendor/fixture/model",
      small_model: "vendor/retired",
      provider: {
        vendor: {
          options: {
            apiKey: "stale-native",
            headers: {
              Authorization: "Bearer stale-native",
              "ChatGPT-Account-Id": "acct",
            },
          },
          models: { retired: { id: "retired" } },
        },
        openai: {
          npm: "@ai-sdk/openai",
          options: { apiKey: "user-openai-key" },
          models: { "user-inventory": { name: "kept" } },
        },
      },
    });
    const first = config();
    await hooks.config(first);
    const second = config();
    second.provider.vendor.options.apiKey =
      first.provider.vendor.options.apiKey;
    await hooks.config(second);
    expect(first.model).toBe("vendor/fixture/model");
    expect(first).not.toHaveProperty("small_model");
    expect(first.provider.vendor).toMatchObject({
      whitelist: ["fixture/model"],
      options: { apiKey: "managed-secret", baseURL: managedRoute, headers: {} },
      models: {
        "fixture/model": { id: "vendor:fixture/model" },
      },
    });
    expect(JSON.stringify(first.provider.vendor)).not.toContain(
      "passthrough-secret",
    );
    expect(JSON.stringify(first.provider.vendor)).not.toContain(
      "ChatGPT-Account-Id",
    );
    expect(first.provider.openai).toMatchObject({
      npm: "@ai-sdk/openai",
      options: { apiKey: "user-openai-key" },
      models: { "user-inventory": { name: "kept" } },
    });
    expect(second.provider.vendor.options.apiKey).toBe("managed-secret");
    expect(second.provider.vendor.models).not.toHaveProperty("retired");
    expect(second.provider.openai.options.apiKey).toBe("user-openai-key");
  });

  test("V2 sets the wire id on the SDK model and does not copy the passthrough key onto an alias", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-v2-"));
    roots.push(root);
    const revision = path.join(root, "revision");
    await mkdir(path.join(revision, "node_modules", "@opencode", "plugin"), {
      recursive: true,
    });
    await writeFile(
      path.join(
        revision,
        "node_modules",
        "@opencode",
        "plugin",
        "package.json",
      ),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      path.join(revision, "node_modules", "@opencode", "plugin", "index.js"),
      `export const Provider = { ID: { make: (id) => id }, Info: { empty: (id) => ({ id, activation: "auto" }) } };
export const Model = { ID: { make: (id) => id }, Info: { default: (providerID, id) => ({ id, modelID: id, providerID, limit: { context: 1, output: 1 } }) } };`,
    );
    const keyPath = path.join(root, "managed.key");
    await writeFile(keyPath, "managed-secret\n", { mode: 0o600 });
    await writeFile(
      path.join(root, "params.json"),
      JSON.stringify({
        routes: {},
        headers: { "X-Archestra-Agent-Id": "opencode" },
        routeHeaders: {
          openai: { "X-Archestra-Virtual-Key": "passthrough-secret" },
        },
        managedKeyPath: keyPath,
        clientId: "opencode",
        origin: "https://deployment.example",
        source: { token: "cru1_test" },
      }),
    );
    await writeFile(
      path.join(revision, "routing.mjs"),
      renderOpenCodeRoutingPluginV2({
        runtime: true,
        routes: {},
        headers: {},
        catalog,
      }),
    );
    const result = await run(path.join(revision, "routing.mjs"));
    expect(result.vendor.provider.settings).toMatchObject({
      apiKey: "managed-secret",
      baseURL: managedRoute,
    });
    expect(result.vendor.provider.headers).not.toHaveProperty(
      "X-Archestra-Virtual-Key",
    );
    expect(result.vendor.models["fixture/model"]).toMatchObject({
      id: "fixture/model",
      modelID: "vendor:fixture/model",
    });
    expect(result.openai.provider.settings).toEqual({
      apiKey: "user-openai-key",
    });
    expect(result.openai.models).toEqual({
      "user-inventory": { id: "user-inventory" },
    });
    expect(result.calls.filter((call) => call === "models.set:vendor")).toEqual(
      ["models.set:vendor", "models.set:vendor"],
    );
  });
});

function run(file: string): Promise<{
  vendor: {
    provider: {
      settings: Record<string, string>;
      headers: Record<string, string>;
    };
    models: Record<string, { id: string; modelID: string }>;
  };
  openai: {
    provider: { settings: Record<string, string> };
    models: Record<string, { id: string }>;
  };
  calls: string[];
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const plugin = (await import(${JSON.stringify(pathToFileURL(file).href)})).default;
const calls = [];
const providers = new Map([
  ["openai", { provider: { id: "openai", settings: { apiKey: "user-openai-key" }, headers: {} }, models: new Map([["user-inventory", { id: "user-inventory" }]]) }],
  ["vendor", { provider: { id: "vendor", settings: { apiKey: "stale" }, headers: { Authorization: "Bearer stale", "ChatGPT-Account-Id": "acct" } }, models: new Map([["retired", { id: "retired" }]]) }],
]);
const editor = {
  list: () => [...providers.values()],
  get: (id) => providers.get(id),
  add: ({ info, models }) => { calls.push("add:" + info.id); providers.set(info.id, { provider: info, models: new Map(models.map((model) => [model.id, model])) }); },
  update: (id, update) => { calls.push("update:" + id); update(providers.get(id).provider); },
  models: { set: (id, models) => { calls.push("models.set:" + id); providers.get(id).models = new Map(models.map((model) => [model.id, model])); } },
};
await plugin.setup({ provider: { transform: async (callback) => callback(editor) }, session: { hook: async () => {} } });
await plugin.setup({ provider: { transform: async (callback) => callback(editor) }, session: { hook: async () => {} } });
const pack = (id) => ({ provider: providers.get(id).provider, models: Object.fromEntries(providers.get(id).models) });
console.log(JSON.stringify({ vendor: pack("vendor"), openai: pack("openai"), calls }));`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || stdout));
      else resolve(JSON.parse(stdout));
    });
  });
}
