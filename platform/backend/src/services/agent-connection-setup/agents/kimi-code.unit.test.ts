import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { renderSetupScript } from "../index";
import { KIMI_CODE_CONNECTION } from "../payloads/kimi-code-connection";
import { buildEnding } from "../steps/ending";
import type { SetupScriptContext } from "../types";
import { kimiCodeSetup } from "./kimi-code";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const context: SetupScriptContext = {
  clientId: "kimi-code",
  platform: "linux",
  appName: "Test Platform",
  toolPrefix: "archestra__",
  skills: null,
  mcp: {
    serverName: "archestra",
    toolPrefix: "archestra__",
    url: "https://platform.example/v1/mcp/gateway",
  },
  proxy: {
    authMode: "provider-key",
    provider: "kimi-code",
    providerLabel: "Kimi Code",
    baseUrl: "https://platform.example/v1",
    url: "https://platform.example/v1/kimi-code",
    proxyName: "proxy",
    virtualKey: null,
    virtualKeyName: null,
    passthroughVirtualKey: "arch_attribution_key",
    model: "k3.1-pro",
  },
  runtimeHandoffInstructions: "Offer to continue the session in the cloud.",
};

const USER_CONFIG = `# My Kimi Code settings
default_model = "mine" # keep this
telemetry = false
extra_skill_dirs = ["~/my-skills"]
notes = [
  "[not a table]",
]

[providers.mine]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key_env = "MY_KEY"

[models.mine]
provider = "mine"
model = "k3"
max_context_size = 262144

[[permission.rules]]
decision = "ask"
pattern = "Bash(rm *)"
`;

/**
 * A home directory with a stand-in for Kimi Code: its npm package, or with
 * `native` the build its install script puts in ~/.kimi-code/bin. Its
 * `kimi doctor` succeeds unless KIMI_FAKE_DOCTOR_FAILS is set, and it
 * records every command line it ran and the folder of each one-prompt run.
 * A one-prompt run prints its thinking on stderr as Kimi Code does. Without
 * saved gateway tokens it signs in as Kimi Code's authenticate tool does: it
 * prints the authorization URL and saves new tokens. With saved tokens Kimi
 * Code has no authenticate tool, and with KIMI_FAKE_SIGN_IN=refused the call
 * is refused. xdg-open records the URLs it is asked to open.
 */
function fixture(
  options: { config?: string; version?: string; native?: boolean } = {},
) {
  const home = mkdtempSync(path.join(tmpdir(), "kimi setup "));
  homes.push(home);
  const fakeKimi = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(path.join(home, "kimi-calls.log"))}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "--version") console.log(${JSON.stringify(options.version ?? "2.3.3")});
