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
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const home = process.env.CODEX_HOME;
fs.appendFileSync(path.join(process.env.HOME, 'calls'), args.join(' ') + '\\n');
if (args[0] === '--version') { console.log('codex-cli test-version'); process.exit(0); }
if (args[0] === 'debug') {
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({fetched_at: new Date().toISOString()}));
  console.log(JSON.stringify({models:[{slug:process.env.TEST_MODEL || 'app-model'}]})); process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'add') fs.appendFileSync(path.join(home, 'config.toml'), '\\n[mcp_servers.test_gateway]\\nurl = "https://example.com/v1/mcp/test"\\n');
if (args[0] === 'plugin' && process.env.FAIL_MARKETPLACE) { console.error('Git clone failed: HTTP 502'); process.exit(22); }
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
    expect(result.code).toBe(1);
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
