import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KILO_CLIENT } from "../opencode-family";
import type { ManagedRuntimeCatalog } from "./opencode-primary-config";
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
// The organization's credential serves "vendor" on the proxy's vendor route;
// the user's own OpenAI sign-in goes through the proxy's OpenAI route.
const managedRoute = "https://deployment.example/v1/vendor/agent";
const nativeRoute = "https://deployment.example/v1/openai/agent";
const catalog: ManagedRuntimeCatalog = {
  routes: { vendor: managedRoute, openai: nativeRoute },
  managed: { vendor: ["fixture/model"] },
  passthrough: ["openai"],
  legacy: { "archestra-vendor": "vendor" },
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
  test("keeps the client's providers, filters their models and sends them to the proxy with the managed key", async () => {
    const calls: Request[] = [];
    globals[directFetch] = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push(new Request(input, init));
      return new Response("ok");
    };
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
      // Pins from an earlier setup: one on the proxy's own provider id, one
      // on a model the credential no longer serves.
      model: "archestra-vendor/fixture/model",
      small_model: "vendor/retired",
      enabled_providers: ["archestra-vendor"],
      disabled_providers: ["vendor", "local"],
      provider: {
        "archestra-vendor": {
          name: "Vendor (Archestra)",
          options: {
            baseURL: "https://deployment.example/v1/model-router/agent",
            apiKey: "{file:~/.archestra/opencode-primary.key}",
          },
          models: { "fixture/model": { id: "vendor:fixture/model" } },
        },
        vendor: {
          name: "My vendor",
          options: {
            apiKey: "stale-native",
            headers: {
              Authorization: "Bearer stale-native",
              "ChatGPT-Account-Id": "acct",
              "X-Local": "kept",
            },
          },
          whitelist: ["fixture/model", "retired"],
          models: { retired: { name: "Retired" } },
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
    // The pin on the proxy's old provider id moves to the client's provider;
    // the one on an unserved model goes.
    expect(first.model).toBe("vendor/fixture/model");
    expect(first).not.toHaveProperty("small_model");
    expect(first.enabled_providers).toEqual(["vendor", "openai"]);
    expect(first.disabled_providers).toEqual(["local"]);
    expect(first.provider).not.toHaveProperty("archestra-vendor");
    // Name, npm and model data stay the client's; the credential, the base
    // URL and the model list are the connection's.
    expect(first.provider.vendor).toEqual({
      name: "My vendor",
      whitelist: ["fixture/model"],
      options: {
        apiKey: "managed-secret",
        baseURL: managedRoute,
        headers: { "X-Local": "kept", "X-Archestra-Agent-Id": "opencode" },
      },
      models: { retired: { name: "Retired" } },
    });
    expect(JSON.stringify(first.provider.vendor)).not.toContain(
      "passthrough-secret",
    );
    expect(JSON.stringify(first)).not.toContain(" via ");
    // The user's own OpenAI sign-in keeps its key and gets the passthrough key.
    expect(first.provider.openai).toEqual({
      npm: "@ai-sdk/openai",
      options: {
        apiKey: "user-openai-key",
        baseURL: nativeRoute,
        headers: {
          "X-Archestra-Agent-Id": "opencode",
          "X-Archestra-Virtual-Key": "passthrough-secret",
          Authorization: "Bearer passthrough-secret",
        },
      },
      models: { "user-inventory": { name: "kept" } },
    });
    expect(second.provider.vendor).toEqual(first.provider.vendor);
    expect(second.provider.openai.options.apiKey).toBe("user-openai-key");

    // The client's own sign-in transport for a managed provider still sends
    // the managed key, and never its own token.
    const output: { headers: Record<string, string> } = { headers: {} };
    await hooks["chat.headers"](
      {
        sessionID: "ses_1",
        agent: "build",
        provider: { id: "vendor", options: { baseURL: managedRoute } },
      },
      output,
    );
    expect(output.headers).not.toHaveProperty("X-Archestra-Virtual-Key");
    await globalThis.fetch(`${managedRoute}/chat/completions`, {
      method: "POST",
      headers: {
        ...output.headers,
        Authorization: "Bearer native-vendor-token",
        "x-api-key": "managed-secret",
      },
      body: "{}",
    });
    expect(calls[0].headers.get("authorization")).toBe("Bearer managed-secret");
    expect(calls[0].headers.get("x-api-key")).toBe("managed-secret");
    expect(calls[0].headers.get("x-archestra-managed-alias")).toBeNull();
  });

  test("V2 filters a stock provider's models in place and adds or renames nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-v2-"));
    roots.push(root);
    const revision = path.join(root, "revision");
    await mkdir(revision);
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
        catalog: {
          ...catalog,
          // A provider the client does not have is not created for it.
          managed: { ...catalog.managed, absent: ["x"] },
          routes: {
            ...catalog.routes,
            absent: "https://deployment.example/v1/absent/agent",
          },
        },
      }),
    );
    const result = await run(path.join(revision, "routing.mjs"));
    expect(result.vendor.provider).toMatchObject({
      name: "Vendor",
      activation: "enabled",
      settings: { apiKey: "managed-secret", baseURL: managedRoute },
      headers: { "X-Archestra-Agent-Id": "opencode" },
    });
    expect(result.vendor.provider.headers).not.toHaveProperty(
      "X-Archestra-Virtual-Key",
    );
    expect(result.vendor.models).toEqual({
      "fixture/model": { id: "fixture/model", modelID: "fixture/model" },
    });
    expect(result.openai.provider.settings).toEqual({
      apiKey: "user-openai-key",
    });
    expect(result.openai.models).toEqual({
      "user-inventory": { id: "user-inventory" },
    });
    expect(result.calls.filter((call) => call.startsWith("add:"))).toEqual([]);
    expect(result.calls.filter((call) => call === "models.set:vendor")).toEqual(
      ["models.set:vendor", "models.set:vendor"],
    );
  });

  test("managed Google sends generateContent to the Gemini route with the managed key", async () => {
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
    const geminiRoute = "https://deployment.example/v1/gemini/agent/v1beta";
    const file = path.join(revision, "routing.mjs");
    await writeFile(
      file,
      renderOpenCodeRoutingPlugin({
        runtime: true,
        routes: {},
        headers: {},
        catalog: {
          routes: { google: geminiRoute },
          managed: { google: ["gem-x"] },
          // The admin turned the user's own Gemini sign-in off, so the
          // organization's credential serves Google even though the user
          // is signed in.
          passthrough: [],
          legacy: { "archestra-gemini": "google" },
        },
      }),
    );
    const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const hooks = await module.ArchestraLlmProxy();
    const config = {
      provider: { google: { npm: "@ai-sdk/google", options: {} } },
    };
    await hooks.config(config);
    expect(config.provider.google).toEqual({
      npm: "@ai-sdk/google",
      whitelist: ["gem-x"],
      options: {
        apiKey: "managed-secret",
        baseURL: geminiRoute,
        headers: { "X-Archestra-Agent-Id": "opencode" },
      },
    });
    const auth = await hooks.auth.loader(async () => ({
      type: "oauth",
      access: "native-google-token",
    }));
    expect(auth).toMatchObject({
      apiKey: "managed-secret",
      baseURL: geminiRoute,
    });
    await expect(
      auth.fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gem-x:generateContent",
        { method: "POST", body: "{}" },
      ),
    ).rejects.toThrow("Unsupported managed authentication request");
    expect(calls).toEqual([]);
    await auth.fetch(`${geminiRoute}/models/gem-x:streamGenerateContent`, {
      method: "POST",
      headers: {
        Authorization: "Bearer native-google-token",
        "x-goog-api-key": "native-google-token",
      },
      body: "{}",
    });
    expect(calls).toEqual([
      `${geminiRoute}/models/gem-x:streamGenerateContent auth=Bearer managed-secret goog=null`,
    ]);
  });

  test("sends the managed key when the client's own sign-in for a managed provider replaces it", async () => {
    const calls: Request[] = [];
    globals[directFetch] = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push(new Request(input, init));
      return new Response("ok");
    };
    const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-signin-"));
    roots.push(root);
    process.env.XDG_DATA_HOME = path.join(root, "data");
    process.env.HOME = root;
    // Kilo Code keeps its own vendor sign-in here; the connection serves
    // vendor only with the organization's credential.
    await mkdir(path.join(root, "data", "kilo"), { recursive: true });
    await writeFile(
      path.join(root, "data", "kilo", "auth.json"),
      JSON.stringify({
        vendor: { type: "oauth", access: "native-vendor-token", refresh: "r" },
      }),
    );
    await mkdir(path.join(root, ".archestra"));
    await writeFile(
      path.join(root, ".archestra", "kilo-primary.key"),
      "managed-secret\n",
    );
    const revision = path.join(root, "revision");
    await mkdir(revision);
    await writeFile(
      path.join(root, "params.json"),
      JSON.stringify({
        routes: {},
        headers: { "X-Archestra-Agent-Id": "kilo" },
        routeHeaders: {
          openai: { "X-Archestra-Virtual-Key": "passthrough-secret" },
        },
        clientId: "kilo",
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
        catalog,
        client: KILO_CLIENT,
      }),
    );
    const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const hooks = await module.ArchestraLlmProxy();
    const config = {
      provider: {
        vendor: { options: {} },
        openai: { options: { apiKey: "user-openai-key" } },
      },
    };
    await hooks.config(config);
    expect(config.provider.vendor.options).toMatchObject({
      apiKey: "managed-secret",
      baseURL: managedRoute,
    });

    // The client's sign-in transport keeps the hook's headers and sets its
    // own bearer token, as Kilo Code's xAI sign-in does.
    const signedIn = async (providerId: string, url: string) => {
      const output: { headers: Record<string, string> } = { headers: {} };
      await hooks["chat.headers"](
        {
          sessionID: "ses_child",
          agent: "explore",
          provider: { id: providerId, options: {} },
        },
        output,
      );
      return globalThis.fetch(url, {
        method: "POST",
        headers: {
          ...output.headers,
          Authorization: `Bearer native-${providerId}-token`,
          "ChatGPT-Account-Id": "acct",
          "x-api-key": `native-${providerId}-key`,
        },
        body: "{}",
      });
    };
    await signedIn("vendor", `${managedRoute}/chat/completions`);
    await signedIn("openai", `${nativeRoute}/responses`);

    const [managed, native] = calls;
    expect(managed.url).toBe(`${managedRoute}/chat/completions`);
    expect(managed.headers.get("authorization")).toBe("Bearer managed-secret");
    expect(managed.headers.get("chatgpt-account-id")).toBeNull();
    expect(managed.headers.get("x-api-key")).toBeNull();
    expect(managed.headers.get("x-opencode-session")).toBe("ses_child");
    expect(managed.headers.get("x-archestra-managed-alias")).toBeNull();
    // A provider on its own native route keeps the user's credential.
    expect(native.headers.get("authorization")).toBe(
      "Bearer native-openai-token",
    );
    expect(native.headers.get("x-api-key")).toBe("native-openai-key");
    expect(native.headers.get("x-archestra-virtual-key")).toBe(
      "passthrough-secret",
    );
    expect(native.headers.get("x-archestra-managed-alias")).toBeNull();
  });

  test("keeps the client's provider names and ids and adds no provider of its own", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-names-"));
    roots.push(root);
    process.env.XDG_DATA_HOME = path.join(root, "data");
    process.env.HOME = root;
    await mkdir(path.join(root, ".archestra"));
    await writeFile(
      path.join(root, ".archestra", "kilo-primary.key"),
      "managed-secret\n",
    );
    const revision = path.join(root, "revision");
    await mkdir(revision);
    await writeFile(
      path.join(root, "params.json"),
      JSON.stringify({
        routes: {},
        headers: { "X-Archestra-Agent-Id": "kilo" },
        clientId: "kilo",
        origin: "https://deployment.example",
        skipRelpath: ".archestra/skip",
        source: { token: "cru1_test" },
      }),
    );
    const kimiRoute = "https://deployment.example/v1/kimi/agent";
    const xaiRoute = "https://deployment.example/v1/xai/agent";
    const file = path.join(revision, "routing.mjs");
    await writeFile(
      file,
      renderOpenCodeRoutingPlugin({
        runtime: true,
        routes: {},
        headers: {},
        catalog: {
          routes: { moonshotai: kimiRoute, xai: xaiRoute },
          managed: { moonshotai: ["kimi-k3"], xai: ["grok-4.7"] },
          passthrough: ["xai"],
          legacy: { "archestra-kimi": "moonshotai", "archestra-xai": "xai" },
        },
        client: KILO_CLIENT,
      }),
    );
    const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const hooks = await module.ArchestraLlmProxy();
    const config: {
      model?: string;
      agent: Record<string, { model?: string }>;
      provider: Record<string, { name?: string }>;
    } = {
      model: "archestra-kimi/kimi-k3",
      agent: { compaction: { model: "kimi-code-plan-cn/kimi-k3" } },
      provider: {
        moonshotai: { name: "Moonshot AI" },
        "kimi-code-plan-cn": { name: "Kimi For Coding (kimi.com)" },
      },
    };
    await hooks.config(config);
    expect(config.model).toBe("moonshotai/kimi-k3");
    expect(config.agent).toEqual({ compaction: {} });
    expect(Object.keys(config.provider).sort()).toEqual([
      "kimi-code-plan-cn",
      "moonshotai",
      "xai",
    ]);
    expect(config.provider.moonshotai.name).toBe("Moonshot AI");
    // The client's own catalog names a provider the config does not.
    expect(config.provider.xai).not.toHaveProperty("name");
    expect(config.provider["kimi-code-plan-cn"]).toEqual({
      name: "Kimi For Coding (kimi.com)",
    });
    expect(JSON.stringify(config)).not.toContain(" via ");
    expect(JSON.stringify(config)).not.toContain("archestra-");
  });

  test("V2 keeps every provider's own name and disables the ones the connection does not serve", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-v2-names-"));
    roots.push(root);
    const revision = path.join(root, "revision");
    await mkdir(revision);
    const keyPath = path.join(root, "managed.key");
    await writeFile(keyPath, "managed-secret\n");
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
        catalog: {
          routes: { moonshotai: "https://deployment.example/v1/kimi/agent" },
          managed: { moonshotai: ["kimi-k3"] },
          passthrough: [],
          legacy: { "archestra-kimi": "moonshotai" },
        },
      }),
    );
    expect(
      await runProviderNames(file, {
        moonshotai: "Moonshot AI",
        "kimi-code-plan-cn": "Kimi For Coding (kimi.com)",
        opencode: "OpenCode Zen",
      }),
    ).toEqual({
      moonshotai: { name: "Moonshot AI", activation: "enabled" },
      "kimi-code-plan-cn": {
        name: "Kimi For Coding (kimi.com)",
        activation: "disabled",
      },
      opencode: { name: "OpenCode Zen", activation: "disabled" },
    });
  });

  test("a supplied empty catalog is authoritative and an omitted catalog is not", async () => {
    const empty: ManagedRuntimeCatalog = {
      routes: {},
      managed: {},
      passthrough: [],
      legacy: {},
    };
    expect(
      renderOpenCodeRoutingPlugin({
        routes: { openai: "https://old.example/v1/openai/stale-agent" },
        headers: {},
        catalog: empty,
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
        catalog: empty,
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

  test("V2 strips native OAuth after the request hook when the organization's credential serves the provider", async () => {
    const result = await runManagedOpenAi(false);
    expect(result.hook).toMatchObject({
      baseURL: openAiRoute,
      Authorization: "Bearer managed-secret",
    });
    expect(result.hook).not.toHaveProperty("ChatGPT-Account-Id");
    expect(result.hook).not.toHaveProperty("x-goog-api-key");
    expect(result.hook).not.toHaveProperty("x-archestra-opencode-oauth-bridge");
    expect(result.sourceConnection).toEqual({ id: "oauth" });
    expect(result.finalUrl).toBe(`${openAiRoute}/responses`);
    expect(result.finalAuth).toBe("Bearer managed-secret");
    expect(result.finalAccount).toBeNull();
    expect(result.finalBridge).toBeNull();
    expect(result.finalGoog).toBeNull();
    expect(result.keptUrl).toBe(`${openAiRoute}/chat/completions`);
    expect(result.keptAuth).toBe("Bearer managed-secret");
    expect(result.redirect).toBe("error");
  });

  test("V2 keeps the user's own sign-in ahead of the organization's credential where the connection allows it", async () => {
    const result = await runManagedOpenAi(true);
    expect(result.hook.Authorization).toBe("Bearer native-openai-token");
    expect(result.hook["x-archestra-opencode-oauth-bridge"]).toBe("true");
    expect(result.hook.Authorization).not.toBe("Bearer managed-secret");
    expect(result.finalUrl).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(result.finalAuth).toBe("Bearer native-openai-token");
    expect(result.finalAccount).toBe("acct");
  });
});

/** Runs the V2 transform twice over providers the client already lists. */
function runProviderNames(
  file: string,
  names: Record<string, string>,
): Promise<Record<string, { name: string; activation: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const plugin = (await import(${JSON.stringify(pathToFileURL(file).href)})).default;
const providers = new Map(Object.entries(${JSON.stringify(names)}).map(([id, name]) => [id, { provider: { id, name, activation: "auto", settings: {}, headers: {} }, models: new Map([["kimi-k3", { id: "kimi-k3" }], ["other", { id: "other" }]]) }]));
const editor = {
  list: () => [...providers.values()],
  get: (id) => providers.get(id),
  add: ({ info, models }) => { providers.set(info.id, { provider: info, models: new Map(models.map((model) => [model.id, model])) }); },
  update: (id, update) => { update(providers.get(id).provider); },
  models: { set: (id, models) => { providers.get(id).models = new Map(models.map((model) => [model.id, model])); } },
};
for (let pass = 0; pass < 2; pass++) await plugin.setup({ provider: { transform: async (callback) => callback(editor) }, session: { hook: async () => {} } });
console.log(JSON.stringify(Object.fromEntries([...providers].map(([id, record]) => [id, { name: record.provider.name, activation: record.provider.activation }]))));`,
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
      name: string;
      activation: string;
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
  ["vendor", { provider: { id: "vendor", name: "Vendor", activation: "auto", settings: { apiKey: "stale" }, headers: { Authorization: "Bearer stale", "ChatGPT-Account-Id": "acct" } }, models: new Map([["retired", { id: "retired", modelID: "retired" }], ["fixture/model", { id: "fixture/model", modelID: "fixture/model" }]]) }],
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

const openAiRoute = "https://deployment.example/v1/openai/agent";

async function prepareManagedOpenAi(nativeAllowed: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "catalog-plugin-openai-"));
  roots.push(root);
  const revision = path.join(root, "revision");
  await mkdir(revision);
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
  await writeFile(
    path.join(revision, "routing.mjs"),
    renderOpenCodeRoutingPluginV2({
      runtime: true,
      routes: {},
      headers: {},
      catalog: {
        routes: { openai: openAiRoute },
        managed: { openai: ["gpt-x"] },
        passthrough: nativeAllowed ? ["openai"] : [],
        legacy: { "archestra-openai": "openai" },
      },
    }),
  );
  return path.join(revision, "routing.mjs");
}

function runManagedOpenAi(nativeAllowed: boolean): Promise<{
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
  return prepareManagedOpenAi(nativeAllowed).then(
    (file) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const plugin = (await import(${JSON.stringify(pathToFileURL(file).href)})).default;
const providers = new Map([
  ["openai", { provider: { id: "openai", activation: "disabled", settings: { apiKey: "native-user-key" }, headers: { Authorization: "Bearer native-user-key" } }, models: new Map([["gpt-x", { id: "gpt-x" }], ["gpt-y", { id: "gpt-y" }]]), sourceConnection: { id: "oauth" } }],
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
const event = { model: { providerID: "openai" }, baseURL: "https://chatgpt.com/backend-api/codex", headers: { Authorization: "Bearer native-openai-token", "ChatGPT-Account-Id": "acct", "x-goog-api-key": "stale" }, agent: "build" };
modelRequest(event);
const rerouted = { request: new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", headers: { Authorization: "Bearer native-openai-token", "ChatGPT-Account-Id": "acct", "x-archestra-opencode-oauth-bridge": "true", "x-goog-api-key": "stale" }, body: "{}" }) };
await httpRequest(rerouted);
const kept = { request: new Request(${JSON.stringify(`${openAiRoute}/chat/completions`)}, { method: "POST", headers: { Authorization: "Bearer native-openai-token", "x-goog-api-key": "stale" }, body: "{}" }) };
await httpRequest(kept);
console.log(JSON.stringify({
  hook: event.headers,
  hookBase: event.baseURL,
  sourceConnection: providers.get("openai").sourceConnection ?? null,
  models: [...providers.get("openai").models.keys()],
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
