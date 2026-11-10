import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, test } from "vitest";
import { HISTORICAL_GROK_SETUPS } from "../../../test/fixtures/grok-historical-setups";
import { GROK_CONFIG } from "../payloads/grok-config";
import { GROK_CONFIG_TRANSACTION } from "../payloads/grok-config-transaction";
import type { SetupScriptContext } from "../types";
import { grokSetup } from "./grok";

const context: SetupScriptContext = {
  clientId: "grok-build",
  platform: "windows",
  appName: "Synthetic Platform",
  skills: null,
  mcp: {
    serverName: "gateway",
    toolPrefix: "archestra",
    url: "https://proxy.example/v1/mcp/gateway",
  },
  proxy: {
    authMode: "virtual-key",
    provider: "xai",
    providerLabel: "xAI",
    baseUrl: "https://proxy.example",
    url: "https://proxy.example/v1/xai/proxy",
    proxyName: "proxy",
    virtualKey: "synthetic-private-key",
    virtualKeyName: "test",
    passthroughVirtualKey: null,
    model: "synthetic-model",
  },
};
const homes: string[] = [];
function requiredProxy() {
  if (!context.proxy) throw new Error("Synthetic fixture requires a proxy");
  return context.proxy;
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "grok semantic 日本語 "));
  homes.push(home);
  const nativeHome = path.join(home, "custom grok"),
    root = path.join(home, ".archestra/grok"),
    config = path.join(nativeHome, "config.toml");
  mkdirSync(nativeHome);
  const original =
    '# preserve user comment\n[models]\ndefault = "user-default"\nweb_search = "user-search"\ntemperature = 0.25\n[ui]\ntheme = "dark"\n[model.user]\nmodel = "user-model"\n';
  writeFileSync(config, original);
  const env = { ...process.env, HOME: home, GROK_HOME: nativeHome };
  const run = (
    script = grokSetup.bash.sections(context).join("\n"),
    overrides = {},
  ) =>
    spawnSync("bash", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { ...env, ...overrides },
      cwd: home,
    });
  const native = (args: string[]) =>
    spawnSync(process.env.ARCHESTRA_GROK_TEST_BINARY || "grok", args, {
      env,
      encoding: "utf8",
      cwd: home,
    });
  const command = (file: string, args: string[] = [], overrides = {}) =>
    spawnSync(process.execPath, [path.join(root, file), ...args], {
      encoding: "utf8",
      env: { ...env, ...overrides },
      cwd: home,
    });
  return {
    home,
    nativeHome,
    root,
    config,
    managedConfig: path.join(root, "native/config.toml"),
    original,
    env,
    run,
    native,
    command,
  };
}
function historical(name: keyof typeof HISTORICAL_GROK_SETUPS) {
  const record = HISTORICAL_GROK_SETUPS[name],
    script = gunzipSync(Buffer.from(record.gzip, "base64")).toString();
  expect(createHash("sha256").update(script).digest("hex")).toBe(record.sha256);
  return script;
}

test
  .skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)
  .each(["8f637", "5600", "71b2"] as const)(
  "real %s installer -> native save -> semantic reconnect twice, sync and disconnect",
  (name) => {
    const current = fixture();
    expect(current.run(historical(name)).status).toBe(0);
    const saved = current.native([
      "mcp",
      "add",
      "user-extra",
      "https://extra.example/mcp",
      "--scope",
      "user",
    ]);
    expect(saved.status, saved.stderr).toBe(0);
    expect(readFileSync(current.config, "utf8")).not.toContain(
      "# BEGIN ARCHESTRA",
    );
    expect(current.run(historical(name)).status).not.toBe(0);
    const expected = parse(readFileSync(current.config, "utf8"));
    expected.models = parse(current.original).models;
    delete (expected.model as Record<string, unknown>).archestra;
    delete (expected.mcp_servers as Record<string, unknown>).gateway;
    for (const attempt of [1, 2]) {
      const result = current.run();
      expect(result.status, `${attempt}: ${result.stderr}`).toBe(0);
    }
    expect(parse(readFileSync(current.config, "utf8"))).toEqual(expected);
    expect(current.command("launch.cjs", ["--sync"]).status).toBe(0);
    const launched = current.command("launch.cjs", ["--version"], {
      PATH:
        path.dirname(process.env.ARCHESTRA_GROK_TEST_BINARY || "") +
        path.delimiter +
        process.env.PATH,
    });
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toContain("1.0.70");
    const disconnected = current.command("disconnect.cjs");
    expect(disconnected.status, disconnected.stderr).toBe(0);
    const restored = parse(readFileSync(current.config, "utf8"));
    expect(restored.models).toEqual(parse(current.original).models);
    expect(restored.model).toEqual(parse(current.original).model);
    expect(restored.mcp_servers).toEqual({
      "user-extra": { url: "https://extra.example/mcp", enabled: true },
    });
    expect(restored.ui).toEqual({ theme: "dark" });
  },
);

