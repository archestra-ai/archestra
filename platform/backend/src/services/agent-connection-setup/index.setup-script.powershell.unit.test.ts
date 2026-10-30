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
  defaultRuntimeHandoffInstructions,
  STARTUP_GUARD_INSTALL,
} from "@archestra/shared/consts";
import { parse as parseToml } from "smol-toml";
import { describe, expect, test } from "vitest";
import { CODEX_GUARD_CLIENT } from "./guard/clients";
import { inSingleQuotedHereString } from "./guard/startup-guard.windows";
import { renderSetupScript } from "./index";
import { CODEX_HANDOFF_HELPER } from "./payloads/codex-handoff";
import {
  SETUP_STOPPED_EXIT_CODE,
  type SetupScriptContext,
  type SetupScriptProxySection,
} from "./types";

const execFileAsync = promisify(execFile);

const CODEX_CONFIG_WITH_TRAILING_TABLE = `model = "gpt-5"

[mcp_servers.docs]
url = "https://docs.example.com/mcp"

[model_providers.custom_proxy]
name = "custom_proxy"
base_url = "http://127.0.0.1:9/v1"

[notice]
hide_full_access_warning = true

[features]
shell_tool = true
`;

function codexMcpStub(homeEnv: "HOME" | "USERPROFILE"): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const [command, action, name, , url] = process.argv.slice(2);
const file = path.join(process.env.${homeEnv}, ".codex", "config.toml");
function header(server) {
  if (/^[A-Za-z0-9_-]+$/.test(server)) return "[mcp_servers." + server + "]";
  return '[mcp_servers."' + server + '"]';
}
function serverBlock(line, server) {
  const own = header(server);
  return line === own || line.startsWith("[mcp_servers." + server + ".") || line.startsWith('[mcp_servers."' + server + '".');
}
if (command === "mcp" && action === "remove") {
  let skip = false;
  const kept = fs.readFileSync(file, "utf8").split(/\\r?\\n/).filter((line) => {
    if (line.startsWith("[")) skip = serverBlock(line, name);
    return !skip;
  });
  fs.writeFileSync(file, kept.filter((line, index, all) => line !== "" || index !== all.length - 1).join("\\n") + "\\n");
} else if (command === "mcp" && action === "add") {
  const lines = fs.readFileSync(file, "utf8").split(/\\r?\\n/);
  if (lines.at(-1) === "") lines.pop();
  let insertAt = lines.length;
  let seen = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("[mcp_servers.")) seen = true;
    else if (seen && lines[i].startsWith("[")) { insertAt = i; break; }
  }
  lines.splice(insertAt, 0, "", header(name), "url = " + JSON.stringify(url));
  fs.writeFileSync(file, lines.join("\\n") + "\\n");
} else if (command === "debug") {
  process.stdout.write(JSON.stringify({ models: [] }));
}
`;
}
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
  if (args[1] === "add" && process.env.ARCHESTRA_TEST_FAIL_ADD === "1") process.exit(42);
  if (args[1] === "add") {
    const path = require("node:path");
    const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE, ".codex");
    const file = path.join(home, "config.toml");
    const header = "[mcp_servers." + args[2] + "]";
    fs.mkdirSync(home, { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (!current.split(/\\r?\\n/).includes(header)) {
      fs.appendFileSync(file, (current.endsWith("\\n") || current === "" ? "" : "\\n") + header + "\\nurl = " + JSON.stringify(args[4] || "") + "\\n");
    }
  }
  process.exit(0);
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
                ? defaultRuntimeHandoffInstructions("Archestra")
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
                  `developer_instructions=${JSON.stringify(`Keep existing guidance.\n\n${defaultRuntimeHandoffInstructions("Archestra")}`)}`,
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
  "PowerShell managed instructions source file",
  () => {
    test("a reconnect locks the source file again without admin rights, and writes the token only after the lock", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "archestra-acl-"));
      const home = path.join(root, "home");
      const bin = path.join(root, "bin");
      const setupPath = path.join(root, "setup.ps1");
      const driverPath = path.join(root, "driver.ps1");
      const source = `${STARTUP_GUARD_INSTALL["claude-code"].psScriptRelpath}.instructions-source.json`;
      try {
        await Promise.all([home, bin].map((directory) => mkdir(directory)));
        await writeFile(
          path.join(bin, "claude"),
          '#!/bin/sh\n[ "$1 $2" = "mcp remove" ] && exit 1\nexit 0\n',
        );
        await chmod(path.join(bin, "claude"), 0o755);
        const script = renderSetupScript({
          clientId: "claude-code",
          platform: "windows",
          appName: "Archestra",
          mcp: {
            serverName: "test_gateway",
            toolPrefix: "archestra__",
            url: "https://proxy.example.com/v1/mcp/test-gateway",
          },
          proxy: null,
          skills: null,
          managedInstructionsSource: {
            url: "https://proxy.example.com/api/connection-instructions",
            token: "instructions-token",
          },
        });
        const identity =
          "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name";
        expect(script).toContain(identity);
        await writeFile(setupPath, script.replaceAll(identity, "'test-user'"));
        // Linux has no Windows ACL APIs, so the driver fakes them. Owner-only
        // file mode stands in for the owner-only ACL. The fake Set-Acl follows
        // the Windows rule behind the bug: a non-admin user cannot set an ACL
        // again on a file that already has it.
        await writeFile(
          driverPath,
          `$ErrorActionPreference = 'Stop'
