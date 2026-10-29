import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KILO_CLIENT, OPENCODE_CLIENT } from "../opencode-family";
import type { SetupScriptProxySection } from "../types";
import { managedRuntimeManifest } from "./managed-runtime";
import { MANAGED_RUNTIME_BOOTSTRAP } from "./managed-runtime-bootstrap";
import { managedRuntimeInstall } from "./managed-runtime-install";

const exec = promisify(execFile);
const roots: string[] = [];
const installation = "11111111-1111-4111-8111-111111111111";
const url = "https://deployment.example.com/v1/mcp/gateway";
const name = "deployment";
const digest = (source: string) =>
  createHash("sha256").update(source).digest("hex");
const require = createRequire(import.meta.url);

async function fixture({
  client = KILO_CLIENT,
  apiMajor = 1,
  version,
  proxy = null,
}: {
  client?: typeof KILO_CLIENT;
  apiMajor?: number;
  version?: string;
  proxy?: SetupScriptProxySection | null;
} = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "managed-runtime-"));
  roots.push(home);
  const context = {
    clientId: client.clientId,
    platform: "linux" as const,
    appName: "Test Platform",
    mcp: { serverName: name, url, toolPrefix: name },
    proxy,
    skills: null,
    managedRuntimeSource: {
      url: "https://deployment.example.com/api/connection-setups/runtime",
      token: `cru1_${installation}.example`,
      installation,
    },
  };
  const install = managedRuntimeInstall({
    client,
    context,
    routes: { anthropic: "https://deployment.example.com/v1/anthropic" },
    headers: {},
  });
  if (!install) throw new Error("Missing installer");
  const bin = path.join(home, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, client.binary),
    `#!${process.execPath}\nconsole.log(${JSON.stringify(version ?? (client.clientId === "kilo" ? "7.8.15" : "1.19.3"))});\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    ARCHESTRA_OC_RUNTIME_API_MAJOR: String(apiMajor),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  await exec(process.execPath, ["-e", install.script], { env });
  const root = path.join(home, ".archestra", `${client.stateName}-runtime`);
  const configDir = path.join(env.XDG_CONFIG_HOME, client.dir);
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, client.configFile);
  const siblingPath = path.join(configDir, client.commentedConfigFile);
  const pluginPath = path.join(home, "plugin.mjs");
  await writeFile(pluginPath, install.v1);
  const installPath = path.join(home, "install.cjs");
  await writeFile(installPath, install.script);
  return {
    home,
    root,
    env,
    configPath,
    siblingPath,
    pluginPath,
    installPath,
    install,
    run: (script: string, extraEnv: Record<string, string> = {}) =>
      exec(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...env, ...extraEnv },
      }),
  };
}

function loader(fetch: typeof globalThis.fetch) {
  const module = {
    exports: {} as {
      refresh: (
        root: string,
      ) => Promise<{ revision: string; directory: string }>;
    },
  };
  runInNewContext(MANAGED_RUNTIME_BOOTSTRAP, {
    require,
    module,
    process,
    Buffer,
    URL,
    AbortSignal,
    fetch,
    setTimeout,
    console,
  });
  return module.exports;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed runtime trust boundary", () => {
  test.each([
    OPENCODE_CLIENT,
    KILO_CLIENT,
  ])("$clientId installs the TUI half without replacing other plugins or preferences", async (client) => {
    const files = await fixture({ client });
    const tui = path.join(path.dirname(files.configPath), "tui.json");
    const original = JSON.parse(await readFile(tui, "utf8"));
    expect(original.plugin).toHaveLength(1);
    expect(original.plugin[0]).toContain("/tui.mjs");
    await writeFile(
      tui,
      "\uFEFF" +
        JSON.stringify({
          ...original,
          theme: "custom",
          plugin: ["other-plugin", ...original.plugin],
        }),
    );
    await exec(process.execPath, [files.installPath], { env: files.env });
    expect(JSON.parse(await readFile(tui, "utf8"))).toEqual({
      theme: "custom",
      plugin: ["other-plugin", ...original.plugin],
    });
    const parameters = JSON.parse(
      await readFile(path.join(files.root, "params.json"), "utf8"),
    );
    expect(parameters.questionCards).toBe(true);
  });

  test("stores the passthrough key apart from any route", async () => {
    // A setup that knew no passthrough route still keeps the key, so a route
    // the deployment's catalog lists later can carry it.
    const files = await fixture({
      proxy: {
        baseUrl: "https://deployment.example.com/v1/proxy",
        routingAgentId: "agent",
        primaryProviders: [],
        passthroughProviders: [],
        virtualKey: null,
        passthroughVirtualKey: "passthrough-secret",
      } as unknown as SetupScriptProxySection,
    });
    const parameters = JSON.parse(
      await readFile(path.join(files.root, "params.json"), "utf8"),
    );
    expect(parameters.passthroughHeaders).toEqual({
      "X-Archestra-Virtual-Key": "passthrough-secret",
    });
    const withoutKey = await fixture();
    expect(
      JSON.parse(
        await readFile(path.join(withoutKey.root, "params.json"), "utf8"),
      ),
    ).not.toHaveProperty("passthroughHeaders");
  });

  test.each([
    [OPENCODE_CLIENT, 1, "1.17.0"],
    [OPENCODE_CLIENT, 2, "2.0.25"],
    [KILO_CLIENT, 1, "7.7.0"],
    [KILO_CLIENT, 1, "unknown"],
  ] as const)("unsupported $0.clientId $2 keeps native questions", async (client, major, version) => {
    const files = await fixture({ client, apiMajor: major, version });
    const parameters = JSON.parse(
      await readFile(path.join(files.root, "params.json"), "utf8"),
    );
    expect(parameters.questionCards).toBe(false);
    await expect(
      readFile(path.join(path.dirname(files.configPath), "tui.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("JSONC preferences are preserved and the manual TUI entry remains available", async () => {
    const files = await fixture();
    const commented = path.join(path.dirname(files.configPath), "tui.jsonc");
    const source = '{ // keep this comment\n "theme": "custom" }\n';
    await writeFile(commented, source);
    const result = await exec(process.execPath, [files.installPath], {
      env: files.env,
    });
    expect(result.stderr).toContain("native question fallback");
    expect(await readFile(commented, "utf8")).toBe(source);
    expect(await readFile(path.join(files.root, "tui.mjs"), "utf8")).toContain(
      "QuestionCardsTui",
    );
  });

  test("the installed launcher CLI executes the refreshed launcher, not only its next-process replacement", async () => {
    const files = await fixture();
    const manifest = managedRuntimeManifest({ installation, clientId: "kilo" });
    const marker = path.join(files.home, "launched-revision");
    const source = `module.exports.prepare=async()=>{require("node:fs").writeFileSync(${JSON.stringify(marker)},"updated-launcher");};`;
    manifest.artifacts["launcher.cjs"] = { source, sha256: digest(source) };
    const preload = path.join(files.home, "network.cjs");
    await writeFile(
      preload,
      `globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(manifest))});`,
      { mode: 0o600 },
    );
    await exec(
      process.execPath,
      ["--require", preload, path.join(files.root, "bootstrap.cjs")],
      { env: files.env },
    );
    expect(await readFile(marker, "utf8")).toBe("updated-launcher");
  });

  test("awaits refresh before loading updated plugin and launcher in the same process", async () => {
    const files = await fixture();
    const manifest = managedRuntimeManifest({ installation, clientId: "kilo" });
    const source = `globalThis.implLoaded = true; export function captureMcpAliases() {}; export function bindSessionProof() {};