test.each([
  "roundtrip",
  "reordered",
  "quoted-bom-crlf",
  "inline",
])("semantic ownership accepts %s without losing unrelated values", (mode) => {
  const current = fixture();
  expect(current.run(historical("71b2")).status).toBe(0);
  const object = parse(readFileSync(current.config, "utf8"));
  object.marketplace = {
    api_key: "synthetic-unrelated-value",
    huge: BigInt("9007199254740993"),
  };
  let rewritten = stringify(
    mode === "reordered"
      ? Object.fromEntries(Object.entries(object).reverse())
      : object,
  );
  if (mode === "quoted-bom-crlf")
    rewritten =
      "\uFEFF" +
      rewritten
        .replaceAll("[model.archestra]", "[ 'model' . 'archestra' ]")
        .replaceAll("\n", "\r\n");
  if (mode === "inline")
    rewritten = rewritten
      .replace(/\[model.archestra.extra_headers\][\s\S]*?(?=\n\[|$)/, "")
      .replace(
        "[model.archestra]\n",
        '[model.archestra]\nextra_headers = { "X-Archestra-Agent-Id" = "grok-build" }\n',
      );
  writeFileSync(current.config, rewritten);
  const result = current.run();
  expect(result.status, result.stderr).toBe(0);
  expect(
    parse(readFileSync(current.config, "utf8"), {
      integersAsBigInt: "asNeeded",
    }).marketplace,
  ).toEqual(object.marketplace);
  expect(current.command("disconnect.cjs").status).toBe(0);
  expect(
    parse(readFileSync(current.config, "utf8"), {
      integersAsBigInt: "asNeeded",
    }).models,
  ).toEqual(parse(current.original).models);
});

test.each([
  "base_url",
  "api_key",
  "model",
  "extra",
])("real %s conflicts preserve config and a private backup, never echo values", (field) => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const object = parse(readFileSync(current.managedConfig, "utf8")) as {
    model: { archestra: Record<string, unknown> };
  };
  object.model.archestra[field] = "synthetic-changed-private-value";
  const changed = stringify(object);
  writeFileSync(current.managedConfig, changed);
  const result = current.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    field === "extra" ? "unowned fields" : "owned-value-mismatch",
  );
  expect(result.stderr).not.toContain("synthetic-changed-private-value");
  expect(readFileSync(current.managedConfig, "utf8")).toBe(changed);
  const backup = readdirSync(current.root).find((name) =>
    name.startsWith("conflict-"),
  );
  expect(backup).toBeTruthy();
  expect(
    statSync(path.join(current.root, backup || "", "config.toml")).mode & 0o777,
  ).toBe(0o600);
});

test("legacy snapshot-first interruption with wholly absent managed paths migrates without claiming another table", () => {
  const current = fixture();
  expect(current.run(historical("71b2")).status).toBe(0);
  writeFileSync(current.config, current.original);
  const result = current.run();
  expect(result.status, result.stderr).toBe(0);
  expect(current.command("disconnect.cjs").status).toBe(0);
  expect(readFileSync(current.config, "utf8")).toBe(current.original);
});

test("unprovable legacy torn credential pair refuses with an actionable private backup", () => {
  const current = fixture();
  expect(current.run(historical("71b2")).status).toBe(0);
  const snapshot = path.join(current.root, "connection.json"),
    state = JSON.parse(readFileSync(snapshot, "utf8"));
  state.block = state.block.replace(
    "synthetic-private-key",
    "synthetic-new-key",
  );
  writeFileSync(snapshot, JSON.stringify(state));
  const before = readFileSync(current.config, "utf8"),
    result = current.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("local confirmation");
  expect(readFileSync(current.config, "utf8")).toBe(before);
});