$locked = [IO.UnixFileMode]'UserRead, UserWrite'
function global:New-Object {
  param([Parameter(Position = 0)][string]$TypeName, [Parameter(Position = 1)][object[]]$ArgumentList)
  if ($TypeName -like 'System.Security.AccessControl.*') {
    $acl = [pscustomobject]@{}
    $acl | Add-Member -MemberType ScriptMethod -Name SetAccessRuleProtection -Value { }
    $acl | Add-Member -MemberType ScriptMethod -Name AddAccessRule -Value { }
    return $acl
  }
  if ($PSBoundParameters.ContainsKey('ArgumentList')) { return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList }
  Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName
}
function global:Set-Acl {
  param([string]$LiteralPath, $AclObject)
  if ([IO.File]::GetUnixFileMode($LiteralPath) -eq $locked) { throw "The process does not possess the 'SeSecurityPrivilege' privilege" }
  if ((Get-Item -LiteralPath $LiteralPath).Length -ne 0) { throw 'The file had content before it was locked' }
  [IO.File]::SetUnixFileMode($LiteralPath, $locked)
}
$setup = Get-Content -Raw $env:ARCHESTRA_TEST_SETUP_PATH
$source = Join-Path $env:USERPROFILE '${source}'
foreach ($attempt in 1..2) {
  Invoke-Expression $setup
  if ([IO.File]::GetUnixFileMode($source) -ne $locked) { throw "Connect $attempt left the source file unlocked" }
  if ((Get-Content -Raw $source | ConvertFrom-Json).token -ne 'instructions-token') { throw "Connect $attempt did not write the token" }
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
              PATH: `${bin}:${process.env.PATH}`,
              NO_COLOR: "1",
              ARCHESTRA_TEST_SETUP_PATH: setupPath,
            },
            timeout: 30_000,
          },
        );
      } finally {
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
        await writeFile(
          path.join(codexHome, "config.toml"),
          CODEX_CONFIG_WITH_TRAILING_TABLE,
        );
        await writeFile(path.join(bin, "codex"), codexMcpStub("USERPROFILE"));
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

        const configPath = path.join(codexHome, "config.toml");
        const raw = await readFile(configPath, "utf8");
        expect(raw.match(/^required = true$/gm)).toEqual(["required = true"]);
        const config = parseToml(raw) as {
          model: string;
          mcp_servers: Record<
            string,
            {
              url: string;
              required?: boolean;
              tools?: Record<string, { approval_mode: string }>;
            }
          >;
          model_providers: Record<string, { name: string; base_url: string }>;
          notice: { hide_full_access_warning: boolean };
          features: { shell_tool: boolean };
        };
        expect(config.model).toBe("gpt-5");
        expect(config.mcp_servers.docs).toEqual({
          url: "https://docs.example.com/mcp",
        });
        expect(config.model_providers).toEqual({
          custom_proxy: {
            name: "custom_proxy",
            base_url: "http://127.0.0.1:9/v1",
          },
        });
        expect(config.notice).toEqual({ hide_full_access_warning: true });
        expect(config.features).toEqual({ shell_tool: true });
        expect(raw.indexOf("required = true")).toBeGreaterThan(
          raw.indexOf(`[mcp_servers.${mcp.serverName}]`),
        );
        expect(raw.indexOf("required = true")).toBeLessThan(
          raw.indexOf("[model_providers.custom_proxy]"),
        );
        expect(config.mcp_servers[mcp.serverName]).toEqual({
          url: mcp.url,
          required: true,
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
        await execFileAsync(
          path.join(bin, "codex"),
          ["mcp", "remove", mcp.serverName],
          { env: { USERPROFILE: home, PATH: `${bin}:${process.env.PATH}` } },
        );
        const removed = await readFile(configPath, "utf8");
        expect(removed).not.toContain("required = true");
        expect(removed).not.toContain(`[mcp_servers.${mcp.serverName}]`);
        expect(removed).toContain("[mcp_servers.docs]");
        expect(removed).toContain("[model_providers.custom_proxy]");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });

    test.each([
      "my-gateway",
      "gw.with.dots",
    ])("writes required inside the inserted %s table, preserving case-distinct servers and trailing tables", async (serverName) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "archestra-codex-required-powershell-"),
      );
      const home = path.join(root, "home");
      const bin = path.join(root, "bin");
      const codexHome = path.join(home, ".codex");
      const setupPath = path.join(root, "setup.ps1");
      const driverPath = path.join(root, "driver.ps1");
      const otherServerName = serverName.toUpperCase();
      const otherHeader = /^[A-Za-z0-9_-]+$/.test(otherServerName)
        ? `[mcp_servers.${otherServerName}]`
        : `[mcp_servers."${otherServerName}"]`;
      const otherServer = { url: "https://other.example.com/mcp" };
      try {
        await Promise.all(
          [bin, codexHome].map((dir) => mkdir(dir, { recursive: true })),
        );
        await writeFile(
          path.join(codexHome, "config.toml"),
          CODEX_CONFIG_WITH_TRAILING_TABLE.replace(
            "[mcp_servers.docs]",
            `${otherHeader}\nurl = "${otherServer.url}"\n\n[mcp_servers.docs]`,
          ),
        );
        await writeFile(path.join(bin, "codex"), codexMcpStub("USERPROFILE"));
        await chmod(path.join(bin, "codex"), 0o755);
        await writeFile(
          setupPath,
          renderSetupScript({
            clientId: "codex",
            platform: "windows",
            appName: "Archestra",
            mcp: {
              serverName,
              toolPrefix: "archestra__",
              url: "https://archestra.example.com/v1/mcp/named",
            },
            proxy: null,
            skills: null,
          }),
        );
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
        const raw = await readFile(path.join(codexHome, "config.toml"), "utf8");
        const header = /^[A-Za-z0-9_-]+$/.test(serverName)
          ? `[mcp_servers.${serverName}]`
          : `[mcp_servers."${serverName}"]`;
        expect(raw.match(/^required = true$/gm)).toEqual(["required = true"]);
        expect(raw.indexOf("required = true")).toBeGreaterThan(
          raw.indexOf(header),
        );
        expect(raw.indexOf("required = true")).toBeLessThan(
          raw.indexOf("[model_providers.custom_proxy]"),
        );
        const config = parseToml(raw) as {
          mcp_servers: Record<string, { required?: boolean }>;
          model_providers: Record<string, { required?: boolean }>;
          features: { required?: boolean };
        };
        expect(config.mcp_servers[serverName]?.required).toBe(true);
        expect(config.mcp_servers[otherServerName]).toEqual(otherServer);
        expect(config.model_providers.custom_proxy.required).toBeUndefined();
        expect(config.features.required).toBeUndefined();
        await execFileAsync(
          path.join(bin, "codex"),
          ["mcp", "remove", serverName],
          { env: { USERPROFILE: home, PATH: `${bin}:${process.env.PATH}` } },
        );
        const removed = await readFile(
          path.join(codexHome, "config.toml"),
          "utf8",
        );
        expect(removed).not.toContain("required = true");
        expect(removed).not.toContain(header);
        expect(parseToml(removed)).toMatchObject({
          mcp_servers: { [otherServerName]: otherServer },
        });
        expect(removed).toContain("[model_providers.custom_proxy]");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("aborts when Codex did not write the expected gateway entry", async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "archestra-codex-required-miss-powershell-"),
      );
      const home = path.join(root, "home");
      const bin = path.join(root, "bin");
      const codexHome = path.join(home, ".codex");
      const setupPath = path.join(root, "setup.ps1");
      const driverPath = path.join(root, "driver.ps1");
      try {
        await Promise.all(
          [bin, codexHome].map((dir) => mkdir(dir, { recursive: true })),
        );
        await writeFile(
          path.join(codexHome, "config.toml"),
          CODEX_CONFIG_WITH_TRAILING_TABLE,
        );
        await writeFile(
          path.join(bin, "codex"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const [command, action] = process.argv.slice(2);
const file = path.join(process.env.USERPROFILE, ".codex", "config.toml");
if (command === "mcp" && action === "add") {
  fs.appendFileSync(file, "\\n[mcp_servers.not_the_gateway]\\nurl = \\"http://127.0.0.1:9/mcp\\"\\n");
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
            mcp: {
              serverName: "test_gateway",
              toolPrefix: "archestra__",
              url: "https://archestra.example.com/v1/mcp/test-gateway",
            },
            proxy: null,
            skills: null,
          }),
        );
        await writeFile(
          driverPath,
          `$ErrorActionPreference = 'Stop'
$setup = Get-Content -Raw $env:ARCHESTRA_TEST_SETUP_PATH
Invoke-Expression $setup
exit 0
`,
        );
        await expect(
          execFileAsync(
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
          ),
        ).rejects.toThrow(/Could not mark the gateway required/);
        const raw = await readFile(path.join(codexHome, "config.toml"), "utf8");
        expect(raw).not.toContain("required = true");
        expect(raw).toContain("shell_tool = true");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("a rerun replaces the marketplace an earlier setup registered from another clone URL", async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "archestra-codex-marketplace-powershell-"),
      );
      const home = path.join(root, "home");
      const bin = path.join(root, "bin");
      const setupPath = path.join(root, "setup.ps1");
      const source = path.join(home, "marketplace-source");
      const skills = {
        cloneUrl: "https://token:new-token@example.com/skills/repo.git",
        marketplaceName: "test-skills",
        hasSkills: true,
        pluginNames: [],
      };
      try {
        await Promise.all(
          [bin, path.join(home, ".codex")].map((dir) =>
            mkdir(dir, { recursive: true }),
          ),
        );
        // Every setup gets a new credential in its clone URL.
        await writeFile(
          source,
          "https://old-token@example.com/skills/repo.git",
        );
        // Codex 0.162 keeps one source per marketplace name and refuses another one.
        await writeFile(
          path.join(bin, "codex"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const [command, group, action, value] = process.argv.slice(2);
const source = ${JSON.stringify(source)};
if (command === "plugin" && group === "marketplace" && action === "remove") {
  if (!fs.existsSync(source)) { console.error("Error: marketplace \`" + value + "\` is not configured or installed"); process.exit(1); }
  fs.rmSync(source);
} else if (command === "plugin" && group === "marketplace" && action === "add") {
  if (fs.existsSync(source) && fs.readFileSync(source, "utf8") !== value) {
    console.error("Error: marketplace 'test-skills' is already added from a different source; remove it before adding this source");
    process.exit(1);
  }
  fs.writeFileSync(source, value);
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
            mcp: null,
            proxy: null,
            skills,
          }),
        );
        const { stdout } = await execFileAsync(
          "pwsh",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", setupPath],
          {
            cwd: home,
            env: {
              HOME: home,
              USERPROFILE: home,
              PATH: `${bin}:${process.env.PATH}`,
              NO_COLOR: "1",
            },
            timeout: 30_000,
          },
        );

        expect(stdout).not.toContain("Marketplace registration failed");
        expect(await readFile(source, "utf8")).toBe(skills.cloneUrl);
      } finally {
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

describe.skipIf(!powershellAvailable)(
  "PowerShell managed runtime stdin encoding",
  () => {
    test.each([
      0, 23,
    ])("preserves Unicode and restores session state after Node exits %s", async (exitCode) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "archestra-runtime-encoding-"),
      );
      const artifact = path.join(root, "artifact.txt");
      const content = "routing → café";
      const rendered = renderSetupScript({
        clientId: "opencode",
        platform: "windows",
        appName: "Archestra",
        mcp: {
          serverName: "gateway",
          toolPrefix: "archestra__",
          url: "https://example.com/v1/mcp/gateway",
        },
        proxy: null,
        skills: null,
        managedRuntimeSource: {
          url: "https://example.com/api/managed-runtime",
          token: "test-runtime-token",
          installation: "test-installation",
        },
      });
      const boundary = rendered.match(
        /\$archRuntimeInstall = @'\r?\n[\s\S]*?\r?\n'@([\s\S]*?if \(\$LASTEXITCODE -ne 0\) \{ throw 'Could not install managed launcher updates' \})/,
      );
      expect(boundary).not.toBeNull();
      const probe = `require("node:fs").writeFileSync(process.env.ARCHESTRA_TEST_ARTIFACT, ${JSON.stringify(content)}); process.exit(${exitCode});`;
      const driver = path.join(root, "driver.ps1");
      try {
        await writeFile(
          driver,
          `$ErrorActionPreference = 'Stop'
$originalEncoding = [System.Text.Encoding]::ASCII
$OutputEncoding = $originalEncoding
$env:ARCHESTRA_OC_RUNTIME_API_MAJOR = 'before-test'
$archOcMajor = 1
$archRuntimeInstall = @'
${probe}
'@
$failure = $null
try {
${boundary?.[1]}
} catch { $failure = $_.Exception.Message }
[pscustomobject]@{
  encodingRestored = [object]::ReferenceEquals($OutputEncoding, $originalEncoding)
  runtimeMajor = $env:ARCHESTRA_OC_RUNTIME_API_MAJOR
  failure = $failure
} | ConvertTo-Json -Compress
`,
        );
        const { stdout } = await execFileAsync(
          "pwsh",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driver],
          {
            env: {
              ...process.env,
              PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
              ARCHESTRA_TEST_ARTIFACT: artifact,
            },
            timeout: 30_000,
          },
        );
        expect(await readFile(artifact, "utf8")).toBe(content);
        expect(JSON.parse(stdout.trim())).toEqual({
          encodingRestored: true,
          runtimeMajor: "before-test",
          failure:
            exitCode === 0
              ? null
              : "Could not install managed launcher updates",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(!powershellAvailable)(
  "Windows PowerShell 5.1 native argument passing",
  () => {
    test("OpenCode primary-providers setup and its guard disconnect run when quotes in native arguments are dropped", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "archestra-oc-legacy-"));
      const home = path.join(root, "home");
      const bin = path.join(root, "bin");
      const configPath = path.join(
        home,
        ".config",
        "opencode",
        "opencode.json",
      );
      const existing = {
        model: "local/old",
        provider: { local: { name: "Local" } },
      };
      try {
        await mkdir(path.dirname(configPath), { recursive: true });
        await mkdir(bin);
        await writeFile(configPath, JSON.stringify(existing));
        const siblingPath = path.join(
          path.dirname(configPath),
          "opencode.jsonc",
        );
        await writeFile(
          siblingPath,
          JSON.stringify({
            mcp: {
              my_gateway: {
                type: "remote",
                url: "https://proxy.example.com/v1/mcp/gw",
                enabled: true,
              },
              prod_gateway: {
                type: "remote",
                url: "https://proxy.example.com/v1/mcp/gw",
                enabled: false,
                oauth: false,
                headers: { Authorization: "Bearer example-test-token" },
              },
            },
          }),
        );
        await writeFile(
          path.join(bin, "opencode"),
          '#!/bin/sh\n[ "$1" = --version ] && echo 1.18.32\nexit 0\n',
        );
        await chmod(path.join(bin, "opencode"), 0o755);
        await writeFile(
          path.join(root, "setup.ps1"),
          renderSetupScript({
            clientId: "opencode",
            platform: "windows",
            appName: "Archestra",
            mcp: {
              serverName: "prod_gateway",
              toolPrefix: "archestra__",
              url: "https://proxy.example.com/v1/mcp/gw",
            },
            proxy: {
              authMode: "primary-providers",
              provider: "anthropic",
              providerLabel: "Anthropic",
              baseUrl: "https://proxy.example.com/v1",
              url: "https://proxy.example.com/v1/anthropic",
              proxyName: "default_proxy",
              virtualKey: "arch_test",
              virtualKeyName: "Setup",
              passthroughVirtualKey: null,
              model: null,
              primaryProviders: [
                {
                  provider: "anthropic",
                  name: "Anthropic",
                  models: [
                    {
                      id: "claude-test",
                      name: "Claude",
                      context: 200000,
                      output: null,
                    },
                  ],
                },
              ],
            },
            skills: null,
          }),
        );
        // Legacy is how Windows PowerShell 5.1 passes arguments to native
        // commands: double quotes inside an argument do not reach the program.
        const driverPath = path.join(root, "driver.ps1");
        await writeFile(
          driverPath,
          `$PSNativeCommandArgumentPassing = 'Legacy'
& (Join-Path $env:ARCHESTRA_TEST_ROOT 'setup.ps1')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Copy-Item (Join-Path $env:USERPROFILE '.config/opencode/opencode.json') (Join-Path $env:ARCHESTRA_TEST_ROOT 'connected.json')
Copy-Item (Join-Path $env:USERPROFILE '.config/opencode/plugins/archestra-llm-proxy.js') (Join-Path $env:ARCHESTRA_TEST_ROOT 'connected-plugin.js')
$env:ARCHESTRA_GUARD_ACTION = 'disconnect'
& (Join-Path $env:USERPROFILE '.archestra/opencode-startup-guard.ps1')
exit $LASTEXITCODE
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
              XDG_CONFIG_HOME: "",
              PATH: `${bin}:${process.env.PATH}`,
              NO_COLOR: "1",
              ARCHESTRA_TEST_ROOT: root,
            },
            timeout: 60_000,
          },
        );
        const connected = JSON.parse(
          await readFile(path.join(root, "connected.json"), "utf8"),
        );
        // Connect adds no provider to the client's config; the plugin carries
        // the served models and the key file carries the credential.
        expect(
          Object.keys(connected.provider ?? {}).some((id) =>
            id.startsWith("archestra-"),
          ),
        ).toBe(false);
        expect(
          await readFile(path.join(root, "connected-plugin.js"), "utf8"),
        ).toContain('"anthropic":["claude-test"]');
        expect(
          JSON.parse(await readFile(siblingPath, "utf8")).mcp.my_gateway
            .enabled,
        ).toBe(false);
        expect(
          JSON.parse(await readFile(siblingPath, "utf8")).mcp.prod_gateway
            .enabled,
        ).toBe(false);
        expect(connected.mcp.prod_gateway.url).toBe(
          "https://proxy.example.com/v1/mcp/gw",
        );
        expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(
          existing,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 90_000);
  },
);

describe("Windows startup guard here-strings", () => {
  test("embedding content with a line starting with '@ fails instead of ending the here-string early", () => {
    expect(() =>
      inSingleQuotedHereString("Write-Host 1\n'@\nWrite-Host 2"),
    ).toThrow("here-string");
    expect(inSingleQuotedHereString("Write-Host 'a@b'")).toBe(
      "Write-Host 'a@b'",
    );
  });

  // Windows PowerShell 5.1 Select-String reports a missing -Path file even with
  // -ErrorAction SilentlyContinue, which pwsh cannot reproduce.
  test("every Select-String in a rendered Windows setup checks that its file exists first", () => {
    const unguarded: string[] = [];
    for (const { name, ctx } of windowsSetupVariants()) {
      for (const line of renderSetupScript(ctx).split("\n")) {
        for (const [, target] of line.matchAll(
          /Select-String -Path (\$\w+)/g,
        )) {
          if (!line.includes(`(Test-Path ${target}) -and`)) {
            unguarded.push(`${name}: ${line.trim()}`);
          }
        }
        if (/Select-String -Path [^$]/.test(line)) {
          unguarded.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect([...new Set(unguarded)]).toEqual([]);
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
    "kilo",
  ] as const) {
    const provider = clientId === "claude-code" ? "anthropic" : "openai";
    const proxies: Array<[string, SetupScriptProxySection | null]> = [
      ["no-proxy", null],
      ["provider-key", proxy(provider, "provider-key")],
      ["virtual-key", proxy(provider, "virtual-key")],
      ...(clientId === "opencode" || clientId === "kilo"
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
                  ? defaultRuntimeHandoffInstructions("Archestra")
                  : null,
                managedInstructionsSource: mcp
                  ? {
                      url: "https://proxy.example.com/api/connection-instructions",
                      token: "instructions-token",
                    }
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

describe.skipIf(!powershellAvailable)("PowerShell Codex preflight", () => {
  // Runs a rendered Codex setup script against a Codex that answers model
  // discovery from the bundled catalog, writes no cache and has no app-server,
  // like an offline or older Codex.
  async function runSetup(
    args: (script: string) => string[],
    { failPreflightNode = false } = {},
  ) {
    const root = await mkdtemp(
      path.join(tmpdir(), "archestra-codex-preflight-powershell-"),
    );
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const configPath = path.join(home, ".codex", "config.toml");
    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await mkdir(bin);
      await writeFile(configPath, CODEX_CONFIG_WITH_TRAILING_TABLE);
      await writeFile(path.join(bin, "codex"), codexMcpStub("USERPROFILE"));
      await chmod(path.join(bin, "codex"), 0o755);
      if (failPreflightNode) {
        // Fails only the preflight's node process, like a crash in its backup step.
        await writeFile(
          path.join(bin, "node"),
          `#!/bin/bash\nif [ "$1" = - ] && [ "$3" = proxy ]; then cat > /dev/null; echo 'Error: backup failed' >&2; exit 1; fi\nexec '${process.execPath}' "$@"\n`,
        );
        await chmod(path.join(bin, "node"), 0o755);
      }
      await writeFile(
        path.join(root, "setup.ps1"),
        renderSetupScript({
          clientId: "codex",
          platform: "windows",
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
          skills: null,
        }),
      );
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          ...args(path.join(root, "setup.ps1")),
        ],
        {
          cwd: home,
          encoding: "utf8",
          env: {
            HOME: home,
            USERPROFILE: home,
            PATH: `${bin}:${process.env.PATH}`,
            NO_COLOR: "1",
          },
          timeout: 60_000,
        },
      );
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        config: await readFile(configPath, "utf8"),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test.each([
    {
      // How the installer runs the downloaded script.
      invocation: "-File",
      args: (script: string) => ["-File", script],
      expectedStatus: SETUP_STOPPED_EXIT_CODE,
    },
    {
      // A pasted one-liner runs in the user's session, which stays open.
      invocation: "irm | iex",
      args: (script: string) => [
        "-Command",
        `Get-Content -Raw '${script}' | Invoke-Expression; Write-Host 'session still open'`,
      ],
      expectedStatus: 0,
    },
  ])("a stale model list stops setup with the cause once and no error record ($invocation)", async ({
    args,
    expectedStatus,
  }) => {
    const { status, output, config } = await runSetup(args);
    expect(status).toBe(expectedStatus);
    if (expectedStatus === 0) expect(output).toContain("session still open");
    expect(output).toContain(
      "Codex setup preflight failed: Codex could not download its model list. Check that this computer can reach chatgpt.com (proxy, VPN or firewall), then start a new installer run.\nNo client configuration was changed.",
    );
    expect(output.match(/start a new installer run/g)).toHaveLength(1);
    expect(output).not.toMatch(
      /FullyQualifiedErrorId|CategoryInfo|Setup is incomplete/,
    );
    expect(config).toBe(CODEX_CONFIG_WITH_TRAILING_TABLE);
  });

  test("a preflight failure without a named cause still ends with the generic next step", async () => {
    const { status, output, config } = await runSetup(
      (script) => ["-File", script],
      { failPreflightNode: true },
    );
    expect(output).toContain("Error: backup failed");
    // PowerShell's error view wraps the rest of the message at the console width.
    expect(output).toContain("Codex preflight failed.");
    expect(status).toBe(1);
    expect(config).toBe(CODEX_CONFIG_WITH_TRAILING_TABLE);
  });
});