export const ArchestraLlmProxy = async () => ({ config: async cfg => { cfg.pluginRevision = "updated"; }, "chat.params": async () => "updated-first-request" });
export const ArchestraOpenAiOAuth = async () => ({});`;
    manifest.artifacts["routing-v1.mjs"] = { source, sha256: digest(source) };
    const launcher = `module.exports.prepare=async(runtime,cfg)=>{cfg.launcherRevision="updated";return true;};`;
    manifest.artifacts["launcher.cjs"] = {
      source: launcher,
      sha256: digest(launcher),
    };
    const result =
      await files.run(`let release; globalThis.fetch = () => new Promise(resolve => release = resolve);
const plugin = await import(${JSON.stringify(files.pluginPath)});
const pending = plugin.ArchestraLlmProxy();
await new Promise(resolve => setTimeout(resolve, 30));
if (globalThis.implLoaded) throw Error("Loaded before refresh");
release(new Response(${JSON.stringify(JSON.stringify(manifest))}));
const hooks = await pending; const cfg = {}; await hooks.config(cfg);
console.log(JSON.stringify({ ...cfg, first: await hooks["chat.params"]() }));`);
    expect(JSON.parse(result.stdout)).toEqual({
      launcherRevision: "updated",
      pluginRevision: "updated",
      first: "updated-first-request",
    });
  });

  test("an already-loaded V1 config hook activates newly downloaded code before its next request", async () => {
    const files = await fixture();
    const updated = managedRuntimeManifest({ installation, clientId: "kilo" });
    const source = updated.artifacts["routing-v1.mjs"].source
      .replace(
        "async config(config) {",
        "async config(config) { config.updatedGeneration = true;",
      )
      .replace(
        'async "chat.headers"(input, output) {',
        'async "chat.headers"(input, output) { output.headers["x-implementation-revision"] = "updated";',
      );
    updated.artifacts["routing-v1.mjs"] = { source, sha256: digest(source) };
    const result = await files.run(`