test.each([
  "duplicate",
  "malformed",
  "snapshot-home",
])("invalid %s state is refused without overwriting files", (mode) => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  if (mode === "snapshot-home") {
    const snapshot = path.join(current.root, "connection.json"),
      state = JSON.parse(readFileSync(snapshot, "utf8"));
    state.config = path.join(current.home, "foreign.toml");
    writeFileSync(snapshot, JSON.stringify(state));
  } else
    writeFileSync(
      current.config,
      readFileSync(current.config, "utf8") +
        (mode === "duplicate"
          ? '\n[model.archestra]\nmodel="other"\n'
          : '\ninvalid = "'),
    );
  const before = readFileSync(current.config, "utf8"),
    result = current.run();
  expect(result.status).not.toBe(0);
  expect(readFileSync(current.config, "utf8")).toBe(before);
});

test.each([
  "config.toml",
  "connection.json",
  "skills.cjs",
  "launch.cjs",
  "sign-in.cjs",
  "disconnect.cjs",
])("failed atomic rename of %s restores the complete previous generation", (target) => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const files = [
    current.config,
    ...[
      "connection.json",
      "skills.cjs",
      "launch.cjs",
      "sign-in.cjs",
      "disconnect.cjs",
    ].map((name) => path.join(current.root, name)),
  ];
  const before = files.map((file) => readFileSync(file));
  const preload = path.join(current.home, "fault.cjs");
  writeFileSync(
    preload,
    `const fs=require('fs'), original=fs.renameSync;let injected=false;fs.renameSync=function(from,to){if(!injected && require('path').basename(to)===${JSON.stringify(target)}){injected=true;throw Object.assign(new Error('synthetic locked file'),{code:'EPERM'});}return original.apply(this,arguments);};`,
  );
  const result = current.run(undefined, {
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "previous configuration, snapshot and helpers were restored",
  );
  files.forEach((file, index) => {
    expect(readFileSync(file)).toEqual(before[index]);
  });
  expect(existsSync(path.join(current.root, "update.json"))).toBe(false);
  expect(current.run().status).toBe(0);
});

test.each([
  "update.json",
  "config.toml",
  "connection.json",
  "skills.cjs",
  "launch.cjs",
  "sign-in.cjs",
  "disconnect.cjs",
])("next installer recovers abrupt exit after committing %s", (target) => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const script = grokSetup.bash
    .sections({
      ...context,
      proxy: { ...requiredProxy(), model: "synthetic-updated" },
    })
    .join("\n");
  const preload = path.join(current.home, "crash.cjs");
  writeFileSync(
    preload,
    `const fs=require('fs'),original=fs.renameSync;fs.renameSync=function(from,to){const result=original.apply(this,arguments);if(require('path').basename(to)===${JSON.stringify(target)})process.kill(process.pid,'SIGKILL');return result;};`,
  );
  const interrupted = current.run(script, {
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  });
  expect(interrupted.status).toBe(137);
  expect(existsSync(path.join(current.root, "update.json"))).toBe(true);
  const recovered = current.run(script);
  expect(recovered.status, recovered.stderr).toBe(0);
  expect(
    (
      parse(readFileSync(current.managedConfig, "utf8")).model as {
        archestra: { model: string };
      }
    ).archestra.model,
  ).toBe("synthetic-updated");
  expect(existsSync(path.join(current.root, "update.json"))).toBe(false);
  expect(current.command("launch.cjs", ["--sync"]).status).toBe(0);
  expect(current.command("disconnect.cjs").status).toBe(0);
  expect(readFileSync(current.config, "utf8")).toBe(current.original);
});

test.each([
  "update.json",
  "connection.json",
])("private %s write failure cannot leave a torn config/snapshot pair", (target) => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const before = readFileSync(current.config),
    state = readFileSync(path.join(current.root, "connection.json"));
  const preload = path.join(current.home, "write-fault.cjs");
  writeFileSync(
    preload,
    `const fs=require('fs'),original=fs.openSync;let injected=false;fs.openSync=function(file,...args){if(!injected&&require('path').basename(file).startsWith(${JSON.stringify(`${target}.`)})){injected=true;throw Object.assign(new Error('synthetic write failure'),{code:'EACCES'});}return original.call(this,file,...args);};`,
  );
  expect(
    current.run(undefined, {
      NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
    }).status,
  ).not.toBe(0);
  expect(readFileSync(current.config)).toEqual(before);
  expect(readFileSync(path.join(current.root, "connection.json"))).toEqual(
    state,
  );
  expect(current.run().status).toBe(0);
});

