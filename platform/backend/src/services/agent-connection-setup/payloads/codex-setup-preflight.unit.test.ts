import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { renderSetupScript, type SetupScriptContext } from "../index";
import { SETUP_STOPPED_EXIT_CODE } from "../types";
import { CODEX_HANDOFF_HELPER, CODEX_WSL_SETUP_HINT } from "./codex-handoff";

const exec = promisify(execFile);
const ctx: SetupScriptContext = {
  clientId: "codex",
  platform: "macos",
  appName: "Test Platform",
  mcp: {
    serverName: "test_gateway",
    toolPrefix: "test__",
    url: "https://example.com/v1/mcp/test",
  },
  proxy: {
    authMode: "provider-key",
    provider: "openai",
    providerLabel: "OpenAI",
    baseUrl: "https://example.com/v1",
    url: "https://example.com/v1/openai",
    proxyName: "test_proxy",
    virtualKey: null,
    virtualKeyName: null,
    passthroughVirtualKey: null,
    model: null,
  },
  skills: {
    cloneUrl: "https://example.com/skills/marketplace.git",
    marketplaceName: "test-skills",
    pluginNames: [],
  },
};
const original =
  'model = "app-model"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n';

// Only the external CLI boundary is substituted. The generated installer, config
// edits, preflight helper and recovery all execute as real child processes.
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "codex preflight "));
  const codexHome = path.join(home, "custom codex home");
  await mkdir(codexHome);
  const config = path.join(codexHome, "config.toml");
  await writeFile(config, original);
  await writeFile(path.join(home, ".zshrc"), "# existing shell profile\n");
  const cli = path.join(home, "codex");
  await writeFile(
    cli,
    `#!${process.execPath}
(() => {
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const home = process.env.CODEX_HOME;
fs.appendFileSync(path.join(process.env.HOME, 'calls'), args.join(' ') + '\\n');
if (args[0] === '--version') { console.log('codex-cli test-version'); process.exit(0); }
if (args[0] === 'sandbox' && process.env.BROKEN_SANDBOX) {
  console.error('bubblewrap is unavailable: no system bwrap or bundled helper was found');
  process.exit(101);
}
// Like Codex: a model_catalog_json file it cannot open stops every command.
// A relative path is relative to the Codex folder.
const catalog = /^model_catalog_json = "(.*)"$/m.exec(fs.existsSync(path.join(home, 'config.toml')) ? fs.readFileSync(path.join(home, 'config.toml'), 'utf8') : '')?.[1];
if (catalog && !fs.existsSync(path.resolve(home, catalog))) {
  console.error('Error: failed to load configuration\\n\\nCaused by:\\n    No such file or directory (os error 2)');
  process.exit(1);
}
if (args[0] === 'debug' && process.env.BROKEN_CONFIG) {
  console.error('Error: ' + path.join(home, 'config.toml') + ':1:14: invalid transport\\n\\nCaused by:\\n    in \`mcp_servers.test_gateway\`');
  process.exit(1);
}
// Like Codex after a failed download: the bundled catalog, a successful exit
// and no cache. STALE_UNTIL_SIGN_IN models a sign-in that app-server renews.
const renewed = path.join(process.env.HOME, 'renewed');
if (args[0] === 'debug') {
  if (!process.env.STALE_CATALOG && !(process.env.STALE_UNTIL_SIGN_IN && !fs.existsSync(renewed))) {
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({fetched_at: new Date().toISOString()}));
  }
  console.log(JSON.stringify({models:[{slug:process.env.TEST_MODEL || 'app-model'}]})); process.exit(0);
}
if (args.includes('app-server')) {
  if (process.env.ACCOUNT === 'unsupported') { console.error("error: unrecognized subcommand 'app-server'"); process.exit(2); }
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
    if (message.method !== 'account/read') return;
    if (!message.params.refreshToken) process.exit(1);
    const reply = { id: message.id, result: { account: null, requiresOpenaiAuth: true } };
    // Codex saves a renewal in place; chatgpt-replaced writes a new file instead
    // and chatgpt-unchanged is a sign-in that needed no renewal.
    if (process.env.ACCOUNT?.startsWith('chatgpt')) reply.result.account = { type: 'chatgpt', email: 'user@example.com', planType: 'plus' };
    if (process.env.ACCOUNT === 'chatgpt') { fs.writeFileSync(renewed, ''); fs.writeFileSync(path.join(home, 'auth.json'), '{"auth_mode":"chatgpt","tokens":"renewed"}'); }
    if (process.env.ACCOUNT === 'chatgpt-replaced') { fs.writeFileSync(path.join(home, 'auth.json.tmp'), '{"auth_mode":"chatgpt","tokens":"renewed"}'); fs.renameSync(path.join(home, 'auth.json.tmp'), path.join(home, 'auth.json')); }
    if (process.env.ACCOUNT === 'unauthorized') { delete reply.result; reply.error = { code: -32603, message: 'workspace routing discovery unauthorized (401)' }; }
    console.log(JSON.stringify(reply));
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'mcp' && args[1] === 'add') fs.appendFileSync(path.join(home, 'config.toml'), '\\n[mcp_servers.test_gateway]\\nurl = "https://example.com/v1/mcp/test"\\n');
// Like the real CLI, report the clone URL as given, credential included.
if (args[0] === 'plugin' && args[1] === 'add' && !args.includes('--help') && process.env.FAIL_PLUGIN) { console.error('Plugin download failed'); process.exit(23); }
if (args[0] === 'plugin' && process.env.FAIL_MARKETPLACE) { console.error('Error: git clone ' + args[3] + ' failed with status exit status: 128'); process.exit(22); }
// Codex 0.162 keeps one source per marketplace name and refuses another one.
const marketplace = path.join(process.env.HOME, 'marketplace-source');
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
  if (!fs.existsSync(marketplace)) { console.error('Error: marketplace \`' + args[3] + '\` is not configured or installed'); process.exit(1); }
  fs.rmSync(marketplace);
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  if (fs.existsSync(marketplace) && fs.readFileSync(marketplace, 'utf8') !== args[3]) {
    console.error("Error: marketplace 'test-skills' is already added from a different source; remove it before adding this source");
    process.exit(1);
  }
  fs.writeFileSync(marketplace, args[3]);
  console.log('Added marketplace \`test-skills\` from ' + args[3] + '.');
}
})();
`,
  );
  await chmod(cli, 0o700);
  const script = path.join(home, "setup.sh");
  await writeFile(script, renderSetupScript(ctx));
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    PATH: `${home}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    NO_COLOR: "1",
  };
  return { home, codexHome, config, script, env };
}

test("model mismatch stops setup before client mutations", async () => {
  const f = await fixture();
  try {
    const result = await exec("bash", [f.script], {
      env: { ...f.env, TEST_MODEL: "cli-only-model" },
    }).catch((error) => error);
    expect(result.code).toBe(SETUP_STOPPED_EXIT_CODE);
    expect(result.stderr).toContain("No client configuration was changed");
    expect(result.stderr).toContain('"app-model"');
    expect(result.stderr).toContain("codex-cli test-version");
    expect(await readFile(f.config, "utf8")).toBe(original);
    expect(await readFile(path.join(f.home, ".zshrc"), "utf8")).toBe(
      "# existing shell profile\n",
    );
    expect(await readdir(f.codexHome)).toEqual(["config.toml"]);
    expect(await readFile(path.join(f.home, "calls"), "utf8")).not.toMatch(
      /mcp (add|remove)|plugin/,
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("failed marketplace setup reports incomplete installation and recovers the current configuration rather than a stale backup", async () => {
  const f = await fixture();
  try {
    await writeFile(`${f.config}.archestra-backup`, 'model = "old-model"\n');
    const result = await exec("bash", [f.script], {
      env: { ...f.env, FAIL_MARKETPLACE: "1" },
    }).catch((error) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Setup is incomplete");
    expect(result.stderr).toContain("Registration has not been verified");
    expect(result.stdout).not.toContain("is connected to");
    expect(await readFile(f.config, "utf8")).toContain(
      'model_provider = "test_proxy"',
    );
    const backups = (await readdir(f.codexHome)).filter((name) =>
      name.startsWith("archestra-setup-"),
    );
    expect(backups).toHaveLength(1);
    const backup = path.join(f.codexHome, backups[0]);
    expect((await stat(backup)).mode & 0o777).toBe(0o700);
    await exec(process.execPath, [path.join(backup, "recover.cjs")], {
      env: f.env,
    });
    expect(await readFile(f.config, "utf8")).toBe(original);
    expect(await readFile(path.join(f.home, ".zshrc"), "utf8")).toBe(
      "# existing shell profile\n",
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("gateway-only setup skips model discovery and recovery removes a config created by the failed attempt", async () => {
  const f = await fixture();
  try {
    await rm(f.config);
    await writeFile(f.script, renderSetupScript({ ...ctx, proxy: null }));
    const result = await exec("bash", [f.script], {
      env: { ...f.env, FAIL_MARKETPLACE: "1", TEST_MODEL: "cli-only-model" },
    }).catch((error) => error);
    expect(result.stderr).toContain("Setup is incomplete");
    expect(await readFile(path.join(f.home, "calls"), "utf8")).not.toContain(
      "debug models",
    );
    const backup = (await readdir(f.codexHome)).find((name) =>
      name.startsWith("archestra-setup-"),
    );
    expect(backup).toBeDefined();
    await exec(
      process.execPath,
      [path.join(f.codexHome, backup ?? "", "recover.cjs")],
      { env: f.env },
    );
    await expect(stat(f.config)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a rerun replaces the marketplace an earlier setup registered from another clone URL", async () => {
  const f = await fixture();
  try {
    // Every setup gets a new credential in its clone URL.
    await writeFile(
      path.join(f.home, "marketplace-source"),
      "https://old-token@example.com/skills/marketplace.git",
    );
    const result = await exec("bash", [f.script], { env: f.env }).catch(
      (error) => error,
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "Marketplace registration failed",
    );
    expect(
      await readFile(path.join(f.home, "marketplace-source"), "utf8"),
    ).toBe(ctx.skills?.cloneUrl);
    const calls = await readFile(path.join(f.home, "calls"), "utf8");
    // A fresh catalog needs no account check.
    expect(calls).not.toContain("app-server");
    expect(calls).toContain(
      `plugin marketplace remove test-skills\nplugin marketplace add ${ctx.skills?.cloneUrl}\n`,
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test.each([
  {
    cloneUrl:
      "https://token:archestra_mkt_secret@example.com/skills/marketplace.git",
    maskedUrl: "https://***@example.com/skills/marketplace.git",
    secret: "archestra_mkt_secret",
  },
  {
    cloneUrl:
      "https://example.com/skills/m/archestra_skl_fixture_secret/repo.git",
    maskedUrl: "https://example.com/skills/m/archestra_skl_***/repo.git",
    secret: "archestra_skl_fixture_secret",
  },
])("installer output hides the credential that Codex echoes from $cloneUrl", async ({
  cloneUrl,
  maskedUrl,
  secret,
}) => {
  for (const failMarketplace of [false, true]) {
    const f = await fixture();
    try {
      await writeFile(
        f.script,
        renderSetupScript({
          ...ctx,
          skills: { cloneUrl, marketplaceName: "test-skills", pluginNames: [] },
        }),
      );
      const result = await exec("bash", [f.script], {
        env: failMarketplace ? { ...f.env, FAIL_MARKETPLACE: "1" } : f.env,
      }).catch((error) => error);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(
        failMarketplace ? `git clone ${maskedUrl} failed` : `from ${maskedUrl}`,
      );
      expect(output).not.toContain(secret);
      expect(output).not.toContain("HTTP 502");
      // Codex itself still receives the credential-bearing URL.
      expect(await readFile(path.join(f.home, "calls"), "utf8")).toContain(
        `plugin marketplace add ${cloneUrl}\n`,
      );
    } finally {
      await rm(f.home, { recursive: true, force: true });
    }
  }
});

test("preflight shows the Codex error for a config Codex cannot load", async () => {
  const f = await fixture();
  try {
    const result = await exec("bash", [f.script], {
      env: { ...f.env, BROKEN_CONFIG: "1" },
    }).catch((error) => error);
    expect(result.code).toBe(SETUP_STOPPED_EXIT_CODE);
    expect(result.stderr).toContain("Could not read the Codex model catalog");
    expect(result.stderr).toContain(
      `Error: ${f.config}:1:14: invalid transport`,
    );
    expect(result.stderr).toContain("in `mcp_servers.test_gateway`");
    expect(result.stderr).not.toContain(".archestra-codex-models-");
    expect(await readFile(f.config, "utf8")).toBe(original);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test.each([
  { name: "with the LLM proxy", proxy: ctx.proxy },
  { name: "gateway-only", proxy: null },
])("preflight stops $name setup when Codex cannot load a config value that model discovery leaves out", async ({
  proxy,
}) => {
  const f = await fixture();
  try {
    const config = `model_catalog_json = "${path.join(f.codexHome, "missing.json")}"\n${original}`;
    await writeFile(f.config, config);
    await writeFile(f.script, renderSetupScript({ ...ctx, proxy }));
    const result = await exec("bash", [f.script], { env: f.env }).catch(
      (error) => error,
    );
    expect(result.code).toBe(SETUP_STOPPED_EXIT_CODE);
    expect(result.stderr).toContain(
      `Codex setup preflight failed: Codex could not load ${f.config}. Codex reported:\n  Error: failed to load configuration`,
    );
    expect(result.stderr).toContain("No such file or directory (os error 2)");
    expect(result.stderr).toContain("No client configuration was changed.");
    expect(result.stderr).not.toContain("Setup is incomplete");
    expect(result.stderr).not.toContain("WSL");
    expect(await readFile(f.config, "utf8")).toBe(config);
    expect(await readFile(path.join(f.home, ".zshrc"), "utf8")).toBe(
      "# existing shell profile\n",
    );
    expect(await readdir(f.codexHome)).toEqual(["config.toml"]);
    expect(await readFile(path.join(f.home, "calls"), "utf8")).not.toMatch(
      /mcp (add|remove)|plugin/,
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

const WSL_MODE = "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n";

// Codex's sandbox is checked only on Linux (and in WSL), where it runs.
test.skipIf(process.platform !== "linux").each([
  { name: "with the LLM proxy", proxy: ctx.proxy },
  { name: "gateway-only", proxy: null },
])(
  "a missing sandbox stops $name setup before changing configuration or registering tools",
  async ({ proxy }) => {
    const f = await fixture();
    try {
      await writeFile(f.script, renderSetupScript({ ...ctx, proxy }));
      const result = await exec("bash", [f.script], {
        env: { ...f.env, BROKEN_SANDBOX: "1" },
      }).catch((error) => error);
      expect(result.code).toBe(SETUP_STOPPED_EXIT_CODE);
      expect(result.stderr).toContain("sudo apt install bubblewrap");
      expect(result.stderr).toContain("No client configuration was changed");
      expect(await readFile(f.config, "utf8")).toBe(original);
      expect(await readFile(path.join(f.home, ".zshrc"), "utf8")).toBe(
        "# existing shell profile\n",
      );
      expect(await readdir(f.codexHome)).toEqual(["config.toml"]);
      expect(await readFile(path.join(f.home, "calls"), "utf8")).not.toMatch(
        /mcp (add|remove)|plugin|debug models/,
      );
    } finally {
      await rm(f.home, { recursive: true, force: true });
    }
  },
);

test.each([
  {
    // The desktop app writes WSL paths itself while it runs Codex in WSL.
    name: "a desktop app that runs Codex in WSL",
    home: "C:\\Users\\me\\.codex",
    config: `[mcp_servers.repl]\ncommand = "/mnt/c/tools/repl.exe"\n${WSL_MODE}`,
    hint: null,
  },
  {
    // The paths stay behind after the desktop app stops running Codex in WSL.
    name: "WSL paths with WSL turned off",
    home: "C:\\Users\\me\\.codex\\",
    config:
      'model_catalog_json = "/mnt/c/Users/me/.codex/catalog.json"\n[desktop]\nrunCodexInWindowsSubsystemForLinux = false\n',
    hint: "Change them to Windows paths, for example /mnt/c/Users/me/.codex to C:\\Users\\me\\.codex.",
  },
  {
    name: "a WSL path in an array, with WSL off",
    home: "C:\\Users\\me\\.codex",
    config:
      '[mcp_servers.repl]\ncommand = "node"\nargs = ["/mnt/c/tools/repl.js"]\n',
    hint: "Change them to Windows paths, for example /mnt/c/Users/me/.codex to C:\\Users\\me\\.codex.",
  },
  {
    name: "the WSL switch outside the [desktop] table",
    home: "D:\\codex\\",
    config:
      '[features]\nrunCodexInWindowsSubsystemForLinux = true\n[mcp_servers.repl]\ncommand = "/mnt/d/tools/repl.exe"\n',
    hint: "Change them to Windows paths, for example /mnt/d/codex to D:\\codex.",
  },
  {
    name: "Windows paths only",
    home: "C:\\Users\\me\\.codex",
    config: 'model_catalog_json = "C:\\\\Users\\\\me\\\\catalog.json"\n',
    hint: null,
  },
  {
    name: "a WSL path in a comment",
    home: "C:\\Users\\me\\.codex",
    config: '# model_catalog_json = "/mnt/c/Users/me/.codex/catalog.json"\n',
    hint: null,
  },
  {
    name: "a Linux Codex home",
    home: "/home/me/.codex",
    config: 'model_catalog_json = "/mnt/c/Users/me/.codex/catalog.json"\n',
    hint: null,
  },
])("the WSL setup hint for $name", ({ home, config, hint }) => {
  const message = runInNewContext(
    `${CODEX_WSL_SETUP_HINT}\nwslSetupHint(home, config)`,
    { home, config },
  );
  if (hint === null) expect(message).toBe("");
  else expect(message.endsWith(hint)).toBe(true);
});

test.each([
  {
    name: "Windows, while the desktop app runs Codex in WSL",
    platform: "win32",
    config: WSL_MODE,
    args: ["-c", "mcp_oauth_credentials_store=file", "mcp", "login", "gw"],
  },
  {
    name: "Windows",
    platform: "win32",
    config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = false\n",
    args: ["mcp", "login", "gw"],
  },
  {
    name: "Windows, with the WSL switch outside the [desktop] table",
    platform: "win32",
    config: "[features]\nrunCodexInWindowsSubsystemForLinux = true\n",
    args: ["mcp", "login", "gw"],
  },
  // Codex in WSL has no Windows keyring to miss.
  {
    name: "WSL",
    platform: "linux",
    config: WSL_MODE,
    args: ["mcp", "login", "gw"],
  },
])("the gateway sign-in on $name", ({ platform, config, args }) => {
  expect(
    runInNewContext(
      `${CODEX_WSL_SETUP_HINT}\nsignInArgs(platform, config, "gw")`,
      { platform, config },
    ),
  ).toEqual(args);
});

test.each<{
  name: string;
  env: Record<string, string>;
  signedIn: boolean;
  downloads?: number;
  message: string;
}>([
  {
    name: "a missing sign-in",
    env: { STALE_CATALOG: "1" },
    signedIn: false,
    message:
      "Codex is not signed in on this computer. Run `codex login`, then start a new installer run.",
  },
  {
    name: "a sign-in that Codex cannot renew",
    env: { STALE_CATALOG: "1" },
    signedIn: true,
    message:
      "Codex could not renew its ChatGPT sign-in. The sign-in has expired or was ended elsewhere. Run `codex login`, then start a new installer run.",
  },
  {
    name: "a sign-in that ChatGPT rejects",
    env: { STALE_CATALOG: "1", ACCOUNT: "unauthorized" },
    signedIn: true,
    message: "Codex could not renew its ChatGPT sign-in.",
  },
  {
    name: "a renewed sign-in that still gets no model list",
    env: { STALE_CATALOG: "1", ACCOUNT: "chatgpt" },
    signedIn: true,
    downloads: 2,
    message:
      "Codex could not download its model list. Check that this computer can reach chatgpt.com (proxy, VPN or firewall), then start a new installer run.",
  },
  {
    // Nothing changed, so a second download could only fail the same way.
    name: "a valid sign-in that still gets no model list",
    env: { STALE_CATALOG: "1", ACCOUNT: "chatgpt-unchanged" },
    signedIn: true,
    downloads: 1,
    message: "Codex could not download its model list.",
  },
  {
    name: "a renewal that Codex saves as a new file",
    env: { STALE_CATALOG: "1", ACCOUNT: "chatgpt-replaced" },
    signedIn: true,
    message:
      "Codex renewed its ChatGPT sign-in, but setup could not keep the renewed sign-in. Run `codex login`, then start a new installer run.",
  },
  {
    name: "a Codex without app-server",
    env: { STALE_CATALOG: "1", ACCOUNT: "unsupported" },
    signedIn: true,
    message: "Codex could not download its model list.",
  },
])("preflight names the cause of a stale model list: $name", async ({
  env,
  signedIn,
  downloads,
  message,
}) => {
  const f = await fixture();
  try {
    const auth = path.join(f.codexHome, "auth.json");
    if (signedIn) await writeFile(auth, '{"auth_mode":"chatgpt"}');
    const result = await exec("bash", [f.script], {
      env: { ...f.env, ...env },
    }).catch((error) => error);
    expect(result.code).toBe(SETUP_STOPPED_EXIT_CODE);
    expect(result.stderr).toContain(`Codex setup preflight failed: ${message}`);
    expect(result.stderr.match(/start a new installer run/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("Setup is incomplete");
    expect(await readFile(f.config, "utf8")).toBe(original);
    expect((await readdir(f.codexHome)).sort()).toEqual(
      signedIn ? ["auth.json", "config.toml"] : ["config.toml"],
    );
    const calls = await readFile(path.join(f.home, "calls"), "utf8");
    // With plugins on, app-server leaves a git sync running that keeps the
    // temporary Codex home in use on Windows, so its removal fails.
    expect(calls).toContain("-c features.plugins=false app-server");
    expect(calls).not.toMatch(/mcp (add|remove)|plugin /);
    if (downloads) {
      expect(calls.match(/^debug models/gm)).toHaveLength(downloads);
    }
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a sign-in that Codex renews during preflight lets setup continue", async () => {
  const f = await fixture();
  try {
    await writeFile(
      path.join(f.codexHome, "auth.json"),
      '{"auth_mode":"chatgpt"}',
    );
    const result = await exec("bash", [f.script], {
      env: { ...f.env, STALE_UNTIL_SIGN_IN: "1", ACCOUNT: "chatgpt" },
    }).catch((error) => error);
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "preflight failed",
    );
    expect(await readFile(f.config, "utf8")).toContain(
      'model_provider = "test_proxy"',
    );
    const calls = await readFile(path.join(f.home, "calls"), "utf8");
    expect(calls.match(/app-server/g)).toHaveLength(1);
    expect(calls).toContain("mcp add");
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

// Codex for Windows and the ChatGPT desktop app's Codex in WSL reach one folder
// by two paths, C:\\Users\\me\\.codex and /mnt/c/Users/me/.codex.
test("setup writes the model catalog path relative to the Codex folder, so Codex loads it from another path to that folder", async () => {
  const f = await fixture();
  try {
    await exec("bash", [f.script], { env: f.env });
    expect(await readFile(f.config, "utf8")).toContain(
      'model_catalog_json = "archestra-direct-model-catalog.json"',
    );
    const moved = path.join(f.home, "same codex home");
    await rename(f.codexHome, moved);
    const result = await exec(path.join(f.home, "codex"), ["mcp", "list"], {
      env: { ...f.env, CODEX_HOME: moved },
      cwd: tmpdir(),
    }).catch((error) => error);
    expect(result.stderr).not.toContain("failed to load configuration");
    expect(result.code ?? 0).toBe(0);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("the sign-in helper runs codex mcp login and refuses a server name that is not plain", async () => {
  const f = await fixture();
  try {
    const helper = path.join(f.home, "handoff.cjs");
    await writeFile(helper, CODEX_HANDOFF_HELPER);
    await exec(process.execPath, [helper, "--sign-in", "test_gateway"], {
      env: f.env,
    });
    const refused = await exec(
      process.execPath,
      [helper, "--sign-in", "gw & calc"],
      { env: f.env },
    ).catch((error) => error);
    expect(refused.code).toBe(1);
    expect(await readFile(path.join(f.home, "calls"), "utf8")).toBe(
      "mcp login test_gateway\n",
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a preflight that fails without naming a cause keeps the installer's generic ending", async () => {
  const f = await fixture();
  try {
    // Fails only the preflight's node process, like a crash in its backup step.
    await writeFile(
      path.join(f.home, "node"),
      `#!/bin/bash\ncase "$*" in *setupProxy*) echo 'Error: backup failed' >&2; exit 1;; esac\nexec '${process.execPath}' "$@"\n`,
    );
    await chmod(path.join(f.home, "node"), 0o700);
    const result = await exec("bash", [f.script], { env: f.env }).catch(
      (error) => error,
    );
    expect(result.stderr).toContain("Error: backup failed");
    // Not the stop status, so the installer adds its own next step.
    expect(result.code).toBe(1);
    expect(await readFile(f.config, "utf8")).toBe(original);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test.each([
  false,
  true,
])("ChatGPT installs the connection plugin in the routing setup (plugin fails: %s)", async (failPlugin) => {
  const f = await fixture();
  try {
    await writeFile(
      f.script,
      renderSetupScript({
        ...ctx,
        clientId: "chatgpt",
        skills: {
          cloneUrl: ctx.skills?.cloneUrl ?? "",
          marketplaceName: ctx.skills?.marketplaceName ?? "",
          pluginNames: ["test-skills"],
          connectionPlugin: true,
        },
      }),
    );
    const result = await exec("bash", [f.script], {
      env: { ...f.env, ...(failPlugin ? { FAIL_PLUGIN: "1" } : {}) },
    }).catch((error) => error);
    const calls = await readFile(path.join(f.home, "calls"), "utf8");
    expect(calls).not.toContain("mcp add test_gateway");
    if (!failPlugin) expect(calls).toContain("mcp get test_gateway --json");
    expect(calls).toContain(`plugin marketplace add ${ctx.skills?.cloneUrl}`);
    expect(calls).toContain("plugin add test-skills@test-skills\n");
    const config = await readFile(f.config, "utf8");
    expect(config).toContain('model_provider = "test_proxy"');
    expect(config).not.toContain("[mcp_servers.test_gateway]");
    if (!failPlugin)
      expect(config).toContain(
        '[plugins."test-skills@test-skills".mcp_servers."test_gateway"',
      );
    expect(config).toContain('sandbox_mode = "workspace-write"');
    if (failPlugin) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Plugin installation failed");
      expect(result.stderr).toContain("Setup is incomplete");
      expect(result.stdout).not.toContain("ChatGPT is connected");
    } else {
      expect(result.code).toBeUndefined();
      expect(result.stdout).toContain("ChatGPT is connected");
      expect(result.stdout).toContain("Restart ChatGPT");
      expect(result.stdout).not.toContain("run /plugins");
    }
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
