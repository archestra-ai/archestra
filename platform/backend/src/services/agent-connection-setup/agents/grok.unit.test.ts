import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
} from "@archestra/shared/archestra-mcp-server";
import { parse } from "smol-toml";
import { afterEach, expect, test } from "vitest";
import { grokToolName } from "../../../routes/mcp-gateway/grok-tool-names";
import {
  F52_GROK_SKILLS,
  F52_MARKETPLACE_SKILLS_SYNC,
} from "../../../test/fixtures/f52-marketplace-skills-sync";
import { HISTORICAL_MARKETPLACE_SKILLS_SYNC } from "../../../test/fixtures/historical-marketplace-skills-sync";
import { GROK_SKILLS } from "../payloads/grok-skills";
import type { SetupScriptContext } from "../types";
import { grokSetup } from "./grok";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const context: SetupScriptContext = {
  clientId: "grok-build",
  platform: "linux",
  appName: "Test Platform",
  skills: null,
  mcp: {
    serverName: "gateway",
    toolPrefix: "archestra__",
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
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "grok setup 日本語 "));
  homes.push(home);
  const grokHome = path.join(home, "custom grok home");
  mkdirSync(grokHome);
  const config = path.join(grokHome, "config.toml");
  const original =
    '[models]\ndefault = "existing"\n[model.existing]\nmodel = "existing-model"\n';
  writeFileSync(config, original);
  const env = { ...process.env, HOME: home, GROK_HOME: grokHome };
  return {
    home,
    config,
    env,
    managedConfig: path.join(home, ".archestra/grok/native/config.toml"),
    original,
    run: (
      ctx = context,
      overrides: Record<string, string> = {},
      historical: boolean | "f52" = false,
    ) =>
      spawnSync("bash", ["-s"], {
        input: grokSetup.bash
          .sections(ctx)
          .join("\n")
          .replaceAll(
            GROK_SKILLS,
            historical
              ? F52_GROK_SKILLS.replace(
                  F52_MARKETPLACE_SKILLS_SYNC,
                  historical === "f52"
                    ? F52_MARKETPLACE_SKILLS_SYNC
                    : HISTORICAL_MARKETPLACE_SKILLS_SYNC,
                )
              : GROK_SKILLS,
          )
          .replaceAll(
            JSON.stringify(GROK_SKILLS).slice(1, -1),
            JSON.stringify(
              historical
                ? F52_GROK_SKILLS.replace(
                    F52_MARKETPLACE_SKILLS_SYNC,
                    historical === "f52"
                      ? F52_MARKETPLACE_SKILLS_SYNC
                      : HISTORICAL_MARKETPLACE_SKILLS_SYNC,
                  )
                : GROK_SKILLS,
            ).slice(1, -1),
          ),
        encoding: "utf8",
        env: { ...env, ...overrides },
      }),
    disconnect: (overrides: Record<string, string> = {}) =>
      spawnSync(
        process.execPath,
        [path.join(home, ".archestra/grok/disconnect.cjs")],
        { encoding: "utf8", env: { ...env, ...overrides } },
      ),
  };
}

test("routes every model role through the proxy; reconnect and cleanup restore defaults and preserve unrelated edits", () => {
  const fixtureState = fixture();
  for (const attempt of [1, 2]) {
    const result = fixtureState.run();
    expect(result.status, `${attempt}: ${result.stderr}`).toBe(0);
  }
  const guardFile = path.join(fixtureState.home, ".archestra/grok/startup.sh");
  expect(existsSync(guardFile)).toBe(true);
  const config = parse(readFileSync(fixtureState.managedConfig, "utf8"));
  expect(config.models).toBeUndefined();
  expect(readFileSync(fixtureState.config, "utf8")).toBe(fixtureState.original);
  expect(config.model).toMatchObject({
    archestra: {
      model: "synthetic-model",
      api_key: "synthetic-private-key",
      api_backend: "chat_completions",
      base_url: context.proxy?.url,
      extra_headers: { "X-Archestra-Agent-Id": "grok-build" },
    },
  });
  expect(config.mcp_servers).toEqual({
    gateway: {
      url: context.mcp?.url,
      headers: {
        "x-appa-session-id": "{{session_id}}",
        "X-Archestra-Agent-Id": "grok-build",
      },
    },
  });
  expect(statSync(fixtureState.config).mode & 0o777).toBe(0o600);
  expect(
    statSync(path.join(fixtureState.home, ".archestra/grok/connection.json"))
      .mode & 0o777,
  ).toBe(0o600);
  writeFileSync(
    fixtureState.config,
    `${readFileSync(fixtureState.config, "utf8")}\n[preferences]\ncolor = "blue"\n`,
  );
  expect(fixtureState.disconnect().status).toBe(0);
  expect(fixtureState.disconnect().status).toBe(0);
  expect(existsSync(guardFile)).toBe(false);
  expect(readFileSync(fixtureState.config, "utf8")).toBe(
    `${fixtureState.original}\n[preferences]\ncolor = "blue"\n`,
  );
});

test("reconnect and disconnect preserve an edited startup screen for reconciliation", () => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const guardFile = path.join(current.home, ".archestra/grok/startup.sh");
  const edited = `${readFileSync(guardFile, "utf8")}\n# local change\n`;
  writeFileSync(guardFile, edited);
  const reconnect = current.run();
  expect(reconnect.status).not.toBe(0);
  expect(reconnect.stderr).toContain("startup screen changed");
  const disconnect = current.disconnect();
  expect(disconnect.status).not.toBe(0);
  expect(disconnect.stderr).toContain("startup screen changed");
  expect(readFileSync(guardFile, "utf8")).toBe(edited);
});