test("rollback failure retains private verified generations and a subsequent installer recovers", () => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const script = grokSetup.bash
    .sections({
      ...context,
      proxy: { ...requiredProxy(), model: "synthetic-updated" },
    })
    .join("\n");
  const preload = path.join(current.home, "rollback-fault.cjs");
  writeFileSync(
    preload,
    `const fs=require('fs'),original=fs.renameSync;let failed=false;fs.renameSync=function(from,to){const name=require('path').basename(to);if(name==='config.toml'&&failed)throw new Error('synthetic rollback failure');const result=original.apply(this,arguments);if(name==='connection.json'&&!failed){failed=true;throw new Error('synthetic state failure after rename');}return result;};`,
  );
  const result = current.run(script, {
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "Private update.json retains verified before/after backups",
  );
  expect(statSync(path.join(current.root, "update.json")).mode & 0o777).toBe(
    0o600,
  );
  const recovered = current.run(script);
  expect(recovered.status, recovered.stderr).toBe(0);
  expect(current.command("disconnect.cjs").status).toBe(0);
  expect(readFileSync(current.config, "utf8")).toBe(current.original);
});

test("native concurrent writes are preserved and block recovery rather than being overwritten", () => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const preload = path.join(current.home, "concurrent.cjs");
  writeFileSync(
    preload,
    `const fs=require('fs'),original=fs.renameSync;let injected=false;fs.renameSync=function(from,to){const result=original.apply(this,arguments);if(require('path').basename(to)==='connection.json'&&!injected){injected=true;fs.appendFileSync(${JSON.stringify(current.config)},'\\n[concurrent]\\nkeep = true\\n');}return result;};`,
  );
  const result = current.run(undefined, {
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  });
  expect(result.status).not.toBe(0);
  const changed = readFileSync(current.config, "utf8");
  expect(parse(changed).concurrent).toEqual({ keep: true });
  const recovery = current.run();
  expect(recovery.status).not.toBe(0);
  expect(recovery.stderr).toContain("concurrent change");
  expect(readFileSync(current.config, "utf8")).toBe(changed);
});

test("known native model sampling and gateway enable/timeout extensions remain user-owned", () => {
  const current = fixture();
  expect(current.run(historical("71b2")).status).toBe(0);
  const object = parse(readFileSync(current.config, "utf8")) as {
    model: { archestra: Record<string, unknown> };
    mcp_servers: { gateway: Record<string, unknown> };
  };
  object.model.archestra.temperature = 0.5;
  object.mcp_servers.gateway.enabled = true;
  object.mcp_servers.gateway.tool_timeout_sec = 100;
  writeFileSync(current.config, stringify(object));
  for (const attempt of [1, 2]) {
    const result = current.run();
    expect(result.status, `${attempt}: ${result.stderr}`).toBe(0);
  }
  const disconnected = current.command("disconnect.cjs");
  expect(disconnected.status, disconnected.stderr).toBe(0);
  const after = parse(readFileSync(current.config, "utf8")) as typeof object;
  expect(after.model.archestra).toEqual({ temperature: 0.5 });
  expect(after.mcp_servers.gateway).toEqual({
    enabled: true,
    tool_timeout_sec: 100,
  });
});

test("Automatic pending -> resolved migration uses one recoverable generation and preserves reserialized roles", () => {
  const current = fixture();
  const automatic = {
    ...context,
    proxy: {
      ...requiredProxy(),
      model: null,
      authMode: "provider-key" as const,
      virtualKey: null,
    },
  };
  const script = grokSetup.bash.sections(automatic).join("\n");
  expect(current.run(script, { XAI_API_KEY: "" }).status).toBe(0);
  writeFileSync(
    current.config,
    stringify(parse(readFileSync(current.config, "utf8"))),
  );
  const preload = path.join(current.home, "discovery.cjs");
  writeFileSync(
    preload,
    `global.fetch=async function(url){if(String(url).endsWith('/models.md'))return new Response('### Text API Pricing\\n| grok-4.7 | text |\\n### Other\\nCode: [Recommended](/developers/models/grok-4.7)\\n');if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'grok-4.7',created:30}]}));return new Response('**Model name:** \\x60grok-4.7\\x60\\n**Modalities:** text, image → text\\n**Function calling:** Yes\\n');};`,
  );
  const result = current.command("launch.cjs", ["--archestra-prepare-model"], {
    XAI_API_KEY: "synthetic-local-key",
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  });
  expect(result.status, result.stderr).toBe(0);
  const state = JSON.parse(
    readFileSync(path.join(current.root, "connection.json"), "utf8"),
  );
  expect(state).toMatchObject({ format: 2, modelResolved: true });
  const config = parse(readFileSync(current.managedConfig, "utf8")) as {
    model: { archestra: { model: string } };
  };
  expect(config.model.archestra.model).toBe("grok-4.7");
  expect(parse(readFileSync(current.config, "utf8")).models).toEqual(
    parse(current.original).models,
  );
  expect(current.run(script, { XAI_API_KEY: "" }).status).toBe(0);
  expect(parse(readFileSync(current.config, "utf8")).models).toEqual(
    parse(current.original).models,
  );
  expect(current.command("disconnect.cjs").status).toBe(0);
  expect(parse(readFileSync(current.config, "utf8")).models).toEqual(
    parse(current.original).models,
  );
});

