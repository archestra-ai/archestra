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
let originalCacheHome: string | undefined;
let originalHome: string | undefined;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalGuard = globals[fetchGuard];
  originalDirect = globals[directFetch];
  originalDataHome = process.env.XDG_DATA_HOME;
  originalCacheHome = process.env.XDG_CACHE_HOME;
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
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
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

  test("refuses Gemini generateContent on a managed alias and sends OpenAI transport to the model router", async () => {
    const calls: string[] = [];
    globals[directFetch] = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      calls.push(
        `${request.url} auth=${request.headers.get("authorization")} goog=${request.headers.get("x-goog-api-key")}`,
      );
      return new Response("ok");
    };
    const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-google-"));
    roots.push(root);
    process.env.XDG_DATA_HOME = path.join(root, "data");
    process.env.HOME = root;
    await mkdir(path.join(root, "data", "opencode"), { recursive: true });
    await writeFile(
      path.join(root, "data", "opencode", "auth.json"),
      JSON.stringify({
        google: { type: "oauth", access: "native-google-token", refresh: "r" },
      }),
    );
    await mkdir(path.join(root, ".archestra"));
    await writeFile(
      path.join(root, ".archestra", "opencode-primary.key"),
      "managed-secret\n",
    );
    const revision = path.join(root, "revision");
    await mkdir(revision);
    await writeFile(
      path.join(root, "params.json"),
      JSON.stringify({
        routes: { google: "https://old.example/v1/gemini/stale" },
        headers: { "X-Archestra-Agent-Id": "opencode" },
        routeHeaders: {
          google: { "X-Archestra-Virtual-Key": "passthrough-secret" },
        },
        clientId: "opencode",
        origin: "https://deployment.example",
        skipRelpath: ".archestra/skip",
        source: { token: "cru1_test" },
      }),
    );
    const file = path.join(revision, "routing.mjs");
    await writeFile(
      file,
      renderOpenCodeRoutingPlugin({
        runtime: true,
        routes: {},
        headers: {},
        catalog: {
          providers: {
            "archestra-gemini": {
              name: "Gemini",
              npm: "@ai-sdk/openai",
              options: { baseURL: managedRoute },
              models: {
                "gem-x": { name: "Gem", id: "gemini:gem-x" },
              },
            },
          },
          routes: { "archestra-gemini": managedRoute },
          twins: { google: "archestra-gemini" },
        },
      }),
    );
    const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const hooks = await module.ArchestraLlmProxy();
    await hooks.config({
      provider: { google: { npm: "@ai-sdk/google", options: {} } },
    });
    const auth = await hooks.auth.loader(async () => ({
      type: "oauth",
      access: "native-google-token",
    }));
    await expect(
      auth.fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/foo:generateContent",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer native-google-token",
            "x-goog-api-key": "native-google-token",
          },
          body: "{}",
        },
      ),
    ).rejects.toThrow("does not accept Gemini generateContent");
    expect(calls).toEqual([]);
    await auth.fetch(`${managedRoute}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer native-google-token",
        "x-goog-api-key": "native-google-token",
      },
      body: "{}",
    });
    expect(calls).toEqual([
      `${managedRoute}/chat/completions auth=Bearer managed-secret goog=null`,
    ]);
  });

  test("a supplied empty catalog is authoritative and an omitted catalog is not", async () => {
    expect(
      renderOpenCodeRoutingPlugin({
        routes: { openai: "https://old.example/v1/openai/stale-agent" },
        headers: {},
        catalog: { providers: {}, routes: {}, twins: {} },
      }),
    ).toContain("const hasCatalog = true");
    expect(renderOpenCodeRoutingPlugin({ routes: {}, headers: {} })).toContain(
      "const hasCatalog = false",
    );
    const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-empty-"));
    roots.push(root);
    process.env.HOME = root;
    const revision = path.join(root, "revision");
    await mkdir(revision);
    await writeFile(
      path.join(root, "params.json"),
      JSON.stringify({
        routes: { openai: "https://old.example/v1/openai/stale-agent" },
        headers: {},
        clientId: "opencode",
        origin: "https://deployment.example",
        source: { token: "cru1_test" },
      }),
    );
    const file = path.join(revision, "routing.mjs");
    await writeFile(
      file,
      renderOpenCodeRoutingPlugin({
        runtime: true,
        routes: {},
        headers: {},
        catalog: { providers: {}, routes: {}, twins: {} },
      }),
    );
    const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const hooks = await module.ArchestraLlmProxy();
    const config: { enabled_providers?: string[]; provider: object } = {
      provider: {},
    };
    await hooks.config(config);
    expect(config.enabled_providers).toEqual([]);
    expect(JSON.stringify(config)).not.toContain("stale-agent");
  });

  test("V2 strips native OAuth after the request hook when the alias has no native route", async () => {
    const result = await runAlias(false);
    expect(result.hook).toMatchObject({
      baseURL: managedRoute,
      Authorization: "Bearer managed-secret",
    });
    expect(result.hook).not.toHaveProperty("ChatGPT-Account-Id");
    expect(result.hook).not.toHaveProperty("x-goog-api-key");
    expect(result.hook).not.toHaveProperty("x-archestra-opencode-oauth-bridge");
    expect(result.sourceConnection).toEqual({ id: "oauth" });
    expect(result.finalUrl).toBe(`${managedRoute}/responses`);
    expect(result.finalAuth).toBe("Bearer managed-secret");
    expect(result.finalAccount).toBeNull();
    expect(result.finalBridge).toBeNull();
    expect(result.finalGoog).toBeNull();
    expect(result.keptUrl).toBe(`${managedRoute}/chat/completions`);
    expect(result.keptAuth).toBe("Bearer managed-secret");
    expect(result.redirect).toBe("error");
  });

  test("V2 keeps a real native route credential ahead of the managed alias", async () => {
    const result = await runAlias(true);
    expect(result.hook.Authorization).toBe("Bearer native-openai-token");
    expect(result.hook["x-archestra-opencode-oauth-bridge"]).toBe("true");
    expect(result.hook.Authorization).not.toBe("Bearer managed-secret");
    expect(result.finalUrl).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(result.finalAuth).toBe("Bearer native-openai-token");
    expect(result.finalAccount).toBe("acct");
  });

  test("a managed alias keeps the client's provider label and names the catalog provider that serves it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-labels-"));
    roots.push(root);
    process.env.HOME = root;
    process.env.XDG_DATA_HOME = path.join(root, "data");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    await mkdir(path.join(root, "cache", "opencode"), { recursive: true });
    await writeFile(
      path.join(root, "cache", "opencode", "models.json"),
      JSON.stringify({
        moonshotai: { id: "moonshotai", name: "Moonshot AI", models: {} },
        "kimi-code-plan-global": {
          id: "kimi-code-plan-global",
          name: "Kimi For Coding (kimi.ai)",
          models: {},
        },
      }),
    );
    await mkdir(path.join(root, ".archestra"));
    await writeFile(
      path.join(root, ".archestra", "opencode-primary.key"),
      "managed-secret\n",
    );
    const revision = path.join(root, "revision");
    await mkdir(revision);
    await writeFile(
      path.join(root, "params.json"),
      JSON.stringify({
        routes: {},
        headers: {},
        clientId: "opencode",
        origin: "https://deployment.example",
        source: { token: "cru1_test" },
      }),
    );
    const file = path.join(revision, "routing.mjs");
    await writeFile(
      file,
      renderOpenCodeRoutingPlugin({
        runtime: true,
        routes: {},
        headers: {},
        catalog: kimiCatalog,
      }),
    );
    const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const hooks = await module.ArchestraLlmProxy();
    const config = () => ({
      provider: {
        "kimi-code-plan-cn": { name: "My Kimi plan" },
      } as Record<string, { name?: string }>,
    });
    await hooks.config(config());
    const second = config();
    await hooks.config(second);
    expect(
      Object.fromEntries(
        Object.entries(second.provider).map(([id, entry]) => [id, entry.name]),
      ),
    ).toEqual(kimiLabels);
  });

  test("V2 gives a managed alias the client's provider label and the catalog provider that serves it", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "catalog-plugin-v2-labels-"),
    );
    roots.push(root);
    const revision = path.join(root, "revision");
    await writeFakeOpenCodePluginSdk(revision);
    const keyPath = path.join(root, "managed.key");
    await writeFile(keyPath, "managed-secret\n", { mode: 0o600 });
    await writeFile(
      path.join(root, "params.json"),
      JSON.stringify({
        routes: {},
        headers: {},
        managedKeyPath: keyPath,
        clientId: "opencode",
        origin: "https://deployment.example",
        source: { token: "cru1_test" },
      }),
    );
    const file = path.join(revision, "routing.mjs");
    await writeFile(
      file,
      renderOpenCodeRoutingPluginV2({
        runtime: true,
        routes: {},
        headers: {},
        catalog: kimiCatalog,
      }),
    );
    expect(
      await runProviderNames(file, {
        moonshotai: "Moonshot AI",
        "kimi-code-plan-global": "Kimi For Coding (kimi.ai)",
        "kimi-code-plan-cn": "My Kimi plan",
      }),
    ).toEqual(kimiLabels);
  });
});

const kimiRoute = "https://deployment.example/v1/kimi/agent";
const kimiCatalog = {
  providers: {
    "archestra-kimi": {
      name: "Moonshot (Kimi)",
      npm: "@ai-sdk/openai-compatible" as const,
      options: { baseURL: kimiRoute },
      models: { "kimi-k3": { name: "kimi-k3", id: "kimi-k3" } },
    },
  },
  routes: { "archestra-kimi": kimiRoute },
  twins: {
    kimi: "archestra-kimi",
    moonshotai: "archestra-kimi",
    "kimi-code-plan-global": "archestra-kimi",
    "kimi-code-plan-cn": "archestra-kimi",
  },
};
// Every row serves the same Archestra models, so only the label tells them
// apart: the client's own name for the provider (its models.dev entry, else a
// name the user configured, else the id) and the catalog provider behind it.
const kimiLabels = {
  "archestra-kimi": "Moonshot (Kimi)",
  kimi: "kimi via Moonshot (Kimi)",
  moonshotai: "Moonshot AI via Moonshot (Kimi)",
  "kimi-code-plan-global": "Kimi For Coding (kimi.ai) via Moonshot (Kimi)",
  "kimi-code-plan-cn": "My Kimi plan via Moonshot (Kimi)",
};

async function writeFakeOpenCodePluginSdk(revision: string) {
  const sdk = path.join(revision, "node_modules", "@opencode", "plugin");
  await mkdir(sdk, { recursive: true });
  await writeFile(
    path.join(sdk, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    path.join(sdk, "index.js"),
    `export const Provider = { ID: { make: (id) => id }, Info: { empty: (id) => ({ id, activation: "auto" }) } };
export const Model = { ID: { make: (id) => id }, Info: { default: (providerID, id) => ({ id, modelID: id, providerID, limit: { context: 1, output: 1 } }) } };`,
  );
}

/** Runs the V2 transform twice over providers the client already lists. */
function runProviderNames(
  file: string,
  names: Record<string, string>,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const plugin = (await import(${JSON.stringify(pathToFileURL(file).href)})).default;
const providers = new Map(Object.entries(${JSON.stringify(names)}).map(([id, name]) => [id, { provider: { id, name, settings: {}, headers: {} }, models: new Map() }]));
const editor = {
  list: () => [...providers.values()],
  get: (id) => providers.get(id),
  add: ({ info, models }) => { providers.set(info.id, { provider: info, models: new Map(models.map((model) => [model.id, model])) }); },
  update: (id, update) => { update(providers.get(id).provider); },
  models: { set: (id, models) => { providers.get(id).models = new Map(models.map((model) => [model.id, model])); } },
};
for (let pass = 0; pass < 2; pass++) await plugin.setup({ provider: { transform: async (callback) => callback(editor) }, session: { hook: async () => {} } });
console.log(JSON.stringify(Object.fromEntries([...providers].map(([id, record]) => [id, record.provider.name]))));`,
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

async function prepareAlias(nativeRouteAllowed: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-alias-"));
  roots.push(root);
  const revision = path.join(root, "revision");
  await mkdir(path.join(revision, "node_modules", "@opencode", "plugin"), {
    recursive: true,
  });
  await writeFile(
    path.join(revision, "node_modules", "@opencode", "plugin", "package.json"),
    JSON.stringify({ type: "module", exports: "./index.js" }),
  );
  await writeFile(
    path.join(revision, "node_modules", "@opencode", "plugin", "index.js"),
    `export const Provider = { ID: { make: (id) => id }, Info: { empty: (id) => ({ id, activation: "auto" }) } };
export const Model = { ID: { make: (id) => id }, Info: { default: (providerID, id) => ({ id, modelID: id, providerID, limit: { context: 1, output: 1 } }) } };`,
  );
  const keyPath = path.join(root, "managed.key");
  await writeFile(keyPath, "managed-secret\n");
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
  const routes: Record<string, string> = {
    "archestra-openai": managedRoute,
  };
  if (nativeRouteAllowed) routes.openai = nativeRoute;
  await writeFile(
    path.join(revision, "routing.mjs"),
    renderOpenCodeRoutingPluginV2({
      runtime: true,
      routes: {},
      headers: {},
      catalog: {
        providers: {
          "archestra-openai": {
            name: "OpenAI",
            npm: "@ai-sdk/openai",
            options: { baseURL: managedRoute },
            models: { "gpt-x": { name: "GPT", id: "openai:gpt-x" } },
          },
        },
        routes,
        twins: { openai: "archestra-openai" },
      },
    }),
  );
  return path.join(revision, "routing.mjs");
}

function runAlias(nativeRouteAllowed: boolean): Promise<{
  hook: Record<string, string>;
  sourceConnection: { id: string } | null;
  finalUrl: string;
  finalAuth: string | null;
  finalAccount: string | null;
  finalBridge: string | null;
  finalGoog: string | null;
  keptUrl: string;
  keptAuth: string | null;
  redirect: string;
}> {
  return prepareAlias(nativeRouteAllowed).then(
    (file) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const plugin = (await import(${JSON.stringify(pathToFileURL(file).href)})).default;
const providers = new Map([
  ["openai", { provider: { id: "openai", activation: "disabled", settings: { apiKey: "native-user-key" }, headers: { Authorization: "Bearer native-user-key" } }, models: new Map(), sourceConnection: { id: "oauth" } }],
]);
const editor = {
  list: () => [...providers.values()],
  get: (id) => providers.get(id),
  add: ({ info, models }) => providers.set(info.id, { provider: info, models: new Map(models.map((model) => [model.id, model])) }),
  update: (id, update) => update(providers.get(id).provider),
  models: { set: (id, models) => { providers.get(id).models = new Map(models.map((model) => [model.id, model])); } },
};
let modelRequest;
let httpRequest;
await plugin.setup({
  provider: { transform: async (callback) => callback(editor) },
  session: { hook: async (name, callback) => { if (name === "model.request") modelRequest = callback; if (name === "http.request") httpRequest = callback; } },
}, () => ({ "x-archestra-client-runtime-token": "session-proof", "x-archestra-mcp-aliases": "scoped-aliases" }));
const event = { model: { providerID: "openai" }, baseURL: "https://chatgpt.com/backend-api/codex", headers: { Authorization: "Bearer native-openai-token", "ChatGPT-Account-Id": "acct", "x-archestra-opencode-oauth-bridge": "true", "x-goog-api-key": "goog" }, agent: "build" };
modelRequest(event);
const rerouted = { request: new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", headers: { Authorization: "Bearer native-openai-token", "ChatGPT-Account-Id": "acct", "x-archestra-opencode-oauth-bridge": "true", "x-goog-api-key": "goog" }, body: "{}" }) };
await httpRequest(rerouted);
const kept = { request: new Request(${JSON.stringify(`${managedRoute}/chat/completions`)}, { method: "POST", headers: { Authorization: "Bearer native-openai-token", "x-goog-api-key": "goog" }, body: "{}" }) };
await httpRequest(kept);
console.log(JSON.stringify({
  hook: event.headers,
  hookBase: event.baseURL,
  sourceConnection: providers.get("openai").sourceConnection ?? null,
  finalUrl: rerouted.request.url,
  finalAuth: rerouted.request.headers.get("authorization"),
  finalAccount: rerouted.request.headers.get("chatgpt-account-id"),
  finalBridge: rerouted.request.headers.get("x-archestra-opencode-oauth-bridge"),
  finalGoog: rerouted.request.headers.get("x-goog-api-key"),
  redirect: rerouted.request.redirect,
  keptUrl: kept.request.url,
  keptAuth: kept.request.headers.get("authorization"),
}));`,
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
          else {
            const parsed = JSON.parse(stdout);
            resolve({
              ...parsed,
              hook: { ...parsed.hook, baseURL: parsed.hookBase },
            });
          }
        });
      }),
  );
}