test("the shared startup screen reverses the whole Grok connection through its owned disconnect helper", () => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const root = path.join(current.home, ".archestra/grok");
  const guardFile = path.join(root, "startup.sh");
  const disconnected = spawnSync("bash", [guardFile], {
    env: { ...current.env, ARCHESTRA_GUARD_ACTION: "disconnect" },
    encoding: "utf8",
    timeout: 10000,
  });
  expect(disconnected.status, disconnected.stderr).toBe(0);
  expect(existsSync(path.join(root, "connection.json"))).toBe(false);
  expect(existsSync(guardFile)).toBe(false);
  expect(readFileSync(current.config, "utf8")).toBe(current.original);
});

test.each([
  "user_setting = true",
  "",
  '[models]\ndefault = "user-model"\nweb_search = "user-search"\nallowed_models = ["user-*"]\ntemperature = 0.25\n[preferences]\ncolor = "blue"\n',
])("managed model roles round-trip existing config without losing user settings: %s", (original) => {
  const current = fixture();
  writeFileSync(current.config, original);
  for (const attempt of [1, 2]) {
    const result = current.run();
    expect(result.status, `${attempt}: ${result.stderr}`).toBe(0);
    expect(parse(readFileSync(current.config, "utf8")).models).toEqual(
      parse(original).models,
    );
  }
  const disconnected = current.disconnect();
  expect(disconnected.status, disconnected.stderr).toBe(0);
  expect(readFileSync(current.config, "utf8")).toBe(original);
});

test("native subscription setup and reconnect require no API key, keep every role governed, and remove API-key fallback only from the managed child", () => {
  const current = fixture();
  const proxy = context.proxy;
  if (!proxy) throw new Error("The fixture requires a proxy selection");
  const ctx: SetupScriptContext = {
    ...context,
    mcp: null,
    proxy: {
      ...proxy,
      authMode: "native-session",
      virtualKey: null,
      passthroughVirtualKey: "synthetic-attribution",
      model: null,
    },
  };
  // Upgrade an existing alias-based connection, then reconnect idempotently.
  expect(current.run().status).toBe(0);
  for (let attempt = 0; attempt < 2; attempt++)
    expect(current.run(ctx).status).toBe(0);
  const configured = parse(readFileSync(current.managedConfig, "utf8"));
  expect(configured.model).toBeUndefined();
  const state = JSON.parse(
    readFileSync(
      path.join(current.home, ".archestra/grok/connection.json"),
      "utf8",
    ),
  );
  expect(state.nativeSession).toEqual({
    url: proxy.url,
    headers: { "x-archestra-virtual-key": "synthetic-attribution" },
    authPath: path.join(path.dirname(current.config), "auth.json"),
    model: null,
  });
  expect(configured.models).toBeUndefined();
  const bin = path.join(current.home, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "grok"),
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ hooks: [], plugins: [], configSources: { layers: [] }, permissions: { enforced: [{setting:"nonManagedHooks",enabled:false,source:require("node:path").join(process.env.GROK_HOME,"managed_config.toml")}] }, apiKeyAbsent: !process.env.XAI_API_KEY, alternateAbsent: !process.env.GROK_CODE_XAI_API_KEY, nativeBase: process.env.GROK_CLI_CHAT_PROXY_BASE_URL, authPath: process.env.GROK_AUTH_PATH, argv: process.argv.slice(2) }));\n`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(current.home, ".archestra/grok/launch.cjs"),
      "inspect",
      "--json",
      "-m",
      "synthetic-native-model",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: current.home,
        GROK_HOME: path.dirname(current.config),
        PATH: bin + path.delimiter + process.env.PATH,
        XAI_API_KEY: "synthetic-unwanted-fallback",
        GROK_CODE_XAI_API_KEY: "synthetic-unwanted-fallback",
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    apiKeyAbsent: true,
    alternateAbsent: true,
    nativeBase: expect.stringMatching(
      /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}$/,
    ),
    authPath: state.nativeSession.authPath,
    argv: expect.arrayContaining(["-m", "synthetic-native-model"]),
  });
  const login = spawnSync(
    process.execPath,
    [path.join(current.home, ".archestra/grok/login.cjs"), "--device-auth"],
    {
      encoding: "utf8",
      env: {
        ...current.env,
        PATH: bin + path.delimiter + process.env.PATH,
        GROK_CLI_CHAT_PROXY_BASE_URL: "https://unrelated.invalid",
        XAI_API_KEY: "synthetic-unwanted-key",
      },
    },
  );
  expect(login.status, login.stderr).toBe(0);
  expect(JSON.parse(login.stdout)).toMatchObject({
    authPath: state.nativeSession.authPath,
    apiKeyAbsent: true,
    argv: ["login", "--device-auth"],
  });
  expect(JSON.parse(login.stdout).nativeBase).toBeUndefined();
  for (const overrides of [
    ["agent", "--cli-chat-proxy-base-url", "https://unrelated.invalid"],
    ["agent", "--xai-api-base-url=https://unrelated.invalid"],
    ["agent", "--grok-ws-url=https://unrelated.invalid"],
  ]) {
    const bypass = spawnSync(
      process.execPath,
      [path.join(current.home, ".archestra/grok/launch.cjs"), ...overrides],
      {
        encoding: "utf8",
        env: { ...current.env, PATH: bin + path.delimiter + process.env.PATH },
      },
    );
    expect(bypass.status).toBe(1);
    expect(bypass.stderr).toContain(
      "Managed native endpoints cannot be overridden",
    );
    expect(bypass.stdout).toBe("");
  }
  const beforeConflict = readFileSync(current.managedConfig, "utf8");
  writeFileSync(
    current.managedConfig,
    `${beforeConflict}\n[model.bypass]\nbase_url="https://unrelated.invalid"\nmodel="synthetic"\n`,
  );
  const conflict = spawnSync(
    process.execPath,
    [path.join(current.home, ".archestra/grok/launch.cjs"), "--version"],
    {
      encoding: "utf8",
      env: { ...current.env, PATH: bin + path.delimiter + process.env.PATH },
    },
  );
  expect(conflict.status).toBe(1);
  expect(conflict.stderr).toContain("Native model routing conflicts");
  expect(conflict.stdout).toBe("");
  writeFileSync(current.managedConfig, beforeConflict);
  expect(current.disconnect().status).toBe(0);
  expect(parse(readFileSync(current.config, "utf8"))).toEqual(
    parse(current.original),
  );
});

function startupFixture(ctx = context, nativeOutput?: string) {
  const current = fixture();
  expect(current.run(ctx).status).toBe(0);
  const bin = path.join(current.home, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "curl"),
    '#!/bin/sh\nprintf \'%s\' \'{"mcp":"ok","llm":"ok"}\'\n',
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(bin, "grok"),
    `#!${process.execPath}\nif(process.argv[2]==='inspect') { console.log(JSON.stringify({hooks:[],plugins:[],permissions:{enforced:[{setting:"nonManagedHooks",enabled:false,source:require("node:path").join(process.env.GROK_HOME,"managed_config.toml")}]}})); } else { if(process.env.SYNTHETIC_MESSAGING_ENV) require("node:fs").writeFileSync(process.env.SYNTHETIC_MESSAGING_ENV, String(process.env.GROK_ACTIVE_AGENT_MESSAGES)); if(process.env.SYNTHETIC_NATIVE_ARGS) require("node:fs").writeFileSync(process.env.SYNTHETIC_NATIVE_ARGS,JSON.stringify(process.argv.slice(2))); ${nativeOutput === undefined ? "process.stdout.write(JSON.stringify({native:true}) + '\\n');" : `const bytes=Buffer.from(${JSON.stringify(nativeOutput)});let i=0;function send(){if(i<bytes.length){process.stdout.write(bytes.subarray(i,i+1));i++;setImmediate(send);}}send();`}process.exitCode=Number(process.env.SYNTHETIC_EXIT || 0); }\n`,
    { mode: 0o700 },
  );
  const root = path.join(current.home, ".archestra/grok");
  const env = {
    ...process.env,
    HOME: current.home,
    GROK_HOME: path.dirname(current.config),
    PATH: bin + path.delimiter + process.env.PATH,
  };
  const launcher = path.join(root, "launch.cjs");
  return { ...current, root, env, launcher };
}