test.each([
  'model = "unowned"',
  'mcp_servers = ["unowned"]',
  'models = "unowned"',
])("a non-table native namespace %s is refused before writing credentials", (original) => {
  const current = fixture();
  writeFileSync(current.config, original);
  const result = current.run();
  expect(result.status).not.toBe(0);
  expect(readFileSync(current.config, "utf8")).toBe(original);
  expect(existsSync(path.join(current.root, "connection.json"))).toBe(false);
});

test.each([
  "models = []",
  'models = ["user-role"]',
  '[[models]]\ndefault = "user-role"',
  "models = false",
])("non-table %s is refused in MCP-only setup and disconnect without any config backup or helper commit", (original) => {
  const current = fixture();
  writeFileSync(current.config, original);
  const script = grokSetup.bash
    .sections({ ...context, proxy: null })
    .join("\n");
  const result = current.run(script);
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toContain("models must be a TOML table");
  expect(readFileSync(current.config, "utf8")).toBe(original);
  expect(existsSync(path.join(current.root, "connection.json"))).toBe(false);
  expect(existsSync(path.join(current.root, "launch.cjs"))).toBe(false);
  expect(existsSync(path.join(current.root, "config-history"))).toBe(false);
  writeFileSync(current.config, current.original);
  expect(current.run().status).toBe(0);
  const changed = `${original}\n`;
  writeFileSync(current.managedConfig, changed);
  const state = readFileSync(path.join(current.root, "connection.json"));
  const disconnected = current.command("disconnect.cjs");
  expect(disconnected.status).not.toBe(0);
  expect(disconnected.stderr).toContain("models must be a TOML table");
  expect(readFileSync(current.managedConfig, "utf8")).toBe(changed);
  expect(readFileSync(path.join(current.root, "connection.json"))).toEqual(
    state,
  );
  expect(
    readdirSync(current.root).filter((name) => name.startsWith("conflict-")),
  ).toEqual([]);
});

test.each(
  ['"""', "'''"].flatMap((quote) =>
    [
      '["models"]\ndefault = "user-default"',
      'models.default = "user-default"',
      'models = { default = "user-default" }',
    ].map((roles) => ({ quote, roles })),
  ),
)("multiline $quote text containing fake headers with $roles preserves user data during install and restore", ({
  quote,
  roles,
}) => {
  const current = fixture();
  const original = `memo = ${quote}\n[models]\ndefault = "not a role"\n[ui]\n${quote}\n${roles}\n[ui]\ntheme = "dark"\n`;
  writeFileSync(current.config, original);
  for (const attempt of [1, 2]) {
    const installed = current.run();
    expect(installed.status, `${attempt}: ${installed.stderr}`).toBe(0);
    expect(parse(readFileSync(current.config, "utf8")).memo).toBe(
      parse(original).memo,
    );
  }
  expect(current.command("disconnect.cjs").status).toBe(0);
  expect(parse(readFileSync(current.config, "utf8"))).toEqual(parse(original));
});