if (process.argv[2] === "doctor" && process.env.KIMI_FAKE_DOCTOR_FAILS) {
  console.log("ERROR config.toml  Invalid TOML document: trying to redefine an already defined table");
  process.exit(1);
}
if (process.argv[2] === "-p") {
  appendFileSync(${JSON.stringify(path.join(home, "kimi-folders.log"))}, process.cwd() + "\\n");
  const credentials = process.env.HOME + "/.kimi-code/credentials/mcp";
  console.error("kimi version 2.3.3");
  console.error("\\u2022 Thinking about the sign-in.");
  if (process.env.KIMI_FAKE_SIGN_IN === "refused") console.log("\\u2022 [appa] Not checked: the call did not run.");
  else if (existsSync(credentials + "/archestra-0123-tokens.json")) console.log("\\u2022 The archestra MCP server is signed in already.");
  else {
    console.error("Discovering OAuth metadata for archestra\\u2026");
    console.error("Open this URL in your browser to authorize \\"archestra\\":");
    console.error("");
    console.error("https://elsewhere.example/oauth2/authorize?resource=https%3A%2F%2Felsewhere.example%2Fmcp");
    console.error("https://platform.example/api/auth/oauth2/authorize?response_type=code&resource=" + encodeURIComponent("https://platform.example/v1/mcp/gateway"));
    mkdirSync(credentials, { recursive: true });
    writeFileSync(credentials + "/archestra-0123-meta.json", JSON.stringify({ serverName: "archestra", serverUrl: "https://platform.example/v1/mcp/gateway" }));
    writeFileSync(credentials + "/archestra-0123-tokens.json", JSON.stringify({ access_token: String(process.hrtime.bigint()) }));
    console.error("Authorized \\u2014 reconnecting archestra\\u2026");
    console.log("\\u2022 Signed in.");
  }
  console.error("To resume this session: kimi -r session_0123");
}
`;
  const kimiHome = path.join(home, ".kimi-code");
  mkdirSync(kimiHome, { recursive: true });
  let bin = path.join(home, "npm/bin");
  if (options.native) {
    bin = path.join(kimiHome, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "kimi"), fakeKimi);
    chmodSync(path.join(bin, "kimi"), 0o755);
  } else {
    const pkg = path.join(home, "npm/lib/node_modules/@moonshot-ai/kimi-code");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@moonshot-ai/kimi-code",
        version: options.version ?? "2.3.3",
        bin: { kimi: "dist/main.mjs" },
      }),
    );
    // The npm package is an ES module.
    writeFileSync(
      path.join(pkg, "dist/main.mjs"),
      fakeKimi.replace(
        'const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");',
        'import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";',
      ),
    );
    chmodSync(path.join(pkg, "dist/main.mjs"), 0o755);
    mkdirSync(bin, { recursive: true });
    symlinkSync(
      "../lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs",
      path.join(bin, "kimi"),
    );
  }
  if (options.config !== undefined)
    writeFileSync(path.join(kimiHome, "config.toml"), options.config);
  const opener = path.join(home, "opener");
  mkdirSync(opener);
  writeFileSync(
    path.join(opener, "xdg-open"),
    `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(path.join(home, "opened.txt"))}\n`,
  );
  chmodSync(path.join(opener, "xdg-open"), 0o755);
  // The person's own keys stay out; tests set the one they need.
  const {
    KIMI_API_KEY: _kimi,
    MOONSHOT_API_KEY: _moonshot,
    ...inherited
  } = process.env;
  const env = (extra: Record<string, string> = {}) => ({
    ...inherited,
    HOME: home,
    KIMI_CODE_HOME: "",
    KIMI_API_KEY: "sk-kimi-test-key",
    PATH: `${bin}:${opener}:${process.env.PATH}`,
    ...extra,
  });
  return {
    home,
    kimiHome,
    file: (name: string) => {
      const file = path.join(kimiHome, name);
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    },
    setup: (ctx = context, extra: Record<string, string> = {}) =>
      spawnSync("bash", ["-s"], {
        input: renderSetupScript(ctx),
        encoding: "utf8",
        env: env(extra),
      }),
    disconnect: () =>
      spawnSync(
        process.execPath,
        [path.join(home, ".archestra/kimi-code/lifecycle.cjs"), "disconnect"],
        { encoding: "utf8", env: env() },
      ),
    lifecycle: (action: string, extra: Record<string, string> = {}) =>
      spawnSync(
        process.execPath,
        [path.join(home, ".archestra/kimi-code/lifecycle.cjs"), action],
        { encoding: "utf8", env: env(extra) },
      ),
    opened: () => {
      const file = path.join(home, "opened.txt");
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    },
    calls: () => readFileSync(path.join(home, "kimi-calls.log"), "utf8"),
    folders: () => readFileSync(path.join(home, "kimi-folders.log"), "utf8"),
  };
}

/** The shared connection code, run as on Windows with only `dir` on PATH. */
function onWindows(dir: string) {
  const windows = {
    platform: "win32",
    env: { Path: dir },
    execPath: process.execPath,
  };
  return new Function(
    "require",
    "process",
    `${KIMI_CODE_CONNECTION}; return KimiCodeConnection;`,
  )(createRequire(import.meta.url), windows) as {
    command(): { argv: string[]; version: string | null; npm: boolean };
  };
}

describe("Kimi Code setup", () => {
  test("routes the model through the proxy, adds the gateway and approves its helpers", () => {
    const f = fixture();
    const result = f.setup();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const config = f.file("config.toml") ?? "";
    expect(config).toContain('default_model = "archestra"');
    // Kimi Code 2.3.3 does not apply the allow rules below, so the helpers run
    // without a prompt only in Ask When Needed mode.
    expect(config).toContain('default_permission_mode = "yolo"');
    expect(config).toContain(
      [
        "[providers.archestra]",
        'type = "kimi"',
        'base_url = "https://platform.example/v1/kimi-code"',
        'api_key_env = "KIMI_API_KEY"',
        "",
        "[providers.archestra.custom_headers]",
        '"X-Archestra-Agent-Id" = "kimi-code"',
        '"X-Archestra-Virtual-Key" = "arch_attribution_key"',
        "",
        "[models.archestra]",
        'provider = "archestra"',
        'model = "k3.1-pro"',
        "max_context_size = 131072",
        'capabilities = ["tool_use","thinking","always_thinking"]',
      ].join("\n"),
    );
    for (const tool of [
      "run_tool",
      "get_remedy_plans",
      "execute_remedy_plan",
      "list_peer_messages",
      "read_peer_message",
      "yell",
      "ask_user",
    ]) {
      expect(config).toContain(
        `[[permission.rules]]\ndecision = "allow"\npattern = "mcp__archestra__archestra_${tool}"`,
      );
    }
    expect(JSON.parse(f.file("mcp.json") ?? "{}")).toEqual({
      mcpServers: {
        archestra: {
          url: "https://platform.example/v1/mcp/gateway",
          toolTimeoutMs: 600000,
        },
      },
    });
    expect(f.file("AGENTS.md")).toContain(
      "Offer to continue the session in the cloud.",
    );
    // Kimi Code checks the result with its own parser.
    expect(f.calls()).toContain("doctor");
    // The startup check wraps kimi in the shell profile.
    expect(readFileSync(path.join(f.home, ".bashrc"), "utf8")).toContain(
      "# >>> archestra kimi-code guard >>>",
    );
    // The handoff text lives in AGENTS.md: kimi has no prompt-file flag.
    expect(
      readFileSync(
        path.join(f.home, ".archestra/kimi-code-startup-guard.sh"),
        "utf8",
      ),
    ).not.toContain("--append-system-prompt-file");
  });

  test("keeps the person's settings, reruns cleanly and disconnects back to them", () => {
    const f = fixture({ config: USER_CONFIG });
    expect(f.setup().status).toBe(0);
    const first = f.file("config.toml");
    expect(first).toContain('default_model = "archestra"');
    expect(first).toContain("[providers.mine]");
    expect(first).toContain('pattern = "Bash(rm *)"');
    expect(first).toContain('notes = [\n  "[not a table]",\n]');
    expect(f.setup().status).toBe(0);
    expect(f.file("config.toml")).toBe(first);

    const result = f.disconnect();
    expect(result.status, result.stderr).toBe(0);
    expect(f.file("config.toml")).toBe(USER_CONFIG);
    // Setup created mcp.json and AGENTS.md; disconnect leaves nothing behind.
    expect(f.file("mcp.json")).toBeNull();
    expect(f.file("AGENTS.md")).toBeNull();
    expect(existsSync(path.join(f.home, ".archestra/kimi-code"))).toBe(false);
  });

  test("restores the person's own permission mode, unless they changed it since", () => {
    const own = `default_permission_mode = "manual" # mine\n${USER_CONFIG}`;
    const f = fixture({ config: own });
    expect(f.setup().status).toBe(0);
    const first = f.file("config.toml") ?? "";
    expect(first).toContain('default_permission_mode = "yolo"');
    expect(first).not.toContain('default_permission_mode = "manual"');
    expect(f.setup().status).toBe(0);
    expect(f.file("config.toml")).toBe(first);
    expect(f.disconnect().status).toBe(0);
    expect(f.file("config.toml")).toBe(own);

    // A mode the person picked after setup stays.
    expect(f.setup().status).toBe(0);
    const config = path.join(f.kimiHome, "config.toml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        'default_permission_mode = "yolo"',
        'default_permission_mode = "auto"',
      ),
    );
    expect(f.disconnect().status).toBe(0);
    expect(f.file("config.toml")).toContain('default_permission_mode = "auto"');
  });

  test("leaves the permission mode alone for a connection that did not set it", () => {
    const own = `default_permission_mode = "yolo"\n${USER_CONFIG}`;
    const f = fixture({ config: own });
    expect(f.setup().status).toBe(0);
    // An earlier setup recorded no permission mode.
    const stateFile = path.join(f.home, ".archestra/kimi-code/state.json");
    const { previousPermissionMode: _mode, ...earlier } = JSON.parse(
      readFileSync(stateFile, "utf8"),
    );
    writeFileSync(stateFile, JSON.stringify(earlier));
    expect(f.disconnect().status).toBe(0);
    expect(f.file("config.toml")).toBe(own);
  });

  test("finds its tables after Kimi Code rewrote config.toml without the markers", () => {
    const f = fixture({ config: USER_CONFIG });
    expect(f.setup().status).toBe(0);
    const rewritten = (f.file("config.toml") ?? "")
      .split("\n")
      .filter((line) => !line.startsWith("# >>>") && !line.startsWith("# <<<"))
      .join("\n");
    writeFileSync(path.join(f.kimiHome, "config.toml"), rewritten);
    expect(f.disconnect().status).toBe(0);
    const after = f.file("config.toml") ?? "";
    expect(after).not.toContain("[providers.archestra]");
    expect(after).not.toContain("[models.archestra]");
    expect(after).not.toContain("mcp__archestra__");
    expect(after).toContain('default_model = "mine" # keep this');
    expect(after).toContain('pattern = "Bash(rm *)"');
  });

  test("uses an Archestra virtual key when one is issued", () => {
    const f = fixture();
    const result = f.setup({
      ...context,
      proxy: context.proxy && {
        ...context.proxy,
        authMode: "virtual-key",
        virtualKey: "arch_virtual_key",
        virtualKeyName: "Kimi Code",
        passthroughVirtualKey: null,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const config = f.file("config.toml") ?? "";
    expect(config).toContain('api_key = "arch_virtual_key"');
    expect(config).not.toContain("api_key_env");
    expect(config).not.toContain("X-Archestra-Virtual-Key");
  });

  test("refuses a provider or model alias the person already named archestra", () => {
    const f = fixture({
      config:
        '[providers.archestra]\ntype = "openai"\nbase_url = "https://example.com"\n',
    });
    const result = f.setup();
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      "config.toml already defines [providers.archestra]",
    );
    expect(f.file("config.toml")).toBe(
      '[providers.archestra]\ntype = "openai"\nbase_url = "https://example.com"\n',
    );
  });

  test("restores the files when kimi doctor rejects the result", () => {
    const f = fixture({ config: USER_CONFIG });
    const result = f.setup(context, { KIMI_FAKE_DOCTOR_FAILS: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      "Kimi Code rejected the updated configuration, so setup restored your files.",
    );
    expect(f.file("config.toml")).toBe(USER_CONFIG);
    expect(f.file("mcp.json")).toBeNull();
    expect(existsSync(path.join(f.home, ".archestra/kimi-code"))).toBe(false);
  });

  test("refuses a Kimi Code older than the checked version", () => {
    const f = fixture({ version: "2.2.9" });
    const result = f.setup();
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      "Update Kimi Code to 2.3.3 or later with kimi upgrade",
    );
    expect(f.file("config.toml")).toBeNull();
  });

  test("keeps its own skills, apart from shared skills another deployment made", () => {
    const f = fixture({ config: USER_CONFIG });
    // A marketplace repository; Git reaches it under both deployments' URLs.
    const remote = path.join(f.home, "remote");
    mkdirSync(path.join(remote, "plugins/team-skills/skills/check-add"), {
      recursive: true,
    });
    writeFileSync(
      path.join(remote, "plugins/team-skills/skills/check-add/SKILL.md"),
      "---\nname: check-add\ndescription: Verify sums.\n---\n",
    );
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", remote, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("add", "-A");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "Skills",
    );
    const gitConfig = path.join(f.home, "gitconfig");
    const file = new URL(`file://${remote}/`).href;
    writeFileSync(
      gitConfig,
      `[url "${file}"]\n insteadOf = https://one.example/repo.git\n insteadOf = https://two.example/repo.git\n`,
    );
    const gitEnv = { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
    // Pi or an older setup left a shared checkout that another deployment owns.
    const shared = path.join(f.home, ".archestra/skills/team-skills");
    mkdirSync(path.join(shared, ".git"), { recursive: true });
    const sharedOwner = JSON.stringify({
      format: 1,
      origin: "https://elsewhere.example",
      revision: "0".repeat(40),
    });
    writeFileSync(path.join(shared, ".git/archestra-skills.json"), sharedOwner);
    const own = path.join(f.home, ".archestra/kimi-code/skills/team-skills");
    const connect = (origin: string) =>
      f.setup(
        {
          ...context,
          skills: {
            cloneUrl: `${origin}/repo.git`,
            marketplaceName: "team-skills",
          },
        },
        gitEnv,
      );
    const ownerOrigin = () =>
      JSON.parse(
        readFileSync(path.join(own, ".git/archestra-skills.json"), "utf8"),
      ).origin;

    let result = connect("https://one.example");
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(
      existsSync(
        path.join(own, "plugins/team-skills/skills/check-add/SKILL.md"),
      ),
    ).toBe(true);
    expect(f.file("config.toml")).toContain(
      JSON.stringify(path.join(own, "plugins/team-skills/skills")),
    );
    expect(ownerOrigin()).toBe("https://one.example");

    // Connecting to another deployment replaces the checkout.
    result = connect("https://two.example");
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(ownerOrigin()).toBe("https://two.example");

    // The launch check's refresh brings in what the marketplace added since.
    mkdirSync(path.join(remote, "plugins/team-skills/skills/check-sub"));
    writeFileSync(
      path.join(remote, "plugins/team-skills/skills/check-sub/SKILL.md"),
      "---\nname: check-sub\ndescription: Verify differences.\n---\n",
    );
    git("add", "-A");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "More skills",
    );
    const refresh = f.lifecycle("refresh-skills", gitEnv);
    expect(refresh.status, refresh.stderr).toBe(0);
    expect(
      existsSync(
        path.join(own, "plugins/team-skills/skills/check-sub/SKILL.md"),
      ),
    ).toBe(true);

    expect(f.disconnect().status).toBe(0);
    expect(f.file("config.toml")).toBe(USER_CONFIG);
    expect(existsSync(path.join(f.home, ".archestra/kimi-code"))).toBe(false);
    expect(
      readFileSync(path.join(shared, ".git/archestra-skills.json"), "utf8"),
    ).toBe(sharedOwner);
  });

  test("uses the person's Kimi Code sign-in for the archestra model", () => {
    const login = `default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
oauth_host = "https://auth.kimi.com"
`;
    const f = fixture({ config: login });
    const result = f.setup(context, { KIMI_API_KEY: "" });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain(
      "The archestra model uses your Kimi Code sign-in.",
    );
    const config = f.file("config.toml") ?? "";
    expect(config).toContain(
      '[providers.archestra.oauth]\nstorage = "file"\nkey = "oauth/kimi-code"\noauth_host = "https://auth.kimi.com"',
    );
    expect(config).not.toContain("api_key_env");
    expect(f.disconnect().status).toBe(0);
    expect(f.file("config.toml")).toBe(login);
  });

  test("stops before changing anything without a Kimi Code sign-in or key", () => {
    const f = fixture({ config: USER_CONFIG });
    const result = f.setup(context, { KIMI_API_KEY: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      "Sign in to Kimi Code first with kimi login, or set KIMI_API_KEY to a Kimi Code API key, then rerun setup.",
    );
    expect(f.file("config.toml")).toBe(USER_CONFIG);
    expect(existsSync(path.join(f.home, ".archestra/kimi-code"))).toBe(false);
  });

  test("signs in to the gateway through Kimi Code and opens only its URL", async () => {
    const f = fixture();
    const reference = "csr1_test_setup_reference";
    expect(
      f.setup({
        ...context,
        proxy: context.proxy && { ...context.proxy, setupReference: reference },
      }).status,
    ).toBe(0);
    const result = f.lifecycle("sign-in");
    expect(result.status, result.stderr).toBe(0);
    // The person sees the helper's own progress and the URL; Kimi Code's
    // thinking, tool status, version, resume hint and answer stay out.
    const gatewayUrl = `https://platform.example/api/auth/oauth2/authorize?response_type=code&resource=${encodeURIComponent("https://platform.example/v1/mcp/gateway")}`;
    expect(result.stdout).toBe(
      [
        "Starting Kimi Code to sign in to the archestra MCP gateway...",
        "Opened the sign-in page in your browser. If it did not open, go to:",
        "",
        `  ${gatewayUrl}`,
        "",
        "Waiting for you to approve it...",
        "",
      ].join("\n"),
    );
    expect(result.stderr).toBe("");
    // The proxy exempts only the conversation that holds the setup
    // reference, and kimi -c in a project never continues it.
    expect(f.calls()).toContain(
      `-p Sign in to the archestra MCP server: call its authenticate tool once and wait for it to finish. Do nothing else. Setup reference: ${reference}`,
    );
    expect(f.folders()).toBe(
      `${path.join(f.home, ".archestra/kimi-code/sign-in")}\n`,
    );
    // The opener runs detached; give it a moment.
    for (let i = 0; i < 40 && !f.opened(); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.opened()).toBe(`${gatewayUrl}\n`);
    expect(f.disconnect().status).toBe(0);
    expect(existsSync(path.join(f.home, ".archestra/kimi-code"))).toBe(false);
  });

  test("reports a sign-in that saved no gateway tokens as failed, with Kimi Code's reason", () => {
    const f = fixture();
    expect(f.setup().status).toBe(0);
    const result = f.lifecycle("sign-in", { KIMI_FAKE_SIGN_IN: "refused" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "[appa] Not checked: the call did not run.",
    );
    expect(result.stderr).toContain(
      "Kimi Code did not sign in to the archestra MCP gateway.",
    );
    expect(f.calls()).not.toContain("Setup reference");
  });

  test("signs in again over an earlier sign-in, and keeps it when that fails", async () => {
    const f = fixture();
    expect(f.setup().status).toBe(0);
    const tokens = path.join(
      f.kimiHome,
      "credentials/mcp/archestra-0123-tokens.json",
    );
    expect(f.lifecycle("sign-in").status).toBe(0);
    const first = readFileSync(tokens, "utf8");
    // Kimi Code offers its authenticate tool only without saved tokens.
    const again = f.lifecycle("sign-in");
    expect(again.status, again.stderr).toBe(0);
    const second = readFileSync(tokens, "utf8");
    expect(second).not.toBe(first);
    for (let i = 0; i < 40 && f.opened().split("\n").length < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.opened().trim().split("\n")).toHaveLength(2);

    const refused = f.lifecycle("sign-in", { KIMI_FAKE_SIGN_IN: "refused" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      "Kimi Code did not sign in to the archestra MCP gateway. Its earlier sign-in is kept.",
    );
    expect(readFileSync(tokens, "utf8")).toBe(second);
    expect(existsSync(`${tokens}.archestra-sign-in`)).toBe(false);
  });

  test.each([
    {
      platform: "linux" as const,
      signIn: "node ~/.archestra/kimi-code/lifecycle.cjs sign-in",
    },
    {
      platform: "windows" as const,
      signIn: 'node "$HOME\\.archestra\\kimi-code\\lifecycle.cjs" sign-in',
    },
  ])("signs in through its helper and starts kimi on $platform", ({
    platform,
    signIn,
  }) => {
    const ctx = { ...context, platform };
    const ending = buildEnding(ctx, "Kimi Code", kimiCodeSetup.ending(ctx));
    expect(ending.signIn?.text).toBe(signIn);
    expect(ending.launch?.text).toBe("kimi");
  });

  test("sets up the native build from Kimi Code's install script", () => {
    const f = fixture({ native: true, config: USER_CONFIG });
    const result = f.setup();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(f.file("config.toml")).toContain('default_model = "archestra"');
    expect(f.calls()).toContain("--version");
    expect(f.calls()).toContain("doctor");
    expect(f.disconnect().status).toBe(0);
    expect(f.file("config.toml")).toBe(USER_CONFIG);
  });

  test.each([
    ["the native build", ["kimi.exe"], false],
    ["the npm package behind its shims", ["kimi.cmd", "kimi.ps1"], true],
  ])("runs %s on Windows", (_label, shims, npm) => {
    const dir = mkdtempSync(path.join(tmpdir(), "kimi windows "));
    homes.push(dir);
    for (const shim of shims) writeFileSync(path.join(dir, shim), "");
    const pkg = path.join(dir, "node_modules/@moonshot-ai/kimi-code");
    if (npm) {
      mkdirSync(path.join(pkg, "dist"), { recursive: true });
      writeFileSync(path.join(pkg, "dist/main.mjs"), "");
      writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({
          name: "@moonshot-ai/kimi-code",
          version: "2.3.3",
          bin: { kimi: "dist/main.mjs" },
        }),
      );
    }
    expect(onWindows(dir).command()).toEqual(
      npm
        ? {
            argv: [process.execPath, path.join(pkg, "dist/main.mjs")],
            version: "2.3.3",
            npm: true,
          }
        : { argv: [path.join(dir, "kimi.exe")], version: null, npm: false },
    );
  });

  test("names Kimi Code's Windows install script when no kimi can run", () => {
    // An npm shim without its package needs a shell to run.
    const dir = mkdtempSync(path.join(tmpdir(), "kimi windows "));
    homes.push(dir);
    writeFileSync(path.join(dir, "kimi.cmd"), "");
    expect(() => onWindows(dir).command()).toThrow(
      "Install it with irm https://code.kimi.com/kimi-code/install.ps1 | iex",
    );
  });

  test("refuses to replace a different MCP server with the gateway's name", () => {
    const f = fixture();
    writeFileSync(
      path.join(f.kimiHome, "mcp.json"),
      JSON.stringify({ mcpServers: { archestra: { url: "https://other" } } }),
    );
    const result = f.setup();
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      "A different MCP server already uses the name archestra",
    );
    expect(existsSync(path.join(f.home, ".archestra/kimi-code"))).toBe(false);
  });

  test("renders a PowerShell setup that runs the same Node.js steps", () => {
    const script = renderSetupScript({ ...context, platform: "windows" });
    expect(script).toContain("$archNodeScript");
    expect(script).toContain("kimi-code-startup-guard.ps1");
    expect(script).not.toContain("--append-system-prompt-file");
  });
});

describe("Kimi Code tool names", () => {
  // Expected names come from Kimi Code 2.3.3's own qualifyMcpToolName.
  test.each([
    ["archestra", "archestra__run_tool", "mcp__archestra__archestra_run_tool"],
    [
      "my-gateway.dev",
      "archestra__execute_remedy_plan",
      "mcp__my-gateway_dev__archestra_execute_remedy_plan",
    ],
    [
      "a_very_long_gateway_server_name",
      "archestra__list_peer_messages",
      "mcp__a_very_long_gateway_server_name__archestra_list_pe_-c2ce985",
    ],
  ])("names %s/%s as Kimi Code does", (server, tool, expected) => {
    const connection = new Function(
      "require",
      `${KIMI_CODE_CONNECTION}; return KimiCodeConnection;`,
    )(createRequire(import.meta.url)) as {
      qualifiedToolName(server: string, tool: string): string;
    };
    expect(connection.qualifiedToolName(server, tool)).toBe(expected);
  });
});
