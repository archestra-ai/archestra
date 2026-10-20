import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { renderSetupScript, type SetupScriptContext } from "../index";
import { SETUP_STOPPED_EXIT_CODE } from "../types";

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
    if (process.env.ACCOUNT === 'chatgpt') { fs.writeFileSync(renewed, ''); reply.result.account = { type: 'chatgpt', email: 'user@example.com', planType: 'plus' }; }
    if (process.env.ACCOUNT === 'unauthorized') { delete reply.result; reply.error = { code: -32603, message: 'workspace routing discovery unauthorized (401)' }; }
    console.log(JSON.stringify(reply));
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'mcp' && args[1] === 'add') fs.appendFileSync(path.join(home, 'config.toml'), '\\n[mcp_servers.test_gateway]\\nurl = "https://example.com/v1/mcp/test"\\n');
// Like the real CLI, report the clone URL as given, credential included.
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
      /mcp|plugin/,
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

test("installer output hides the marketplace credential that Codex echoes from the clone URL", async () => {
  const cloneUrl =
    "https://token:archestra_mkt_secret@example.com/skills/marketplace.git";
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
        failMarketplace
          ? "git clone https://***@example.com/skills/marketplace.git failed"
          : "from https://***@example.com/skills/marketplace.git",
      );
      expect(output).not.toContain("archestra_mkt_secret");
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
    message:
      "Codex could not download its model list. Check that this computer can reach chatgpt.com (proxy, VPN or firewall), then start a new installer run.",
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
    expect(calls).toContain("app-server");
    expect(calls).not.toMatch(/mcp|plugin/);
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