test.each([
  "conflict",
  "history",
])("direct generated %s helper validates all private ancestors before creating any backup", (operation) => {
  for (const boundary of [
    "archestra-link",
    "root-link",
    "archestra-permissions",
    "root-permissions",
    "history-link",
    "history-permissions",
    "history-file",
  ]) {
    if (operation === "conflict" && boundary.startsWith("history")) continue;
    const current = fixture();
    const outside = path.join(current.home, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(path.join(outside, "preserve"), "synthetic-unmanaged");
    const parent = path.dirname(current.root);
    if (boundary === "archestra-link") symlinkSync(outside, parent, "dir");
    else {
      mkdirSync(parent, { mode: 0o700 });
      if (boundary === "root-link") symlinkSync(outside, current.root, "dir");
      else mkdirSync(current.root, { mode: 0o700 });
    }
    if (boundary === "archestra-permissions") chmodSync(parent, 0o777);
    if (boundary === "root-permissions") chmodSync(current.root, 0o755);
    const history = path.join(current.root, "config-history");
    if (boundary === "history-link") symlinkSync(outside, history, "dir");
    if (boundary === "history-permissions") {
      mkdirSync(history, { mode: 0o700 });
      chmodSync(history, 0o755);
    }
    if (boundary === "history-file") writeFileSync(history, "unmanaged");
    const source =
      `const fs=require('node:fs'),path=require('node:path');function writeAtomic(file,bytes){fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});}\n${GROK_CONFIG_TRANSACTION}\n${GROK_CONFIG}\n` +
      (operation === "conflict"
        ? `grokConflict({current:'synthetic-private-value',invariant:'test'});`
        : `withoutManagedConfig('[model.archestra]\\nmodel="synthetic-private-value"\\n',{block:'[model.archestra]\\nmodel="synthetic-private-value"\\n'});`);
    const result = spawnSync(process.execPath, ["-e", source], {
      env: current.env,
      encoding: "utf8",
    });
    expect(result.status, boundary).not.toBe(0);
    expect(result.stderr, boundary).not.toContain("synthetic-private-value");
    expect(readdirSync(outside), boundary).toEqual(["preserve"]);
    expect(readFileSync(path.join(outside, "preserve"), "utf8")).toBe(
      "synthetic-unmanaged",
    );
    if (!["archestra-link", "root-link"].includes(boundary)) {
      expect(
        readdirSync(current.root).filter((name) =>
          name.startsWith("conflict-"),
        ),
        boundary,
      ).toEqual([]);
      if (boundary.endsWith("permissions") && !boundary.startsWith("history"))
        expect(existsSync(history), boundary).toBe(false);
    }
  }
});

test("Automatic without a caller key preserves native roles, refuses managed launch and pins every role only after verified discovery", () => {
  const current = fixture();
  const script = grokSetup.bash
    .sections({
      ...context,
      proxy: {
        ...requiredProxy(),
        authMode: "provider-key",
        virtualKey: null,
        model: null,
      },
    })
    .join("\n");
  const result = current.run(script, { XAI_API_KEY: "" });
  expect(result.status, result.stderr).toBe(0);
  expect(parse(readFileSync(current.config, "utf8")).models).toEqual(
    parse(current.original).models,
  );
  expect(
    parse(readFileSync(current.config, "utf8")).model as object,
  ).not.toHaveProperty("archestra");
  expect(
    JSON.parse(readFileSync(path.join(current.root, "connection.json"), "utf8"))
      .modelRouting,
  ).toBeNull();
  const marker = path.join(current.home, "native-started");
  const bin = path.join(current.home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "grok"), `#!/bin/sh\ntouch '${marker}'\n`, {
    mode: 0o700,
  });
  const stopped = current.command("launch.cjs", ["--version"], {
    XAI_API_KEY: "",
    PATH: bin + path.delimiter + process.env.PATH,
  });
  expect(stopped.status).not.toBe(0);
  expect(stopped.stderr).toContain("Set XAI_API_KEY in this terminal");
  expect(stopped.stderr).not.toContain("choose an explicit model");
  expect(existsSync(marker)).toBe(false);
  expect(
    current.command("launch.cjs", ["--sync"], { XAI_API_KEY: "" }).status,
  ).toBe(0);
  expect(current.command("disconnect.cjs").status).toBe(0);
  expect(parse(readFileSync(current.config, "utf8"))).toEqual(
    parse(current.original),
  );
});