test("enables native messages for protected launches without changing the parent shell", () => {
  const current = startupFixture();
  const capture = path.join(current.home, "messaging-env.txt");
  const result = spawnSync(
    process.execPath,
    [current.launcher, "-p", "synthetic"],
    {
      env: {
        ...current.env,
        GROK_ACTIVE_AGENT_MESSAGES: "0",
        SYNTHETIC_MESSAGING_ENV: capture,
      },
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(capture, "utf8")).toBe("1");
});

test.for([
  { serverName: "gateway", toolPrefix: "archestra__" },
  { serverName: "team_gateway", toolPrefix: "company__" },
])("managed Grok pre-approves only the connected gateway's guardrail helpers ($serverName)", (mcp) => {
  if (!context.mcp) throw new Error("Gateway fixture required");
  const ctx = { ...context, mcp: { ...context.mcp, ...mcp } };
  const current = startupFixture(ctx);
  const capture = path.join(current.home, "native-arguments.json");
  const expected = [
    ...REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
    TOOL_ASK_USER_SHORT_NAME,
  ].map(
    (name) =>
      `--allow=${mcp.serverName}__${grokToolName(mcp.toolPrefix + name)}`,
  );
  for (const args of [[], ["--resume", "synthetic"], ["-p", "synthetic"]]) {
    const result = spawnSync(process.execPath, [current.launcher, ...args], {
      env: { ...current.env, SYNTHETIC_NATIVE_ARGS: capture },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const launched = JSON.parse(readFileSync(capture, "utf8")) as string[];
    expect(launched.filter((arg) => arg.startsWith("--allow="))).toEqual(
      expected,
    );
    expect(launched).not.toContain("--always-approve");
    expect(launched.join(" ")).not.toContain("*");
    if (args.length) expect(launched.slice(-args.length)).toEqual(args);
  }
  const next = { serverName: mcp.serverName, toolPrefix: "new_brand__" };
  expect(current.run({ ...ctx, mcp: { ...ctx.mcp, ...next } }).status).toBe(0);
  const refreshed = spawnSync(process.execPath, [current.launcher], {
    env: { ...current.env, SYNTHETIC_NATIVE_ARGS: capture },
    encoding: "utf8",
  });
  expect(refreshed.status, refreshed.stderr).toBe(0);
  const launched = JSON.parse(readFileSync(capture, "utf8")) as string[];
  expect(launched).toContain(
    `--allow=${mcp.serverName}__${grokToolName("new_brand__yell")}`,
  );
  expect(launched).not.toContain(expected[0]);
});

test("without a gateway, managed Grok adds no MCP permission grants", () => {
  const current = startupFixture({ ...context, mcp: null });
  const capture = path.join(current.home, "native-arguments.json");
  const result = spawnSync(process.execPath, [current.launcher], {
    env: { ...current.env, SYNTHETIC_NATIVE_ARGS: capture },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const launched = JSON.parse(readFileSync(capture, "utf8")) as string[];
  expect(launched.filter((arg) => arg.startsWith("--allow="))).toEqual([]);
});

test("a malformed guardrail permission cannot broaden native tool access", () => {
  const current = startupFixture();
  const stateFile = path.join(current.root, "connection.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.guardrailToolAllowRules = ["*"];
  writeFileSync(stateFile, JSON.stringify(state));
  const result = spawnSync(process.execPath, [current.launcher], {
    env: current.env,
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("guardrail tool permissions are invalid");
  expect(result.stdout).not.toContain('"native":true');
});

test("native account refresh retains its settings while the managed hook restriction is renewed and removed on disconnect", () => {
  const current = startupFixture();
  const policyFile = path.join(current.root, "native/managed_config.toml");
  writeFileSync(policyFile, "[features]\nfeedback=false\n");
  const result = spawnSync(process.execPath, [current.launcher, "--sync"], {
    env: current.env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(parse(readFileSync(policyFile, "utf8"))).toEqual({
    allow_managed_hooks_only: true,
    features: { feedback: false },
  });
  const disconnected = current.disconnect();
  expect(disconnected.status, disconnected.stderr).toBe(0);
  expect(parse(readFileSync(policyFile, "utf8"))).toEqual({
    features: { feedback: false },
  });
});

const PTY_STARTUP = `
import errno,fcntl,json,os,pty,select,signal,subprocess,sys,termios,time
master,slave=pty.openpty()
def terminal_session():
    os.setsid()
    fcntl.ioctl(0,termios.TIOCSCTTY,0)
child=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,env=os.environ,preexec_fn=terminal_session)
os.close(slave)
output=b'';deadline=time.monotonic()+15;sent=False;ready_at=None;native_delay=None
while time.monotonic()<deadline:
    ready,_,_=select.select([master],[],[],0.05)
    if ready:
        try:
            data=os.read(master,65536)
            if not data: break
            output+=data
            if b'[ok] Native activation:' in output and ready_at is None:ready_at=time.monotonic()
            if b'"native":true' in output and ready_at is not None and native_delay is None:native_delay=(time.monotonic()-ready_at)*1000
        except OSError as error:
            if error.errno==errno.EIO: break
            raise
    cancel=os.environ.get('SYNTHETIC_CANCEL_FILE')
    if ((cancel and os.path.exists(cancel)) or (os.environ.get('SYNTHETIC_CANCEL_ON_READY') and ready_at is not None)) and not sent:
        os.kill(child.pid,signal.SIGINT);sent=True
if child.poll() is None: child.wait(timeout=5)
os.close(master)
print(json.dumps({'status':child.returncode,'output':output.decode(errors='replace'),'cancelled':sent,'nativeStartDelayMs':native_delay}))
`;

test("TTY startup shows actual phases, pending server admission and native exit without a fabricated protected badge", () => {
  const current = startupFixture();
  const result = spawnSync(
    "python3",
    ["-c", PTY_STARTUP, process.execPath, current.launcher],
    { env: current.env, encoding: "utf8", timeout: 20000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const screen = JSON.parse(result.stdout);
  expect(screen.status).toBe(0);
  for (const phase of [
    "[ok] Connection state: managed configuration validated",
    "[ok] Skills sync: managed selection reconciled",
    "[ok] Model discovery: approved pinned selection unchanged",
    "[pending] Proxy readiness: routing validated; server policy/session admission awaits the first native reply",
    "[ok] Native Grok: native process started; server receipt not yet observed",
  ])
    expect(screen.output).toContain(phase);
  expect(screen.output).not.toContain("protected session");
  expect(screen.output).toContain("LLM proxy routing");
  expect(screen.output).toContain("\x1b[?1049h");
  expect(screen.output.indexOf("\x1b[?1049l")).toBeLessThan(
    screen.output.indexOf('"native":true'),
  );
  expect(screen.nativeStartDelayMs).toBeGreaterThan(1300);
});

test("cancelling the visible startup screen does not start native Grok", () => {
  const current = startupFixture();
  const result = spawnSync(
    "python3",
    ["-c", PTY_STARTUP, process.execPath, current.launcher],
    {
      env: { ...current.env, SYNTHETIC_CANCEL_ON_READY: "1" },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  const screen = JSON.parse(result.stdout);
  expect(screen.status).toBe(130);
  expect(screen.output).not.toContain('"native":true');
});

test.each([
  [],
  ["--json"],
  ["--quiet"],
  ["--headless"],
  ["--output-format=json"],
])("managed non-TTY native stdout remains exactly JSON for %j", (...args: string[]) => {
  const current = startupFixture();
  const result = spawnSync(process.execPath, [current.launcher, ...args], {
    env: current.env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ native: true });
  expect(result.stderr).toBe("");
});

test("TTY --json and --sync suppress loader; sync never starts native Grok", () => {
  const current = startupFixture();
  for (const arg of ["--json", "--sync", "--quiet"]) {
    const result = spawnSync(
      "python3",
      ["-c", PTY_STARTUP, process.execPath, current.launcher, arg],
      { env: current.env, encoding: "utf8", timeout: 20000 },
    );
    const screen = JSON.parse(result.stdout);
    expect(screen.status).toBe(0);
    expect(screen.output).not.toContain("managed startup");
    if (arg === "--sync") expect(screen.output).toBe("");
    else expect(JSON.parse(screen.output)).toEqual({ native: true });
  }
});

test("TTY preparation failure and native failure propagate status and close the progress line", () => {
  const current = startupFixture();
  writeFileSync(
    path.join(current.root, "native-skills.json"),
    '{"source":null}',
  );
  writeFileSync(
    path.join(current.root, "skills.cjs"),
    'throw new Error("synthetic-api-key-not-for-output")',
  );
  const result = spawnSync(
    "python3",
    ["-c", PTY_STARTUP, process.execPath, current.launcher],
    { env: current.env, encoding: "utf8", timeout: 20000 },
  );
  const screen = JSON.parse(result.stdout);
  expect(screen.status).toBe(1);
  expect(screen.output).toContain("[failed] Skills sync");
  expect(screen.output).not.toContain("synthetic-api-key-not-for-output");
  expect(screen.output).not.toContain('"native":true');
  unlinkSync(path.join(current.root, "native-skills.json"));
  const native = spawnSync(
    "python3",
    ["-c", PTY_STARTUP, process.execPath, current.launcher],
    {
      env: { ...current.env, SYNTHETIC_EXIT: "7" },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  expect(JSON.parse(native.stdout)).toMatchObject({ status: 7 });
  expect(JSON.parse(native.stdout).output).toContain("[failed] Native Grok");
});

test("TTY Automatic model discovery failure leaves routing pending, restores the terminal and does not start native Grok", () => {
  const current = startupFixture();
  const stateFile = path.join(current.root, "connection.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.automatic = { modelsUrl: "https://proxy.example/models" };
  writeFileSync(stateFile, JSON.stringify(state));
  const before = readFileSync(current.config, "utf8");
  const snapshot = readFileSync(stateFile, "utf8");
  const result = spawnSync(
    "python3",
    ["-c", PTY_STARTUP, process.execPath, current.launcher],
    {
      env: { ...current.env, XAI_API_KEY: "" },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  const screen = JSON.parse(result.stdout);
  expect(screen.status).toBe(1);
  expect(screen.output).toContain("[failed] Model discovery");
  expect(screen.output).not.toContain("[ok] Native Grok");
  expect(readFileSync(current.config, "utf8")).toBe(before);
  expect(readFileSync(stateFile, "utf8")).toBe(snapshot);
});

test("TTY cancellation terminates active preparation, leaves snapshots unchanged and no native process", () => {
  const current = startupFixture();
  const config = readFileSync(current.config, "utf8");
  const snapshot = readFileSync(
    path.join(current.root, "connection.json"),
    "utf8",
  );
  const pidFile = path.join(current.home, "worker.pid");
  writeFileSync(
    path.join(current.root, "native-skills.json"),
    '{"source":null}',
  );
  writeFileSync(
    path.join(current.root, "skills.cjs"),
    `module.exports=()=>require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`)}],{stdio:'ignore'});`,
  );
  const result = spawnSync(
    "python3",
    ["-c", PTY_STARTUP, process.execPath, current.launcher],
    {
      env: { ...current.env, SYNTHETIC_CANCEL_FILE: pidFile },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  const screen = JSON.parse(result.stdout);
  expect(screen.status).toBe(130);
  expect(screen.output).toContain("[cancelled] Skills sync");
  expect(screen.output).not.toContain('"native":true');
  const worker = Number(readFileSync(pidFile, "utf8"));
  expect(() => process.kill(worker, 0)).toThrow();
  expect(readFileSync(current.config, "utf8")).toBe(config);
  expect(readFileSync(path.join(current.root, "connection.json"), "utf8")).toBe(
    snapshot,
  );
});

test("managed native login accepts device authorization without adding a conflicting OAuth flag", () => {
  const { home, env } = startupFixture();
  const binary = path.join(home, "bin/grok");
  const capture = path.join(home, "native-login.json");
  writeFileSync(
    binary,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.GROK_HOME }));\n`,
  );
  const helper = path.join(home, ".archestra/grok/login.cjs");
  for (const [args, expected] of [
    [[], ["login", "--oauth"]],
    [["--device-auth"], ["login", "--device-auth"]],
  ]) {
    const result = spawnSync(process.execPath, [helper, ...args], {
      env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
      args: expected,
      home: path.join(home, ".archestra/grok/native"),
    });
  }
});

test("managed launcher disables ambient clients and model overrides without changing the parent environment", () => {
  const current = fixture();
  expect(current.run().status).toBe(0);
  const bin = path.join(current.home, "bin");
  mkdirSync(bin);
  const capture = path.join(current.home, "launch.json");
  const invocations = path.join(current.home, "native-invocations");
  const program = path.join(bin, "grok");
  writeFileSync(
    program,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(invocations)},process.argv[2]+'\\n');if(process.argv[2]==='inspect') console.log(JSON.stringify({hooks:[],plugins:[],permissions:{enforced:[{setting:"nonManagedHooks",enabled:false,source:require("node:path").join(process.env.GROK_HOME,"managed_config.toml")}]}})); else require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),env:process.env}));\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    HOME: current.home,
    GROK_HOME: path.dirname(current.config),
    PATH: bin + path.delimiter + process.env.PATH,
    GROK_CLAUDE_HOOKS_ENABLED: "1",
    GROK_WEB_SEARCH_MODEL: "unmanaged",
    GROK_MODELS_BASE_URL: "https://unmanaged.example",
    GROK_CONFIG_PATH: path.join(current.home, "unmanaged-overlay.toml"),
    GROK_CONFIG: JSON.stringify({
      models: { default: "unmanaged", allowed_models: ["*"] },
    }),
  };
  const launcher = path.join(current.home, ".archestra/grok/launch.cjs");
  const launch = (...args: string[]) =>
    spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8" });
  expect(launch("--sync").status).toBe(0);
  expect(existsSync(capture)).toBe(false);
  expect(existsSync(invocations)).toBe(false);
  expect(readFileSync(current.config, "utf8")).toBe(current.original);
  const result = launch("-p", "synthetic prompt");
  expect(result.status, result.stderr).toBe(0);
  const observed = JSON.parse(readFileSync(capture, "utf8"));
  const helperArguments = [
    ...REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
    TOOL_ASK_USER_SHORT_NAME,
  ].map((name) => `--allow=gateway__${grokToolName(`archestra__${name}`)}`);
  expect(readFileSync(current.config, "utf8")).toBe(current.original);
  expect(observed.args).toEqual([
    "-m",
    "archestra",
    ...helperArguments,
    "-p",
    "synthetic prompt",
  ]);
  for (const client of ["CURSOR", "CLAUDE", "CODEX"])
    for (const resource of ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS"])
      expect(observed.env[`GROK_${client}_${resource}_ENABLED`]).toBe("0");
  expect(observed.env.GROK_WEB_SEARCH_MODEL).toBe("archestra");
  expect(JSON.parse(observed.env.GROK_CONFIG).models).toEqual({
    default: "archestra",
    web_search: "archestra",
    session_summary: "archestra",
    image_description: "archestra",
    allowed_models: ["archestra"],
  });
  expect(observed.env.GROK_CONFIG_PATH).toBeUndefined();
  for (const client of ["CURSOR", "CLAUDE", "CODEX"])
    expect(observed.env[`GROK_${client}_SESSIONS_ENABLED`]).toBe("0");
  expect(observed.env.GROK_MODELS_BASE_URL).toBeUndefined();
  expect(env.GROK_CLAUDE_HOOKS_ENABLED).toBe("1");
  expect(JSON.parse(env.GROK_CONFIG).models.default).toBe("unmanaged");
  const command = grokSetup.ending(context).launch;
  if (!command) throw new Error("Missing Connect launch command");
  const welcome = spawnSync(process.execPath, command.slice(1), {
    env,
    encoding: "utf8",
  });
  expect(welcome.status, welcome.stderr).toBe(0);
  expect(JSON.parse(readFileSync(capture, "utf8")).args).toEqual([
    "-m",
    "archestra",
    ...helperArguments,
    "What can you do with my Test Platform tools from the gateway MCP server? Do not call, test, reconnect or sign in to my other MCP servers. Leave them out of your answer.",
  ]);
  for (const [args, expected] of [
    [
      ["--no-subagents", "-p", "synthetic prompt"],
      [...helperArguments, "--no-subagents", "-p", "synthetic prompt"],
    ],
    [
      ["--", "--no-subagents"],
      [...helperArguments, "--", "--no-subagents"],
    ],
  ]) {
    const result = launch(...args);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(capture, "utf8")).args).toEqual([
      "-m",
      "archestra",
      ...expected,
    ]);
  }
  for (const args of [
    ["--model=unmanaged"],
    ["-m", "unmanaged"],
    ["-munmanaged"],
    ["--agents", "{}"],
    ["--cwd", "other-project"],
    ["--add-dir=other-project"],
  ]) {
    unlinkSync(capture);
    expect(launch(...args).status).not.toBe(0);
    expect(existsSync(capture)).toBe(false);
    writeFileSync(capture, "{}");
  }
  const installed = readFileSync(current.config, "utf8");
  writeFileSync(
    current.config,
    installed.replace('default = "existing"', 'default = "unmanaged"'),
  );
  expect(launch().status).toBe(0);
  expect(current.disconnect().status).toBe(0);
  expect(parse(readFileSync(current.config, "utf8")).models).toEqual({
    default: "unmanaged",
  });
});

test.each([
  undefined,
  "",
  '[models]\ndefault = "user-model"\n',
])("preserves native startup tables inserted before the trailing marker without trusting changes to managed tables: %s", (original) => {
  const current = fixture();
  if (original !== undefined) writeFileSync(current.config, original);
  expect(current.run().status).toBe(0);
  writeFileSync(
    current.managedConfig,
    readFileSync(current.managedConfig, "utf8").replace(
      "# END ARCHESTRA GROK CONNECTION",
      "\n[marketplace]\ndefault_skills_installs_purged = true\napi_key = 'unrelated-user-setting'\n# END ARCHESTRA GROK CONNECTION",
    ),
  );
  const refreshed = current.run();
  expect(refreshed.status, refreshed.stderr).toBe(0);
  expect(
    parse(readFileSync(current.managedConfig, "utf8")).marketplace,
  ).toEqual({
    default_skills_installs_purged: true,
    api_key: "unrelated-user-setting",
  });
  expect(
    parse(readFileSync(current.managedConfig, "utf8")).model,
  ).toMatchObject({
    archestra: {
      api_key: "synthetic-private-key",
      base_url: context.proxy?.url,
    },
  });
  expect(
    parse(readFileSync(current.managedConfig, "utf8")).mcp_servers,
  ).toMatchObject({
    gateway: { url: context.mcp?.url },
  });
  const disconnected = current.disconnect();
  expect(disconnected.status, disconnected.stderr).toBe(0);
  expect(
    parse(readFileSync(current.managedConfig, "utf8")).marketplace,
  ).toEqual({
    default_skills_installs_purged: true,
    api_key: "unrelated-user-setting",
  });
  expect(current.run().status).toBe(0);
  const owned = readFileSync(current.managedConfig, "utf8").replace(
    "# END ARCHESTRA GROK CONNECTION",
    "\n[model]\narchestra = { api_key = 'untrusted' }\n# END ARCHESTRA GROK CONNECTION",
  );
  writeFileSync(current.managedConfig, owned);
  expect(current.disconnect().status).not.toBe(0);
  expect(readFileSync(current.managedConfig, "utf8")).toBe(owned);
});

test.each([
  "openai",
  "anthropic",
  "xai",
] as const)("provider-key %s uses the provider environment and never a literal session macro in model headers", (provider) => {
  const fixtureState = fixture();
  if (!context.proxy) throw new Error("Expected proxy fixture");
  const result = fixtureState.run({
    ...context,
    proxy: {
      ...context.proxy,
      provider,
      authMode: "provider-key",
      virtualKey: null,
      passthroughVirtualKey: "synthetic-attribution-key",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const config = parse(readFileSync(fixtureState.managedConfig, "utf8")) as {
    model: { archestra: Record<string, unknown> };
  };
  const model = config.model.archestra;
  expect(model.api_key).toBeUndefined();
  expect(model.env_key).toBe(
    provider === "xai"
      ? "XAI_API_KEY"
      : provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "OPENAI_API_KEY",
  );
  expect(model.api_backend).toBe(
    provider === "anthropic" ? "messages" : "chat_completions",
  );
  expect(model.extra_headers).toEqual({
    "X-Archestra-Agent-Id": "grok-build",
    "X-Archestra-Virtual-Key": "synthetic-attribution-key",
  });
});

test("edited managed blocks refuse reconnect and disconnect without overwriting user edits", () => {
  const fixtureState = fixture();
  expect(fixtureState.run().status).toBe(0);
  const edited = readFileSync(fixtureState.managedConfig, "utf8").replace(
    "synthetic-model",
    "user-edited-model",
  );
  writeFileSync(fixtureState.managedConfig, edited);
  expect(fixtureState.run().status).not.toBe(0);
  expect(fixtureState.disconnect().status).not.toBe(0);
  expect(readFileSync(fixtureState.managedConfig, "utf8")).toBe(edited);
});

test("unmanaged name conflicts fail before writing credentials", () => {
  const fixtureState = fixture();
  const conflict = `${fixtureState.original}\n[model.archestra]\nmodel = "user-model"\n`;
  writeFileSync(fixtureState.config, conflict);
  expect(fixtureState.run().status).not.toBe(0);
  expect(readFileSync(fixtureState.config, "utf8")).toBe(conflict);
  expect(
    existsSync(path.join(fixtureState.home, ".archestra/grok/connection.json")),
  ).toBe(false);
});

test.each([
  undefined,
  "caller-custom-model",
])("caller-key config defers automatic resolution to the local credential and preserves explicit model %s", (model) => {
  const current = fixture();
  if (!context.proxy) throw new Error("Expected proxy context");
  const result = current.run(
    {
      ...context,
      proxy: {
        ...context.proxy,
        authMode: "provider-key",
        model: model ?? null,
        virtualKey: null,
      },
    },
    { XAI_API_KEY: "" },
  );
  expect(result.status, result.stderr).toBe(0);
  if (!model) {
    expect(
      parse(readFileSync(current.managedConfig, "utf8")).model || {},
    ).not.toHaveProperty("archestra");
    const snapshot = JSON.parse(
      readFileSync(
        path.join(current.home, ".archestra/grok/connection.json"),
        "utf8",
      ),
    );
    expect(snapshot).toMatchObject({
      modelResolved: false,
      automatic: { modelsUrl: `${context.proxy.url}/models` },
    });
    expect(result.stdout).toContain("verified locally");
    return;
  }
  expect(
    parse(readFileSync(current.managedConfig, "utf8")).model,
  ).toMatchObject({
    archestra: {
      model,
      base_url: context.proxy.url,
      env_key: "XAI_API_KEY",
      api_backend: "chat_completions",
    },
  });
});

test("tools-only setup writes no model and preserves defaults", () => {
  const fixtureState = fixture();
  expect(fixtureState.run({ ...context, proxy: null }).status).toBe(0);
  expect(parse(readFileSync(fixtureState.config, "utf8")).model).toEqual({
    existing: { model: "existing-model" },
  });
});

test.each([
  '[model . "archestra"]\nmodel = "existing"\n',
  'model.archestra = { model = "existing" }\n',
  'model.archestra.model = "existing"\n',
  'model = { archestra = { model = "existing" } }\n',
  '[model]\narchestra = { model = "existing" }\n',
  '["mcp_servers" . "gateway"]\nurl = "https://existing.example"\n',
  'mcp_servers = { gateway = { url = "https://existing.example" } }\n',
  '[mcp_servers]\ngateway.url = "https://existing.example"\n',
])("refuses valid quoted, dotted or inline collisions without corrupting TOML: %s", (existing) => {
  const fixtureState = fixture();
  expect(() => parse(existing)).not.toThrow();
  writeFileSync(fixtureState.config, existing);
  expect(fixtureState.run().status).not.toBe(0);
  expect(readFileSync(fixtureState.config, "utf8")).toBe(existing);
  expect(
    existsSync(path.join(fixtureState.home, ".archestra/grok/connection.json")),
  ).toBe(false);
});

test("refuses a different GROK_HOME on reconnect without claiming or changing that configuration", () => {
  const fixtureState = fixture();
  expect(fixtureState.run().status).toBe(0);
  const original = readFileSync(fixtureState.config, "utf8");
  const other = path.join(fixtureState.home, "other");
  mkdirSync(other);
  writeFileSync(path.join(other, "config.toml"), "# separate config\n");
  expect(fixtureState.run(context, { GROK_HOME: other }).status).not.toBe(0);
  expect(readFileSync(fixtureState.config, "utf8")).toBe(original);
  expect(readFileSync(path.join(other, "config.toml"), "utf8")).toBe(
    "# separate config\n",
  );
});

test.each([
  false,
  true,
])("refuses live or dangling config symlinks before writing secrets: dangling=%s", (dangling) => {
  const fixtureState = fixture();
  const target = path.join(fixtureState.home, "user-owned.toml");
  if (!dangling) writeFileSync(target, "# preserved\n");
  unlinkSync(fixtureState.config);
  symlinkSync(target, fixtureState.config);
  expect(fixtureState.run().status).not.toBe(0);
  if (!dangling) expect(readFileSync(target, "utf8")).toBe("# preserved\n");
  else expect(existsSync(target)).toBe(false);
});

test("rejects a symlinked GROK_HOME and a symlinked private snapshot directory", () => {
  const fixtureState = fixture();
  const alias = path.join(fixtureState.home, "linked-grok");
  symlinkSync(path.dirname(fixtureState.config), alias);
  expect(fixtureState.run(context, { GROK_HOME: alias }).status).not.toBe(0);
  const shared = path.join(fixtureState.home, "shared");
  mkdirSync(shared);
  mkdirSync(path.join(fixtureState.home, ".archestra"));
  symlinkSync(shared, path.join(fixtureState.home, ".archestra/grok"));
  expect(fixtureState.run().status).not.toBe(0);
  expect(readFileSync(fixtureState.config, "utf8")).toBe(fixtureState.original);
  expect(existsSync(path.join(shared, "connection.json"))).toBe(false);
});

test("uses a dedicated profile without creating a normal user config when GROK_HOME is unset", () => {
  const fixtureState = fixture();
  expect(fixtureState.run(context, { GROK_HOME: "" }).status).toBe(0);
  expect(
    parse(readFileSync(fixtureState.managedConfig, "utf8")).mcp_servers,
  ).toMatchObject({ gateway: { url: context.mcp?.url } });
});

test.each([
  "config",
  "snapshot",
  "home",
])("disconnect refuses a replaced %s symlink without changing the target", (kind) => {
  const fixtureState = fixture();
  expect(fixtureState.run().status).toBe(0);
  const target =
    kind === "home"
      ? path.dirname(fixtureState.config)
      : kind === "snapshot"
        ? path.join(fixtureState.home, ".archestra/grok/connection.json")
        : fixtureState.config;
  const saved = `${target}.saved`;
  const before = readFileSync(fixtureState.config, "utf8");
  renameSync(target, saved);
  symlinkSync(saved, target);
  expect(fixtureState.disconnect().status).not.toBe(0);
  expect(readFileSync(fixtureState.config, "utf8")).toBe(before);
});

test.each([
  "--single",
  "--prompt-file",
  "--prompt-json",
  "-p",
  "agent",
])("TTY %s suppresses the startup screen and reports health in native stdout", (flag) => {
  const current = startupFixture();
  const stateFile = path.join(current.root, "connection.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.startupGuard.healthUrl = null;
  writeFileSync(stateFile, JSON.stringify(state));
  const result = spawnSync(
    "python3",
    ["-c", PTY_STARTUP, process.execPath, current.launcher, flag, "synthetic"],
    { env: current.env, encoding: "utf8", timeout: 20000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const screen = JSON.parse(result.stdout);
  expect(screen.status).toBe(0);
  expect(screen.output).not.toContain("managed startup");
  expect(screen.output).not.toContain("\x1b[?1049h");
  expect(screen.output).toContain('"native":true');
  expect(screen.output).toContain("[Archestra] Connectivity: unavailable");
});

test.each([
  "json",
  "streaming-json",
  "streaming-messages-json",
])("headless %s preserves the native result and adds startup metadata", (format) => {
  const current = startupFixture();
  const stateFile = path.join(current.root, "connection.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.startupGuard.healthUrl = null;
  writeFileSync(stateFile, JSON.stringify(state));
  const result = spawnSync(
    process.execPath,
    [current.launcher, "--single", "synthetic", `--output-format=${format}`],
    { env: current.env, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    native: true,
    _meta: {
      archestraStartup: {
        connectivity: "unavailable",
        admission: "await-server-receipt",
      },
    },
  });
  expect(result.stderr).toBe("");
});

test.each([
  "json",
  "streaming-json",
  "streaming-messages-json",
])("headless %s preserves Unicode through legacy shell decoding", (format) => {
  const text = "▄█▄▄▄█▄ café 中文 😀 e\u0301 literal \\u2584";
  const events = [
    ...(format === "json"
      ? []
      : [
          { type: "text", data: text },
          { type: "text", data: `Second chunk: ${text}` },
        ]),
    { type: "result", result: text, nested: { [text]: text } },
  ];
  // No terminal newline; multibyte characters are split across native writes.
  const current = startupFixture(
    context,
    events.map((event) => JSON.stringify(event)).join("\n"),
  );
  const stateFile = path.join(current.root, "connection.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.startupGuard.healthUrl = null;
  writeFileSync(stateFile, JSON.stringify(state));
  const result = spawnSync(
    process.execPath,
    [current.launcher, "--single", "synthetic", `--output-format=${format}`],
    { env: current.env },
  );
  expect(result.status, result.stderr.toString()).toBe(0);
  // ASCII bytes decode identically under UTF-8, CP437, and Windows ANSI.
  expect([...result.stdout].every((byte) => byte < 128)).toBe(true);
  const decoded = result.stdout
    .toString("latin1")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(decoded).toEqual(
    events.map((event, index) =>
      index === events.length - 1
        ? {
            ...event,
            _meta: {
              archestraStartup: {
                connectivity: "unavailable",
                admission: "await-server-receipt",
              },
            },
          }
        : event,
    ),
  );
  expect(result.stderr.length).toBe(0);
});

test("headless connectivity uses one background request and does not hold native startup", async () => {
  const current = startupFixture();
  let probes = 0;
  let nativeStarted = false;
  let pending: ServerResponse | undefined;
  const respond = () => {
    if (nativeStarted && pending)
      pending.end(JSON.stringify({ mcp: "ok", llm: "ok" }));
  };
  const server = createServer((_request, response) => {
    probes++;
    pending = response;
    respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture listener");
  const stateFile = path.join(current.root, "connection.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.startupGuard.healthUrl = `http://127.0.0.1:${address.port}/v1/health`;
  writeFileSync(stateFile, JSON.stringify(state));
  const child = spawn(
    process.execPath,
    [current.launcher, "--single", "synthetic"],
    { env: current.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes('"native":true')) {
      nativeStarted = true;
      respond();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(status, stderr).toBe(0);
    expect(probes).toBe(1);
    expect(stdout).toContain("Connectivity: ok");
    expect(stderr).toBe("");
    expect(stdout).not.toContain("managed startup");
  } finally {
    child.kill();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
