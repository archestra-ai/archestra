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
import { CODEX_GUARD_CLIENT } from "./guard/clients";
import { inSingleQuotedHereString } from "./guard/startup-guard.windows";
import { renderSetupScript } from "./index";
import { CODEX_HANDOFF_HELPER } from "./payloads/codex-handoff";
import type { SetupScriptContext, SetupScriptProxySection } from "./types";

const execFileAsync = promisify(execFile);
const powershellAvailable =
  process.platform !== "win32" &&
  spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

if (
  process.env.CI === "true" &&
  process.platform !== "win32" &&
  !powershellAvailable
) {
  throw new Error("CI requires a working PowerShell runtime for these tests");
}

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
$invokeArgs = @('invoke', 'two words', '', 'single''quote', '$HOME', '*')
foreach ($attempt in 1..2) {
  $priorFunction = (Get-Item Function:${binary}).ScriptBlock
  $priorProfile = Get-Content -Raw $profilePath
  $priorGuard = Get-Content -Raw $guardPath
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
              CODEX_HOME: path.join(root, "custom codex"),
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

describe.skipIf(!powershellAvailable)(
  "PowerShell Codex gateway registration",
  () => {
    test("approves the guardrail helpers once, under the gateway's own entry", async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "archestra-codex-approvals-powershell-"),
      );
      const home = path.join(root, "home");
      const bin = path.join(root, "bin");
      const codexHome = path.join(home, ".codex");
      const setupPath = path.join(root, "setup.ps1");
      const driverPath = path.join(root, "driver.ps1");
      const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ mcp: "ok", llm: "ok" }));
      });
      try {
        await Promise.all(
          [bin, codexHome].map((dir) => mkdir(dir, { recursive: true })),
        );
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing HTTP port");
        const mcp = {
          serverName: "test_gateway",
          toolPrefix: "archestra__",
          url: `http://127.0.0.1:${address.port}/v1/mcp/test-gateway`,
        };
        // A config the person already had: it stays as it is.
        await writeFile(
          path.join(codexHome, "config.toml"),
          'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\n',
        );
        // Edits config.toml the way the real `codex mcp add` and `remove` do:
        // add appends the server's table, remove drops it with its sub-tables.
        await writeFile(
          path.join(bin, "codex"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const [command, action, name, , url] = process.argv.slice(2);
const file = path.join(process.env.USERPROFILE, ".codex", "config.toml");
if (command === "mcp" && action === "remove") {
  let skip = false;
  const kept = fs.readFileSync(file, "utf8").split(/\\r?\\n/).filter((line) => {
    if (line.startsWith("[")) skip = line === "[mcp_servers." + name + "]" || line.startsWith("[mcp_servers." + name + ".") || line.startsWith('[mcp_servers."' + name + '".');
    return !skip;
  });
  fs.writeFileSync(file, kept.join("\\n"));
} else if (command === "mcp" && action === "add") {
  fs.appendFileSync(file, "\\n[mcp_servers." + name + "]\\nurl = " + JSON.stringify(url) + "\\n");
} else if (command === "debug") {
  process.stdout.write(JSON.stringify({ models: [] }));
}
`,
        );
        await chmod(path.join(bin, "codex"), 0o755);
        await writeFile(
          setupPath,
          renderSetupScript({
            clientId: "codex",
            platform: "windows",
            appName: "Archestra",
            mcp,
            proxy: null,
            skills: null,
          }),
        );
        // A rerun of setup must not define the tables twice.
        await writeFile(
          driverPath,
          `$ErrorActionPreference = 'Stop'
$setup = Get-Content -Raw $env:ARCHESTRA_TEST_SETUP_PATH
Invoke-Expression $setup
Invoke-Expression $setup
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
              PATH: `${bin}:${process.env.PATH}`,
              NO_COLOR: "1",
              ARCHESTRA_TEST_SETUP_PATH: setupPath,
            },
            timeout: 30_000,
          },
        );

        const config = parseToml(
          await readFile(path.join(codexHome, "config.toml"), "utf8"),
        ) as {
          model: string;
          mcp_servers: Record<
            string,
            { url: string; tools?: Record<string, { approval_mode: string }> }
          >;
        };
        expect(config.model).toBe("gpt-5");
        expect(config.mcp_servers.docs).toEqual({
          url: "https://docs.example.com/mcp",
        });
        expect(config.mcp_servers[mcp.serverName]).toEqual({
          url: mcp.url,
          // The tool runner and other gateway tools keep Codex's question.
          tools: Object.fromEntries(
            [
              "get_remedy_plans",
              "execute_remedy_plan",
              "list_peer_messages",
              "read_peer_message",
              "yell",
              "ask_user",
            ].map((name) => [
              `${mcp.toolPrefix}${name}`,
              { approval_mode: "approve" },
            ]),
          ),
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(!powershellAvailable)("PowerShell setup script syntax", () => {
  test("every rendered Windows setup script parses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-ps-parse-"));
    try {
      const variants = windowsSetupVariants();
      const names: string[] = [];
      for (const [index, variant] of variants.entries()) {
        names.push(variant.name);
        await writeFile(
          path.join(root, `${index}.ps1`),
          renderSetupScript(variant.ctx),
        );
      }
      const driverPath = path.join(root, "parse.ps1");
      await writeFile(
        driverPath,
        `$out = @{}
foreach ($f in Get-ChildItem -Path $env:ARCHESTRA_TEST_ROOT -Filter '*.ps1' | Where-Object Name -ne 'parse.ps1') {
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { $out[$f.BaseName] = ('line ' + $errors[0].Extent.StartLineNumber + ': ' + $errors[0].Message) }
}
$out | ConvertTo-Json -Compress
`,
      );
      const { stdout } = await execFileAsync(
        "pwsh",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driverPath],
        {
          env: { ...process.env, ARCHESTRA_TEST_ROOT: root },
          timeout: 120_000,
        },
      );
      const raw: Record<string, string> = JSON.parse(stdout.trim() || "{}");
      const failures = Object.entries(raw).map(
        ([index, error]) => `${names[Number(index)]}: ${error}`,
      );
      expect(failures).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("Windows startup guard here-strings", () => {
  test("embedding content with a line starting with '@ fails instead of ending the here-string early", () => {
    expect(() =>
      inSingleQuotedHereString("Write-Host 1\n'@\nWrite-Host 2"),
    ).toThrow("here-string");
    expect(inSingleQuotedHereString("Write-Host 'a@b'")).toBe(
      "Write-Host 'a@b'",
    );
  });
});

function windowsSetupVariants(): Array<{
  name: string;
  ctx: SetupScriptContext;
}> {
  const proxy = (
    provider: "anthropic" | "openai",
    authMode: "provider-key" | "virtual-key" | "primary-providers",
    primaryProviders?: SetupScriptProxySection["primaryProviders"],
  ): SetupScriptProxySection => ({
    authMode,
    provider,
    providerLabel: provider,
    baseUrl: "https://proxy.example.com/v1",
    url: `https://proxy.example.com/v1/${provider}`,
    proxyName: "default_proxy",
    virtualKey: authMode === "provider-key" ? null : "arch_test",
    virtualKeyName: authMode === "provider-key" ? null : "Setup",
    passthroughVirtualKey: authMode === "provider-key" ? "arch_pass" : null,
    model: null,
    ...(primaryProviders ? { primaryProviders } : {}),
  });
  const catalog = [
    {
      provider: "anthropic" as const,
      name: "Anthropic",
      models: [
        { id: "claude-test", name: "Claude", context: 200000, output: null },
      ],
    },
  ];
  const variants: Array<{ name: string; ctx: SetupScriptContext }> = [];
  for (const clientId of [
    "claude-code",
    "codex",
    "copilot-cli",
    "cursor",
    "opencode",
  ] as const) {
    const provider = clientId === "claude-code" ? "anthropic" : "openai";
    const proxies: Array<[string, SetupScriptProxySection | null]> = [
      ["no-proxy", null],
      ["provider-key", proxy(provider, "provider-key")],
      ["virtual-key", proxy(provider, "virtual-key")],
      ...(clientId === "opencode"
        ? ([
            ["virtual-key-catalog", proxy("openai", "virtual-key", catalog)],
            [
              "primary-providers",
              proxy("anthropic", "primary-providers", catalog),
            ],
          ] as Array<[string, SetupScriptProxySection]>)
        : []),
    ];
    for (const [proxyName, proxySection] of proxies) {
      for (const mcp of [true, false]) {
        for (const skills of [true, false]) {
          for (const handoff of [true, false]) {
            variants.push({
              name: `${clientId} proxy=${proxyName} mcp=${mcp} skills=${skills} handoff=${handoff}`,
              ctx: {
                clientId,
                platform: "windows",
                appName: "Archestra",
                mcp: mcp
                  ? {
                      serverName: "prod_gateway",
                      toolPrefix: "archestra__",
                      url: "https://proxy.example.com/v1/mcp/gw",
                    }
                  : null,
                proxy: proxySection,
                skills: skills
                  ? {
                      cloneUrl: "https://proxy.example.com/skills/repo.git",
                      marketplaceName: "acme-skills",
                    }
                  : null,
                runtimeHandoffInstructions: handoff
                  ? DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS
                  : null,
              },
            });
          }
        }
      }
    }
  }
  return variants;
}

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