import fs from "node:fs";
let manifest = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(files.root, "current.json"))}, "utf8"));
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  return new URL(request.url).pathname.endsWith("/runtime") ? new Response(JSON.stringify(manifest)) : new Response("ok");
};
const plugin = await import(${JSON.stringify(files.pluginPath)});
const hooks = await plugin.ArchestraLlmProxy();
const config = () => ({ provider: { anthropic: { options: { apiKey: "example" } } }, mcp: { deployment: { type: "remote", url: ${JSON.stringify(url)} } } });
await hooks.config(config());
manifest = ${JSON.stringify(updated)};
fs.writeFileSync(${JSON.stringify(path.join(files.root, "last-check.json"))}, JSON.stringify({ installation: ${JSON.stringify(installation)}, attemptedAt: Date.now() - 31000 }));
const cfg = config(); await hooks.config(cfg);
const output = { headers: {} };
await hooks["chat.headers"]({ provider: { id: "anthropic" }, sessionID: "updated-session", agent: "build" }, output);
await fetch("https://deployment.example.com/v1/anthropic/messages", { headers: output.headers });
console.log(JSON.stringify({ updated: cfg.updatedGeneration, headers: output.headers }));
`);
    expect(JSON.parse(result.stdout)).toMatchObject({
      updated: true,
      headers: { "x-implementation-revision": "updated" },
    });
  });

  test("refreshes a complete generation atomically, including changed hashes at the same version", async () => {
    const files = await fixture();
    const old = await readFile(path.join(files.root, "current.json"), "utf8");
    const manifest = JSON.parse(old);
    const source = `${manifest.artifacts["launcher.cjs"].source}\n// updated launcher behavior\n`;
    manifest.artifacts["launcher.cjs"] = { source, sha256: digest(source) };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(manifest)));
    const runtime = await loader(fetch).refresh(files.root);
    expect(runtime.revision).not.toBe(digest(old));
    expect(
      await readFile(path.join(runtime.directory, "launcher.cjs"), "utf8"),
    ).toBe(source);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer cru1_${installation}.example` },
    });
  });

  test.each([
    "offline",
    "partial",
    "hash",
    "wrong-installation",
    "redirect",
  ])("%s download retains verified cached code", async (failure) => {
    const files = await fixture();
    const original = await readFile(
      path.join(files.root, "current.json"),
      "utf8",
    );
    const manifest = JSON.parse(original);
    if (failure === "hash")
      manifest.artifacts["launcher.cjs"].source += "unverified";
    if (failure === "wrong-installation")
      manifest.installation = "22222222-2222-4222-8222-222222222222";
    const fetch = vi.fn().mockImplementation(async () => {
      if (failure === "offline") throw Error("offline");
      if (failure === "partial")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"format":'));
              controller.error(Error("broken download"));
            },
          }),
        );
      if (failure === "redirect") return new Response(null, { status: 302 });
      return new Response(JSON.stringify(manifest));
    });
    await loader(fetch).refresh(files.root);
    expect(await readFile(path.join(files.root, "current.json"), "utf8")).toBe(
      original,
    );
  });

  test("rejects locally modified cached code and unsafe ownership instead of executing it offline", async () => {
    const files = await fixture();
    const current = JSON.parse(
      await readFile(path.join(files.root, "current.json"), "utf8"),
    );
    const file = path.join(
      files.root,
      digest(JSON.stringify(current)),
      "launcher.cjs",
    );
    await writeFile(file, "module.exports.prepare=()=>{}", { mode: 0o600 });
    await expect(loader(vi.fn()).refresh(files.root)).rejects.toThrow(
      "Modified managed runtime artifact",
    );
    await chmod(path.join(files.root, "params.json"), 0o666);
    await expect(loader(vi.fn()).refresh(files.root)).rejects.toThrow(
      "Unsafe managed runtime ownership",
    );
  });

  test("reconnect refuses a retained file that would fail launcher ownership checks", async () => {
    const files = await fixture();
    const checked = path.join(files.root, "last-check.json");
    await writeFile(checked, "{}", { mode: 0o666 });
    await chmod(checked, 0o666);
    await expect(
      exec(process.execPath, ["-e", files.install.script], { env: files.env }),
    ).rejects.toThrow("Unsafe managed runtime ownership");
  });

  test("serializes concurrent launches and never exposes a partially-written generation", async () => {
    const files = await fixture();
    const fetch = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(
        await readFile(path.join(files.root, "current.json"), "utf8"),
      );
    });
    const runtimeLoader = loader(fetch);
    const results = await Promise.all([
      runtimeLoader.refresh(files.root),
      runtimeLoader.refresh(files.root),
      runtimeLoader.refresh(files.root),
    ]);
    expect(new Set(results.map((result) => result.revision)).size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("bounds a stalled download and falls back to verified code", async () => {
    const files = await fixture();
    const original = await readFile(
      path.join(files.root, "current.json"),
      "utf8",
    );
    const fetch = vi.fn().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(Error("download timed out")),
            { once: true },
          );
        }),
    );
    await loader(fetch).refresh(files.root);
    expect(await readFile(path.join(files.root, "current.json"), "utf8")).toBe(
      original,
    );
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  test("rejects a different-origin executable endpoint without sending the capability", async () => {
    const files = await fixture();
    const paramsPath = path.join(files.root, "params.json");
    const params = JSON.parse(await readFile(paramsPath, "utf8"));
    params.source.url =
      "https://foreign.example.com/api/connection-setups/runtime";
    await writeFile(paramsPath, JSON.stringify(params));
    const fetch = vi.fn();
    await loader(fetch).refresh(files.root);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    { operation: "startup", code: "ENOENT" },
    { operation: "installation", code: "ENOENT" },
    { operation: "startup", code: "EACCES" },
    { operation: "installation", code: "EACCES" },
  ])("$operation handles $code while inspecting a contended lock", async ({
    operation,
    code,
  }) => {
    const files = await fixture();
    const lock = path.join(files.root, "lock");
    const marker = path.join(files.home, "lock-race-observed");
    const preload = path.join(files.home, "lock-race.cjs");
    // Reproduce the OS interleaving at the filesystem boundary in this child
    // process: mkdir sees a competing owner, then inspection sees its release.
    await writeFile(
      preload,
      `