test.each([
  "xai",
  "openai",
  "anthropic",
] as const)("pinned %s passthrough with absent key preserves native roles and remains fail-closed", (provider) => {
  const current = fixture();
  const script = grokSetup.bash
    .sections({
      ...context,
      proxy: {
        ...requiredProxy(),
        provider,
        authMode: "provider-key",
        virtualKey: null,
      },
    })
    .join("\n");
  const cleared = {
    XAI_API_KEY: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  };
  expect(current.run(script, cleared).status).toBe(0);
  expect(parse(readFileSync(current.config, "utf8")).models).toEqual(
    parse(current.original).models,
  );
  const start = current.command("launch.cjs", ["--version"], cleared);
  expect(start.status).not.toBe(0);
  expect(start.stderr).toContain(
    `Set ${provider === "xai" ? "XAI" : provider === "openai" ? "OPENAI" : "ANTHROPIC"}_API_KEY`,
  );
  expect(current.command("disconnect.cjs").status).toBe(0);
  expect(parse(readFileSync(current.config, "utf8"))).toEqual(
    parse(current.original),
  );
});

test("first-install failure restores an originally absent config and snapshot rather than leaving empty managed files", () => {
  const current = fixture();
  unlinkSync(current.config);
  const preload = path.join(current.home, "first-install.cjs");
  writeFileSync(
    preload,
    "const fs=require('fs'),original=fs.renameSync;fs.renameSync=function(from,to){if(require('path').basename(to)==='connection.json')throw new Error('synthetic state rename failure');return original.apply(this,arguments);};",
  );
  const result = current.run(undefined, {
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  });
  expect(result.status).not.toBe(0);
  expect(existsSync(current.config)).toBe(false);
  expect(existsSync(path.join(current.root, "connection.json"))).toBe(false);
  expect(current.run().status).toBe(0);
});

test("a native rewrite while the config temporary file is being flushed is detected before replacement", () => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const preload = path.join(current.home, "flush-concurrent.cjs");
  writeFileSync(
    preload,
    `const fs=require('fs'),originalOpen=fs.openSync,originalSync=fs.fsyncSync;let target,changed=false;fs.openSync=function(file,...args){const fd=originalOpen.call(this,file,...args);if(typeof file==='string'&&require('path').basename(file).startsWith('config.toml.')&&String(args[0])==='wx')target=fd;return fd;};fs.fsyncSync=function(fd){const result=originalSync.call(this,fd);if(fd===target&&!changed){changed=true;fs.appendFileSync(${JSON.stringify(current.config)},'\\n[concurrent]\\nkeep=true\\n');}return result;};`,
  );
  const result = current.run(undefined, {
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  });
  expect(result.status).not.toBe(0);
  expect(parse(readFileSync(current.config, "utf8")).concurrent).toEqual({
    keep: true,
  });
  expect(existsSync(path.join(current.root, "update.json"))).toBe(true);
});

test.each([
  "RESTORE",
  "NO",
])("interactive historical conflict requires explicit local %s consent; heredoc stdin is not mistaken for the terminal", (answer) => {
  const current = fixture();
  expect(current.run(historical("71b2")).status).toBe(0);
  const changed = readFileSync(current.config, "utf8").replace(
    "synthetic-model",
    "synthetic-local-override",
  );
  writeFileSync(current.config, changed);
  const setup = path.join(current.home, "setup.sh");
  writeFileSync(setup, grokSetup.bash.sections(context).join("\n"));
  const proof = spawnSync(
    "python3",
    [
      "-c",
      `import os,pty,select,sys,time,json\npid,fd=pty.fork()\nif pid==0: os.execvp('bash',['bash',sys.argv[1]])\noutput=b'';sent=False;deadline=time.monotonic()+20\nwhile time.monotonic()<deadline:\n if select.select([fd],[],[],0.1)[0]:\n  try: chunk=os.read(fd,65536)\n  except OSError: break\n  if not chunk: break\n  output+=chunk\n  if b'Type RESTORE' in output and not sent: os.write(fd,sys.argv[2].encode()+b'\\n');sent=True\nelse: os.kill(pid,9)\n_,status=os.waitpid(pid,0)\nprint(json.dumps({'exit':os.waitstatus_to_exitcode(status),'prompt':b'Type RESTORE' in output,'leaked':b'synthetic-local-override' in output}))`,
      setup,
      answer,
    ],
    { encoding: "utf8", env: current.env, cwd: current.home, timeout: 25000 },
  );
  expect(proof.status, proof.stderr).toBe(0);
  expect(JSON.parse(proof.stdout)).toEqual({
    exit: answer === "RESTORE" ? 0 : 1,
    prompt: true,
    leaked: false,
  });
  if (answer === "NO")
    expect(readFileSync(current.config, "utf8")).toBe(changed);
});
