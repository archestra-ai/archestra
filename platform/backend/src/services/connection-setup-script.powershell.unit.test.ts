import { execFile, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS,
  STARTUP_GUARD_INSTALL,
} from "@archestra/shared/consts";
import { parse as parseToml } from "smol-toml";
import { describe, expect, test } from "vitest";
import {
  renderSetupScript,
  type SetupScriptProxySection,
} from "@/services/connection-setup-script";
import { CODEX_HANDOFF_HELPER } from "./codex-handoff";
import { CODEX_GUARD_CLIENT } from "./startup-guard.clients";

const execFileAsync = promisify(execFile);
const powershellAvailable =
  process.platform !== "win32" &&
  spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

describe.skipIf(!powershellAvailable)(
  "PowerShell Claude proxy transitions",
  () => {
    test.each([
      { provider: "anthropic" as const, authKey: "ANTHROPIC_AUTH_TOKEN" },
      { provider: "bedrock" as const, authKey: "AWS_BEARER_TOKEN_BEDROCK" },
    ])("$provider: switches authentication modes without stale credentials or attribution", async ({
      provider,
      authKey,
    }) => {
      const existing = {
        permissions: { allow: ["Read"] },
        env: {
          ANTHROPIC_API_KEY: "sk-ant-api-provider-key",
          USER_SETTING: "preserved",
          ANTHROPIC_CUSTOM_HEADERS:
            "X-User: retained\r\n x-archestra-agent-id : stale-client\r\n X-Archestra-Virtual-Key: arch_old-attribution",
        },
      };
      const standard = claudeProxy({ provider, virtualKey: "arch_standard" });
      const passthrough = claudeProxy({ provider });
      const { snapshots, backup } = await runClaudeProxySetups({
        existing,
        proxies: [
          standard,
          passthrough,
          passthrough,
          { ...passthrough, passthroughVirtualKey: null },
          { ...standard, virtualKey: "arch_rotated" },
        ],
      });

      expect(snapshots[0].env[authKey]).toBe("arch_standard");
      expect(snapshots[1].env).not.toHaveProperty(authKey);
      expect(snapshots[1].env.ANTHROPIC_CUSTOM_HEADERS).toBe(
        "X-User: retained\nX-Archestra-Agent-Id: anthropic_claude_code\nX-Archestra-Virtual-Key: arch_passthrough",
      );
      expect(snapshots[2]).toEqual(snapshots[1]);
      for (const index of [0, 3, 4]) {
        expect(snapshots[index].env.ANTHROPIC_CUSTOM_HEADERS).toBe(
          "X-User: retained\nX-Archestra-Agent-Id: anthropic_claude_code",
        );
      }
      expect(snapshots[4].env[authKey]).toBe("arch_rotated");
      for (const settings of snapshots) {
        expect(settings.permissions).toEqual(existing.permissions);
        expect(settings.env.ANTHROPIC_API_KEY).toBe("sk-ant-api-provider-key");
        expect(settings.env.USER_SETTING).toBe("preserved");
      }
      expect(backup).toEqual(existing);
    });

    test.each([
      "arch_stale",
      "archestra_legacy",
    ])("removes only the selected provider's managed credentials (%s)", async (credential) => {
      const existing = {
        env: {
          ANTHROPIC_AUTH_TOKEN: credential,
          ANTHROPIC_API_KEY: credential,
          AWS_BEARER_TOKEN_BEDROCK: credential,
        },
      };
      const { snapshots, backup } = await runClaudeProxySetups({
        existing,
        proxies: [
          claudeProxy({ provider: "anthropic" }),
          claudeProxy({ provider: "bedrock" }),
        ],
      });
      expect(snapshots[0].env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
      expect(snapshots[0].env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(snapshots[0].env.AWS_BEARER_TOKEN_BEDROCK).toBe(credential);
      expect(snapshots[1].env).not.toHaveProperty("AWS_BEARER_TOKEN_BEDROCK");
      expect(backup).toEqual(existing);
    });

    test.each([
      "arch_stale",
      "archestra_stale",
    ])("virtual-key mode removes a stale primary API key (%s)", async (credential) => {
      const existing = {
        env: {
          ANTHROPIC_API_KEY: credential,
          ANTHROPIC_CUSTOM_HEADERS:
            "X-User: retained\nX-Archestra-Virtual-Key: arch_old-attribution",
        },
      };
      const { snapshots, backup } = await runClaudeProxySetups({
        existing,
        proxies: [
          claudeProxy({ provider: "anthropic", virtualKey: "arch_fresh" }),
        ],
      });
      expect(snapshots[0].env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(snapshots[0].env.ANTHROPIC_AUTH_TOKEN).toBe("arch_fresh");
      expect(snapshots[0].env.ANTHROPIC_CUSTOM_HEADERS).toBe(
        "X-User: retained\nX-Archestra-Agent-Id: anthropic_claude_code",
      );
      expect(backup).toEqual(existing);
    });

    test.each([
      "sk-ant-oat-provider-token",
      "ARCH_case-sensitive",
      "",
      null,
      42,
    ])("preserves provider credentials and non-managed values (%s)", async (credential) => {
      const existing = {
        env: {
          ANTHROPIC_AUTH_TOKEN: credential,
          ANTHROPIC_API_KEY: credential,
          AWS_BEARER_TOKEN_BEDROCK: credential,
        },
      };
      const { snapshots } = await runClaudeProxySetups({
        existing,
        proxies: [
          claudeProxy({ provider: "anthropic" }),
          claudeProxy({ provider: "bedrock" }),
        ],
      });
      for (const settings of snapshots) {
        expect(settings.env).toMatchObject(existing.env);
      }
    });
  },
);

describe.skipIf(!powershellAvailable)(
  "PowerShell session recovery (requires pwsh and POSIX CLI fixtures)",
  () => {
    test.each([
      false,
      true,
    ])("Codex nested verification preserves the catalog and proxy removal restores it, with MCP remaining: %s", async (keepMcp) => {
      const home = await mkdtemp(
        path.join(tmpdir(), "codex-windows-lifecycle-"),
      );
      const config = path.join(home, "config.toml");
      const helper = path.join(home, "guard.ps1.handoff.cjs");
      const cli = path.join(home, "codex");
      const script = path.join(home, "disconnect.ps1");
      const before = `model = "model-a"\nmodel_provider = "llm_proxy"\nweb_search = "live"\n[features]\ncode_mode_host = true\n# >>> archestra:llm_proxy >>>\n[model_providers.llm_proxy]\nname = "llm_proxy"\n# <<< archestra:llm_proxy <<<\n${keepMcp ? '[mcp_servers.gateway]\nurl = "https://example.com/mcp"\n' : ""}`;
      try {
        await writeFile(config, before);
        await writeFile(
          `${config}.archestra-backup`,
          'model_provider = "openai"\n',
        );
        await writeFile(helper, CODEX_HANDOFF_HELPER);
        await writeFile(
          cli,
          `#!/usr/bin/env node\nif (process.env.CODEX_SANDBOX_NETWORK_DISABLED) process.exit(2); require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString()})); console.log(JSON.stringify({models:[{slug:'model-a',tool_mode:'code_mode_only'}]}));`,
        );
        await chmod(cli, 0o755);
        const env = { ...process.env, USERPROFILE: home, CODEX_HOME: home };
        await execFileAsync(
          process.execPath,
          [helper, "--install-direct", cli],
          { env },
        );
        expect(
          parseToml(await readFile(config, "utf8")).model_catalog_json,
        ).toBeDefined();
        await writeFile(
          script,
          `$ErrorActionPreference = 'Stop'
$GuardPath = Join-Path $env:CODEX_HOME 'guard.ps1'
$configPath = Join-Path $env:CODEX_HOME 'config.toml'
$beforeProbe = Get-Content -Raw $configPath
$env:CODEX_SANDBOX_NETWORK_DISABLED = '1'
$env:CODEX_THREAD_ID = 'nested-verification'
foreach ($probe in @('--help', 'verify the gateway')) {
  $encoded = & node ($GuardPath + '.handoff.cjs') --direct (Join-Path $env:CODEX_HOME 'codex') --output-base64 exec $probe
  if ($LASTEXITCODE -ne 0) { throw 'Nested verification could not reuse the prepared catalog' }
  $catalogOverride = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$encoded))
  if ($catalogOverride -notlike 'model_catalog_json=*archestra-direct-model-catalog.json*') { throw 'Nested verification lost the direct catalog override' }
}
if ((Get-Content -Raw $configPath) -cne $beforeProbe) { throw 'Nested verification changed the configuration' }
if ($env:CODEX_SANDBOX_NETWORK_DISABLED -ne '1') { throw 'Nested verification removed the sandbox restriction' }
Remove-Item Env:CODEX_THREAD_ID
Remove-Item Env:CODEX_SANDBOX_NETWORK_DISABLED
function Invoke-ArchCodexLogoutIfOurs { }
${CODEX_GUARD_CLIENT.windows.renderProxyDisconnect({ appName: "Archestra", healthUrl: null, mcp: null, skills: null, proxy: { provider: "openai", providerLabel: "OpenAI", ref: "proxy", proxyName: "llm_proxy", url: "https://example.com/v1/openai" } })}
Disconnect-ArchProxy
`,
        );
        await execFileAsync(
          "pwsh",
          ["-NoProfile", "-NonInteractive", "-File", script],
          { env },
        );
        expect(parseToml(await readFile(config, "utf8"))).toEqual({
          model: "model-a",
          model_provider: "openai",
          web_search: "live",
          features: { code_mode_host: true },
          ...(keepMcp
            ? { mcp_servers: { gateway: { url: "https://example.com/mcp" } } }
            : {}),
        });
        await expect(
          readFile(path.join(home, "archestra-direct-model-catalog.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await execFileAsync(
          process.execPath,
          [helper, "--install-direct", cli],
          { env },
        );
        expect(parseToml(await readFile(config, "utf8")).features).toEqual({
          code_mode_host: false,
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    test.each([
      { clientId: "claude-code" as const, binary: "claude" },
      { clientId: "codex" as const, binary: "codex" },
      { clientId: "copilot-cli" as const, binary: "copilot" },
    ])("$clientId: failed registration preserves the active guard, and retry reinstalls without duplicate hooks", async ({
      clientId,
      binary,
    }) => {
      const root = await mkdtemp(path.join(tmpdir(), "archestra-powershell-"));
      const home = path.join(root, "home");
      const bin = path.join(root, "bin");
      const callsPath = path.join(root, "calls.jsonl");
      const setupPath = path.join(root, "setup.ps1");
      const driverPath = path.join(root, "driver.ps1");
      const guard = STARTUP_GUARD_INSTALL[clientId];
      const healthRequests: string[] = [];
      const server = createServer((request, response) => {
        healthRequests.push(request.url ?? "");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ mcp: "ok", llm: "ok" }));
      });
      try {
        await Promise.all([home, bin].map((directory) => mkdir(directory)));
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing HTTP port");
        const executable = path.join(bin, binary);
        await writeFile(
          executable,
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ARCHESTRA_TEST_COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "debug") {
  process.stdout.write(JSON.stringify({models:[{slug:'selected',tool_mode:'code_mode_only',supports_search_tool:true},{slug:'other',tool_mode:null}]}));
  process.exit(0);
}
if (args[0] === "app-server") {
  require("node:readline").createInterface({input:process.stdin}).on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "initialize") console.log(JSON.stringify({id:request.id,result:{}}));
    if (request.method === "config/read") console.log(JSON.stringify({id:request.id,result:{config:{developer_instructions:"Keep existing guidance."}}}));
  });
} else {
  if (args[0] !== "mcp") process.exit(Number(process.env.ARCHESTRA_TEST_CLIENT_EXIT || 23));
  if (args[1] === "remove") process.exit(1);
  process.exit(args[1] === "add" && process.env.ARCHESTRA_TEST_FAIL_ADD === "1" ? 42 : 0);
}
`,
        );
        await chmod(executable, 0o755);
        await writeFile(
          setupPath,
          renderSetupScript({
            clientId,
            platform: "windows",
            appName: "Archestra",
            mcp: {
              serverName: "test_gateway",
              toolPrefix: "archestra__",
              url: `http://127.0.0.1:${address.port}/v1/mcp/test-gateway`,
            },
            proxy: null,
            skills: null,
            runtimeHandoffInstructions:
              clientId === "codex"
                ? DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS
                : null,
          }),
        );
        await writeFile(
          driverPath,
          `
$ErrorActionPreference = 'Stop'
$setup = Get-Content -Raw $env:ARCHESTRA_TEST_SETUP_PATH
$profilePath = $PROFILE.CurrentUserAllHosts
$guardPath = Join-Path $env:USERPROFILE '${guard.psScriptRelpath}'
$null = New-Item -ItemType Directory -Force (Split-Path $profilePath -Parent)
Set-Content $profilePath '# unrelated profile setting'
$originalProfile = Get-Content -Raw $profilePath
$env:ARCHESTRA_TEST_FAIL_ADD = '1'
$failed = $false
try { Invoke-Expression $setup } catch {
  if ($_.Exception.Message -notlike '*Could not register the MCP gateway*') { throw }
  $failed = $true
}
if (-not $failed) { throw 'Initial registration unexpectedly succeeded' }
if (Get-Item Function:${binary} -ErrorAction SilentlyContinue) { throw 'Failed first install created a wrapper' }
if (Test-Path $guardPath) { throw 'Failed first install created a guard' }
if ((Get-Content -Raw $profilePath) -cne $originalProfile) { throw 'Failed first install changed the profile' }
$env:ARCHESTRA_TEST_FAIL_ADD = '0'
Invoke-Expression $setup
if ('${clientId}' -eq 'codex' -and -not (Test-Path ($guardPath + '.verify.ps1'))) { throw 'Native verification script was not installed' }
$invokeArgs = @('invoke', 'two words', '', 'single''quote', '$HOME', '*')
foreach ($attempt in 1..2) {
  $priorFunction = (Get-Item Function:${binary}).ScriptBlock
  $priorProfile = Get-Content -Raw $profilePath
  $priorGuard = Get-Content -Raw $guardPath
  if ('${clientId}' -eq 'codex') { $priorVerifier = Get-Content -Raw ($guardPath + '.verify.ps1') }
  $env:ARCHESTRA_TEST_FAIL_ADD = '1'
  $failed = $false
  try { Invoke-Expression $setup } catch {
    if ($_.Exception.Message -notlike '*Could not register the MCP gateway*') { throw }
    $failed = $true
  }
  if (-not $failed) { throw 'Re-registration unexpectedly succeeded' }
  $restoredFunction = Get-Item Function:${binary} -ErrorAction SilentlyContinue
  if (-not $restoredFunction -or $restoredFunction.ScriptBlock.ToString() -cne $priorFunction.ToString()) { throw 'Loaded wrapper was not restored' }
  if ((Get-Content -Raw $profilePath) -cne $priorProfile) { throw 'Failed reconnect changed the profile' }
  if ((Get-Content -Raw $guardPath) -cne $priorGuard) { throw 'Failed reconnect changed the guard' }
  if ('${clientId}' -eq 'codex' -and (Get-Content -Raw ($guardPath + '.verify.ps1')) -cne $priorVerifier) { throw 'Failed reconnect changed the verifier' }
  ${binary} @invokeArgs
  if ($LASTEXITCODE -ne ${clientId === "codex" ? 125 : 23}) { throw 'Restored wrapper lost client exit status' }
  $env:ARCHESTRA_TEST_FAIL_ADD = '0'
  Invoke-Expression $setup
  if (-not (Get-Item Function:${binary} -ErrorAction SilentlyContinue)) { throw 'Retry did not activate the wrapper' }
  $profileText = Get-Content -Raw $profilePath
  if ([regex]::Matches($profileText, [regex]::Escape('${guard.markerStart}')).Count -ne 1) { throw 'Retry duplicated the profile hook' }
  if (-not $profileText.Contains('# unrelated profile setting')) { throw 'Retry lost unrelated profile settings' }
  ${binary} @invokeArgs
  if ($LASTEXITCODE -ne ${clientId === "codex" ? 125 : 23}) { throw 'Reinstalled wrapper lost client exit status' }
}
if ('${clientId}' -eq 'codex') {
  Remove-Item ($guardPath + '.handoff.cjs') -Force
  ${binary} @invokeArgs
  if ($LASTEXITCODE -ne 125) { throw 'Missing helper blocked the client' }
}
exit 0
`,
        );
        await execFileAsync(
          "pwsh",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driverPath],
          {
            cwd: home,
            env: {
              HOME: home,
              USERPROFILE: home,
              CLAUDE_CONFIG_DIR: "",
              CODEX_HOME: path.join(home, "custom codex"),
              PATH: `${bin}:${process.env.PATH}`,
              NO_COLOR: "1",
              ARCHESTRA_TEST_COMMAND_LOG: callsPath,
              ARCHESTRA_TEST_SETUP_PATH: setupPath,
              ARCHESTRA_TEST_CLIENT_EXIT: clientId === "codex" ? "125" : "23",
            },
            timeout: 30_000,
          },
        );
        const calls: string[][] = (await readFile(callsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const originalArgs = [
          "invoke",
          "two words",
          "",
          "single'quote",
          "$HOME",
          "*",
        ];
        expect(calls.filter((args) => args.includes("invoke"))).toEqual([
          ...Array.from({ length: 4 }, () => [
            ...(clientId === "codex"
              ? [
                  "-c",
                  `developer_instructions=${JSON.stringify(`Keep existing guidance.\n\n${DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS}`)}`,
                ]
              : []),
            ...originalArgs,
          ]),
          ...(clientId === "codex" ? [originalArgs] : []),
        ]);
        expect(
          calls.filter((args) => args[0] === "mcp" && args[1] === "add"),
        ).toHaveLength(6);
        expect(healthRequests).toHaveLength(clientId === "codex" ? 5 : 4);
        expect(
          healthRequests.every((url) => url === "/v1/health?mcp=test-gateway"),
        ).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

type ClaudeSettings = {
  env: Record<string, unknown>;
  permissions?: { allow: string[] };
};

function claudeProxy(params: {
  provider: "anthropic" | "bedrock";
  virtualKey?: string;
}): SetupScriptProxySection {
  return {
    authMode: params.virtualKey ? "virtual-key" : "provider-key",
    provider: params.provider,
    providerLabel: params.provider,
    baseUrl: "https://proxy.example.com/v1",
    url: `https://proxy.example.com/v1/${params.provider}`,
    proxyName: "default_proxy",
    virtualKey: params.virtualKey ?? null,
    virtualKeyName: null,
    passthroughVirtualKey: params.virtualKey ? null : "arch_passthrough",
    model: null,
  };
}

async function runClaudeProxySetups(params: {
  existing: ClaudeSettings;
  proxies: SetupScriptProxySection[];
}): Promise<{ snapshots: ClaudeSettings[]; backup: ClaudeSettings }> {
  const root = await mkdtemp(
    path.join(tmpdir(), "archestra-proxy-powershell-"),
  );
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const settingsPath = path.join(home, ".claude", "settings.json");
  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, "claude"), 0o755);
    await writeFile(settingsPath, JSON.stringify(params.existing));
    for (const [index, proxy] of params.proxies.entries()) {
      await writeFile(
        path.join(root, `setup-${index}.ps1`),
        renderSetupScript({
          clientId: "claude-code",
          platform: "windows",
          appName: "Archestra",
          mcp: null,
          proxy,
          skills: null,
        }),
      );
    }
    const driverPath = path.join(root, "driver.ps1");
    await writeFile(
      driverPath,
      `$ErrorActionPreference = 'Stop'
foreach ($index in 0..${params.proxies.length - 1}) {
  Invoke-Expression (Get-Content -Raw (Join-Path $env:ARCHESTRA_TEST_ROOT ('setup-' + $index + '.ps1')))
  Copy-Item (Join-Path $env:USERPROFILE '.claude/settings.json') (Join-Path $env:ARCHESTRA_TEST_ROOT ('snapshot-' + $index + '.json'))
}
`,
    );
    await execFileAsync(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driverPath],
      {
        cwd: home,
        env: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          PATH: `${bin}:${process.env.PATH}`,
          NO_COLOR: "1",
          ARCHESTRA_TEST_ROOT: root,
        },
        timeout: 30_000,
      },
    );
    const snapshots = await Promise.all(
      params.proxies.map(async (_, index) =>
        JSON.parse(
          await readFile(path.join(root, `snapshot-${index}.json`), "utf8"),
        ),
      ),
    );
    const backup = JSON.parse(
      await readFile(`${settingsPath}.archestra-backup`, "utf8"),
    );
    return { snapshots, backup };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