const fs = require("node:fs");
const mkdir = fs.mkdirSync, lstat = fs.lstatSync;
const lock = ${JSON.stringify(lock)};
let contended = false, inspected = false;
fs.mkdirSync = (file, options) => {
  if (file === lock && !contended) {
    contended = true;
    mkdir(file, options);
    throw Object.assign(Error("Contended lock"), { code: "EEXIST" });
  }
  return mkdir(file, options);
};
fs.lstatSync = (...args) => {
  if (args[0] === lock && contended && !inspected) {
    inspected = true;
    fs.writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(code)});
    if (${JSON.stringify(code)} === "ENOENT") fs.rmSync(lock, { recursive: true });
    else throw Object.assign(Error("Lock inspection denied"), { code: "EACCES" });
  }
  return lstat(...args);
};
`,
    );
    const script =
      operation === "installation"
        ? files.install.script
        : `globalThis.fetch=async()=>{throw Error("offline")}; require(${JSON.stringify(path.join(files.root, "bootstrap.cjs"))}).refresh(${JSON.stringify(files.root)}).catch(error=>{console.error(error.message);process.exitCode=1;});`;
    const outcome = await exec(
      process.execPath,
      ["--require", preload, "-e", script],
      { env: files.env },
    ).then(
      () => ({ status: 0, denied: false }),
      (error) => ({
        status: error.code,
        denied: error.stderr.includes("Lock inspection denied"),
      }),
    );
    expect(await readFile(marker, "utf8")).toBe(code);
    expect(outcome).toEqual(
      code === "ENOENT"
        ? { status: 0, denied: false }
        : { status: 1, denied: true },
    );
    const owner = JSON.parse(
      await readFile(path.join(files.root, "owner.json"), "utf8"),
    );
    expect(owner.installation).toBe(installation);
    expect(owner.bootstrapHash).toBe(digest(MANAGED_RUNTIME_BOOTSTRAP));
  });

  test("serializes re-enrollment with concurrent startup, preserving the installation fingerprint", async () => {
    const files = await fixture();
    const script = `globalThis.fetch=async()=>{throw Error("offline")}; const loader=(await import(${JSON.stringify(path.join(files.root, "bootstrap.cjs"))})).default; await loader.refresh(${JSON.stringify(files.root)});`;
    await Promise.all([
      files.run(script),
      exec(process.execPath, ["-e", files.install.script], { env: files.env }),
    ]);
    await loader(vi.fn().mockRejectedValue(Error("offline"))).refresh(
      files.root,
    );
    const owner = JSON.parse(
      await readFile(path.join(files.root, "owner.json"), "utf8"),
    );
    expect(owner.installation).toBe(installation);
    expect(owner.bootstrapHash).toBe(digest(MANAGED_RUNTIME_BOOTSTRAP));
  });
});

describe("pre-bind local repair", () => {
  test.each([
    KILO_CLIENT,
    OPENCODE_CLIENT,
  ])("$label repairs BOM-prefixed JSON offline and preserves JSONC authentication/comments and snapshots", async (client) => {
    const files = await fixture({ client });
    const canonical = { type: "remote", url };
    await writeFile(
      files.configPath,
      `\uFEFF${JSON.stringify({ mcp: { [name]: canonical } })}`,
      { mode: 0o600 },
    );
    const sibling = `// preserved\n{"mcp":{"my_gateway":{"type":"remote","url":"${url}","headers":{"Authorization":"Bearer example-token"},"oauth":false}}}`;
    await writeFile(files.siblingPath, sibling, { mode: 0o600 });
    await files.run(
      `globalThis.fetch=async()=>{throw Error("offline")}; const loader=(await import(${JSON.stringify(path.join(files.root, "bootstrap.cjs"))})).default; const runtime=await loader.refresh(${JSON.stringify(files.root)}); await (await import(runtime.directory+"/launcher.cjs")).default.prepare(runtime);`,
    );
    const owned = JSON.parse(await readFile(files.configPath, "utf8"));
    expect(owned.mcp[name].headers.Authorization).toBe("Bearer example-token");
    expect(await readFile(files.siblingPath, "utf8")).toBe(
      sibling.replace('"my_gateway":{', '"my_gateway":{"enabled":false,'),
    );
    expect(
      await readFile(`${files.siblingPath}.archestra-backup`, "utf8"),
    ).toBe(sibling);
  });

  test.each([
    "disabled",
    "missing",
    "disconnected",
  ])("does not resurrect a %s canonical binding", async (state) => {
    const files = await fixture();
    const cfg = {
      mcp:
        state === "missing"
          ? {}
          : { [name]: { type: "remote", url, enabled: state !== "disabled" } },
    };
    const raw = JSON.stringify(cfg);
    const sibling = `{"mcp":{"my_gateway":{"type":"remote","url":"${url}"}}}`;
    await writeFile(files.configPath, raw, { mode: 0o600 });
    await writeFile(files.siblingPath, sibling, { mode: 0o600 });
    if (state === "disconnected")
      await writeFile(
        path.join(files.home, ".archestra/kilo-startup-guard.skip"),
        "mcp\n",
      );
    await files.run(
      `globalThis.fetch=async()=>{throw Error("offline")}; const loader=(await import(${JSON.stringify(path.join(files.root, "bootstrap.cjs"))})).default; const runtime=await loader.refresh(${JSON.stringify(files.root)}); await (await import(runtime.directory+"/launcher.cjs")).default.prepare(runtime);`,
    );
    expect(await readFile(files.configPath, "utf8")).toBe(raw);
    expect(await readFile(files.siblingPath, "utf8")).toBe(sibling);
  });

  test.each([
    "disabled",
    "missing",
  ])("keeps an existing active legacy alias when canonical is %s and two aliases duplicate", async (state) => {
    const files = await fixture();
    const cfg = {
      mcp: {
        ...(state === "disabled"
          ? { [name]: { type: "remote", url, enabled: false } }
          : {}),
        first_legacy: { type: "remote", url },
      },
    };
    await writeFile(files.configPath, JSON.stringify(cfg), { mode: 0o600 });
    await writeFile(
      files.siblingPath,
      `{"mcp":{"second_legacy":{"type":"remote","url":"${url}"}}}`,
      { mode: 0o600 },
    );
    await files.run(
      `globalThis.fetch=async()=>{throw Error("offline")}; const loader=(await import(${JSON.stringify(path.join(files.root, "bootstrap.cjs"))})).default; const runtime=await loader.refresh(${JSON.stringify(files.root)}); await (await import(runtime.directory+"/launcher.cjs")).default.prepare(runtime);`,
    );
    const owned = JSON.parse(await readFile(files.configPath, "utf8"));
    expect(owned.mcp.first_legacy).toEqual({ type: "remote", url });
    expect(owned.mcp[name]?.enabled).toBe(
      state === "disabled" ? false : undefined,
    );
    expect(
      JSON.parse(await readFile(files.siblingPath, "utf8")).mcp.second_legacy
        .enabled,
    ).toBe(false);
  });

  test("V1 repairs actual project-merged config before binding, without persisting project overrides", async () => {
    const files = await fixture();
    await writeFile(
      files.configPath,
      JSON.stringify({ mcp: { [name]: { type: "remote", url } } }),
      { mode: 0o600 },
    );
    const result = await files.run(
      `globalThis.fetch=async()=>{throw Error("offline")};const plugin=await import(${JSON.stringify(files.pluginPath)});const hooks=await plugin.ArchestraLlmProxy(); const cfg={mcp:{deployment:{type:"remote",url:${JSON.stringify(url)}},project_alias:{type:"remote",url:${JSON.stringify(url)}}}};await hooks.config(cfg);console.log(JSON.stringify(cfg.mcp));`,
    );
    expect(Object.keys(JSON.parse(result.stdout))).toEqual([name]);
    expect(JSON.parse(await readFile(files.configPath, "utf8"))).toEqual({
      mcp: { [name]: { type: "remote", url } },
    });
  });

  test("V2 uses awaited native MCP transform before provider hooks and honors disabled bindings", async () => {
    const files = await fixture({ client: OPENCODE_CLIENT, apiMajor: 2 });
    await writeFile(files.pluginPath, files.install.v2);
    const result = await files.run(
      `globalThis.fetch=async()=>{throw Error("offline")};const plugin=await import(${JSON.stringify(files.pluginPath)});const servers={deployment:{type:"remote",url:${JSON.stringify(url)}},duplicate:{type:"remote",url:${JSON.stringify(url)}},disabled_alias:{type:"remote",url:${JSON.stringify(url)},disabled:true}};const events=[];await plugin.default.setup({mcp:{transform:async fn=>{fn({list:()=>Object.entries(servers),update:(name,fn)=>fn(servers[name])});events.push("mcp");}},provider:{transform:async()=>{events.push("provider");}},session:{hook:async()=>{events.push("request");}}}); console.log(JSON.stringify({servers,events}));`,
    );
    const output = JSON.parse(result.stdout);
    expect(output.servers.duplicate.disabled).toBe(true);
    expect(output.servers.disabled_alias.disabled).toBe(true);
    expect(output.servers.deployment.disabled).toBeUndefined();
    expect(output.events).toEqual(["mcp", "provider", "request", "request"]);
  });

  test("V2 disk repair uses disabled flags and keeps deliberately disabled native bindings disabled", async () => {
    const files = await fixture({ client: OPENCODE_CLIENT, apiMajor: 2 });
    await writeFile(
      files.configPath,
      JSON.stringify({ mcp: { [name]: { type: "remote", url } } }),
      { mode: 0o600 },
    );
    const sibling = `// native V2\n{"mcp":{"duplicate":{"type":"remote","url":"${url}"},"kept_disabled":{"type":"remote","url":"${url}","disabled":true}}}`;
    await writeFile(files.siblingPath, sibling, { mode: 0o600 });
    await files.run(
      `globalThis.fetch=async()=>{throw Error("offline")}; const loader=(await import(${JSON.stringify(path.join(files.root, "bootstrap.cjs"))})).default; const runtime=await loader.refresh(${JSON.stringify(files.root)}); await (await import(runtime.directory+"/launcher.cjs")).default.prepare(runtime);`,
    );
    expect(await readFile(files.siblingPath, "utf8")).toBe(
      sibling.replace('"duplicate":{', '"duplicate":{"disabled":true,'),
    );
    expect(
      JSON.parse(await readFile(files.configPath, "utf8")).mcp[name],
    ).toEqual({ type: "remote", url });
  });

  test.each([
    "launch",
    "install",
  ])("%s retries when the previous owner releases the lock before inspection", async (operation) => {
    const files = await fixture();
    const action =
      operation === "launch"
        ? `await require(${JSON.stringify(path.join(files.root, "bootstrap.cjs"))}).locked(root, async () => {});`
        : `require(${JSON.stringify(files.installPath)});`;
    const result = await files.run(`
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const root = ${JSON.stringify(files.root)};
const lock = root + "/lock";
const mkdir = fs.mkdirSync;
let attempts = 0;
fs.mkdirSync = (file, ...args) => {
  if (file === lock && ++attempts === 1) {
    // The competing owner released its lock after mkdir observed EEXIST.
    const error = new Error("Already held");
    error.code = "EEXIST";
    throw error;
  }
  return mkdir(file, ...args);
};
${action}
console.log(JSON.stringify({ attempts, released: !fs.existsSync(lock) }));
`);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toEqual({
      attempts: 2,
      released: true,
    });
  });

  test.each([
    "launch",
    "install",
  ])("%s still rejects an unsafe existing lock", async (operation) => {
    const files = await fixture();
    const action =
      operation === "launch"
        ? `await require(${JSON.stringify(path.join(files.root, "bootstrap.cjs"))}).locked(root, async () => {});`
        : `require(${JSON.stringify(files.installPath)});`;
    await expect(
      files.run(`
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const root = ${JSON.stringify(files.root)};
const lock = root + "/lock";
fs.mkdirSync(lock, { mode: 0o700 });
fs.chmodSync(lock, 0o777);
${action}
`),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Unsafe managed runtime ownership"),
    });
  });

  test("concurrent offline startup repairs preserve one active alias and the original snapshot", async () => {
    const files = await fixture();
    await writeFile(
      files.configPath,
      JSON.stringify({ mcp: { [name]: { type: "remote", url } } }),
      { mode: 0o600 },
    );
    const sibling = `{"mcp":{"duplicate":{"type":"remote","url":"${url}"}}}`;
    await writeFile(files.siblingPath, sibling, { mode: 0o600 });
    const script = `globalThis.fetch=async()=>{throw Error("offline")}; const loader=(await import(${JSON.stringify(path.join(files.root, "bootstrap.cjs"))})).default; const runtime=await loader.refresh(${JSON.stringify(files.root)}); await (await import(runtime.directory+"/launcher.cjs")).default.prepare(runtime);`;
    await Promise.all([
      files.run(script),
      files.run(script),
      files.run(script),
    ]);
    expect(
      JSON.parse(await readFile(files.siblingPath, "utf8")).mcp.duplicate
        .enabled,
    ).toBe(false);
    expect(
      await readFile(`${files.siblingPath}.archestra-backup`, "utf8"),
    ).toBe(sibling);
  });

  test("external config edits during repair are detected before owned configuration is replaced", async () => {
    const files = await fixture();
    const owned = JSON.stringify({ mcp: { [name]: { type: "remote", url } } });
    const sibling = `{"mcp":{"duplicate":{"type":"remote","url":"${url}"}}}`;
    const changed = `{"note":"concurrent user edit","mcp":{"duplicate":{"type":"remote","url":"${url}"}}}`;
    await writeFile(files.configPath, owned, { mode: 0o600 });
    await writeFile(files.siblingPath, sibling, { mode: 0o600 });
    const result = await files.run(
      `import fs from "node:fs"; globalThis.fetch=async()=>{throw Error("offline")}; const loader=(await import(process.env.ARCH_TEST_BOOTSTRAP)).default; const runtime=await loader.refresh(process.env.ARCH_TEST_ROOT);const original=fs.readFileSync;let edited=false;fs.readFileSync=(file,...args)=>{const bytes=original(file,...args);if(file===process.env.ARCH_TEST_SIBLING&&!edited){edited=true;fs.writeFileSync(file,process.env.ARCH_TEST_CHANGED);}return bytes;};try{await (await import(runtime.directory+"/launcher.cjs")).default.prepare(runtime);}catch(error){console.log(error.message);}`,
      {
        ARCH_TEST_BOOTSTRAP: path.join(files.root, "bootstrap.cjs"),
        ARCH_TEST_ROOT: files.root,
        ARCH_TEST_SIBLING: files.siblingPath,
        ARCH_TEST_CHANGED: changed,
      },
    );
    expect(result.stdout).toContain("MCP config changed during alias repair");
    expect(await readFile(files.configPath, "utf8")).toBe(owned);
    expect(await readFile(files.siblingPath, "utf8")).toBe(changed);
  });

  test("binding proof contains actual matching aliases but never reaches vendor catalog/auth requests", async () => {
    const files = await fixture();
    const result = await files.run(
      `const requests=[];globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(new URL(request.url).pathname.endsWith("/runtime"))throw Error("offline");requests.push({url:request.url,headers:Object.fromEntries(request.headers)});return new Response("ok");};const plugin=await import(${JSON.stringify(files.pluginPath)});const hooks=await plugin.ArchestraLlmProxy();await hooks.config({provider:{anthropic:{options:{apiKey:"example"}}},mcp:{deployment:{type:"remote",url:${JSON.stringify(url)}},legacy_disabled:{type:"remote",url:${JSON.stringify(url)},enabled:false},foreign:{type:"remote",url:"https://foreign.example.com/mcp"}}});const output={headers:{}};await hooks["chat.headers"]({provider:{id:"anthropic"},sessionID:"bound-session",agent:"build"},output);await fetch("https://api.openai.com/v1/models",{headers:output.headers});await fetch("https://deployment.example.com/api/unrelated/responses",{headers:output.headers});await fetch("https://deployment.example.com/v1/anthropic/messages",{headers:output.headers});console.log(JSON.stringify(requests));`,
    );
    const requests = JSON.parse(result.stdout);
    expect(
      requests[0].headers["x-archestra-client-runtime-token"],
    ).toBeUndefined();
    expect(
      requests[1].headers["x-archestra-client-runtime-token"],
    ).toBeUndefined();
    expect(requests[2].headers["x-archestra-client-runtime-token"]).toBe(
      `cru1_${installation}.example`,
    );
    expect(JSON.parse(requests[2].headers["x-archestra-mcp-aliases"])).toEqual([
      name,
      "legacy_disabled",
    ]);
  });

  test("V1 binding proof is factory/session-scoped and cleared if later repair fails", async () => {
    const files = await fixture();
    const result = await files.run(`
import fs from "node:fs";
const requests = [];
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).pathname.endsWith("/runtime")) throw Error("offline");
  requests.push(Object.fromEntries(request.headers));
  return new Response("ok");
};
const plugin = await import(${JSON.stringify(files.pluginPath)});
const foreign = await plugin.ArchestraLlmProxy();
const trusted = await plugin.ArchestraLlmProxy();
const provider = { anthropic: { options: { apiKey: "example" } } };
await foreign.config({ provider, mcp: { deployment: { type: "remote", url: "https://foreign.example.com/mcp" } } });
await trusted.config({ provider, mcp: { deployment: { type: "remote", url: ${JSON.stringify(url)} } } });
const emit = async (hooks, sessionID) => {
  const output = { headers: {} };
  await hooks["chat.headers"]({ provider: { id: "anthropic" }, sessionID, agent: "build" }, output);
  await fetch("https://deployment.example.com/v1/anthropic/messages", { headers: output.headers });
};
await emit(foreign, "foreign-session");
await emit(trusted, "trusted-session");
fs.writeFileSync(${JSON.stringify(path.join(files.home, ".archestra/kilo-startup-guard.skip"))}, "mcp\\n", { mode: 0o600 });
await fetch("https://deployment.example.com/v1/anthropic/messages", { headers: { "x-opencode-session": "trusted-session" } });
fs.unlinkSync(${JSON.stringify(path.join(files.home, ".archestra/kilo-startup-guard.skip"))});
try {
  await trusted.config({ provider, mcp: {
    deployment: { type: "remote", url: ${JSON.stringify(url)}, headers: { Authorization: "Bearer one" } },
    duplicate: { type: "remote", url: ${JSON.stringify(url)}, headers: { Authorization: "Bearer two" } },
  } });
} catch {}
// Even requests using previously returned headers must lose the failed proof.
await fetch("https://deployment.example.com/v1/anthropic/messages", { headers: { "x-opencode-session": "trusted-session" } });
await emit(trusted, "trusted-session");
console.log(JSON.stringify(requests));
`);
    const requests = JSON.parse(result.stdout);
    expect(requests[0]["x-archestra-client-runtime-token"]).toBeUndefined();
    expect(requests[0]["x-archestra-question-cards"]).toBeUndefined();
    expect(requests[1]["x-archestra-client-runtime-token"]).toBe(
      `cru1_${installation}.example`,
    );
    expect(requests[1]["x-archestra-question-cards"]).toBe("1");
    expect(requests[2]["x-archestra-client-runtime-token"]).toBeUndefined();
    expect(requests[2]["x-archestra-question-cards"]).toBeUndefined();
    expect(requests[3]["x-archestra-client-runtime-token"]).toBeUndefined();
    expect(requests[4]["x-archestra-client-runtime-token"]).toBeUndefined();
    expect(requests[4]["x-archestra-question-cards"]).toBeUndefined();
  });

  test("Unicode alias evidence is ASCII-escaped for HTTP without changing its identity", async () => {
    const files = await fixture();
    const alias = "\u7f51\u5173";
    const result = await files.run(`
let captured;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).pathname.endsWith("/runtime")) throw Error("offline");
  captured = { aliases: request.headers.get("x-archestra-mcp-aliases"), redirect: request.redirect };
  return new Response("ok");
};
const plugin = await import(${JSON.stringify(files.pluginPath)});
const hooks = await plugin.ArchestraLlmProxy();
await hooks.config({ provider: { anthropic: { options: { apiKey: "example" } } }, mcp: {
  deployment: { type: "remote", url: ${JSON.stringify(url)} },
  [${JSON.stringify(alias)}]: { type: "remote", url: ${JSON.stringify(url)}, enabled: false },
} });
const output = { headers: {} };
await hooks["chat.headers"]({ provider: { id: "anthropic" }, sessionID: "unicode-session", agent: "build" }, output);
await fetch("https://deployment.example.com/v1/anthropic/messages", { headers: output.headers });
console.log(JSON.stringify(captured));
`);
    const captured = JSON.parse(result.stdout);
    expect(
      [...captured.aliases].every((char) => char.charCodeAt(0) < 128),
    ).toBe(true);
    expect(JSON.parse(captured.aliases)).toEqual([name, alias]);
    expect(captured.redirect).toBe("error");
  });

  test("V2 scopes proof by setup, clears failed transforms, and stamps only final managed inference HTTP", async () => {
    const files = await fixture({ client: OPENCODE_CLIENT, apiMajor: 2 });
    await writeFile(files.pluginPath, files.install.v2);
    const result = await files.run(`
import fs from "node:fs";
globalThis.fetch = async () => { throw Error("offline"); };
const plugin = await import(${JSON.stringify(files.pluginPath)});
const setup = async (url) => {
  const servers = { deployment: { type: "remote", url } };
  const hooks = {}; let transform;
  const editor = { list: () => Object.entries(servers), update: (name, fn) => fn(servers[name]) };
  await plugin.default.setup({
    mcp: { transform: async fn => { transform = fn; fn(editor); } },
    provider: { transform: async fn => fn({ list: () => [] }) },
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
  });
  return { servers, hooks, reload: () => transform(editor) };
};
const foreign = await setup("https://foreign.example.com/mcp");
const trusted = await setup(${JSON.stringify(url)});
const emit = (instance, target) => {
  const event = { request: new Request(target, { headers: {
    "x-archestra-client-runtime-token": "untrusted-input",
    "x-archestra-mcp-aliases": "untrusted-input",
  } }) };
  instance.hooks["http.request"](event);
  return { ...Object.fromEntries(event.request.headers), redirect: event.request.redirect };
};
const requests = [emit(foreign, "https://deployment.example.com/v1/anthropic/messages"), emit(trusted, "https://deployment.example.com/v1/anthropic/messages"), emit(trusted, "https://api.openai.com/v1/models"), emit(trusted, "https://deployment.example.com/api/unrelated/responses")];
fs.writeFileSync(${JSON.stringify(path.join(files.home, ".archestra/opencode-startup-guard.skip"))}, "mcp\\n", { mode: 0o600 });
requests.push(emit(trusted, "https://deployment.example.com/v1/anthropic/messages"));
fs.unlinkSync(${JSON.stringify(path.join(files.home, ".archestra/opencode-startup-guard.skip"))});
const model = { model: { providerID: "anthropic" }, agent: "build", headers: {} };
trusted.hooks["model.request"](model);
trusted.servers.deployment.headers = { Authorization: "Bearer one" };
trusted.servers.duplicate = { type: "remote", url: ${JSON.stringify(url)}, headers: { Authorization: "Bearer two" } };
try { trusted.reload(); } catch {}
requests.push(emit(trusted, "https://deployment.example.com/v1/anthropic/messages"));
console.log(JSON.stringify({ requests, model }));
`);
    const output = JSON.parse(result.stdout);
    expect(
      output.requests[0]["x-archestra-client-runtime-token"],
    ).toBeUndefined();
    expect(output.requests[1]["x-archestra-client-runtime-token"]).toBe(
      `cru1_${installation}.example`,
    );
    expect(output.requests[1].redirect).toBe("error");
    for (const headers of output.requests.slice(2)) {
      expect(headers["x-archestra-client-runtime-token"]).toBeUndefined();
      expect(headers["x-archestra-mcp-aliases"]).toBeUndefined();
    }
    expect(
      output.model.headers["x-archestra-client-runtime-token"],
    ).toBeUndefined();
  });
});
