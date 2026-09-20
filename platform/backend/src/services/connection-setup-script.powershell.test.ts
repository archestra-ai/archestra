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
import { STARTUP_GUARD_INSTALL } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import {
  renderSetupScript,
  type SetupScriptProxySection,
} from "@/services/connection-setup-script";

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
if (args[0] !== "mcp") process.exit(23);
if (args[1] === "remove") process.exit(1);
process.exit(args[1] === "add" && process.env.ARCHESTRA_TEST_FAIL_ADD === "1" ? 42 : 0);
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
              url: `http://127.0.0.1:${address.port}/v1/mcp/test-gateway`,
            },
            proxy: null,
            skills: null,
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
  if ($LASTEXITCODE -ne 23) { throw 'Restored wrapper lost client exit status' }
  $env:ARCHESTRA_TEST_FAIL_ADD = '0'
  Invoke-Expression $setup
  if (-not (Get-Item Function:${binary} -ErrorAction SilentlyContinue)) { throw 'Retry did not activate the wrapper' }
  $profileText = Get-Content -Raw $profilePath
  if ([regex]::Matches($profileText, [regex]::Escape('${guard.markerStart}')).Count -ne 1) { throw 'Retry duplicated the profile hook' }
  if (-not $profileText.Contains('# unrelated profile setting')) { throw 'Retry lost unrelated profile settings' }
  ${binary} @invokeArgs
  if ($LASTEXITCODE -ne 23) { throw 'Reinstalled wrapper lost client exit status' }
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
              PATH: `${bin}:${process.env.PATH}`,
              NO_COLOR: "1",
              ARCHESTRA_TEST_COMMAND_LOG: callsPath,
              ARCHESTRA_TEST_SETUP_PATH: setupPath,
            },
            timeout: 30_000,
          },
        );
        const calls: string[][] = (await readFile(callsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((args) => args[0] === "invoke")).toEqual(
          Array.from({ length: 4 }, () => [
            "invoke",
            "two words",
            "",
            "single'quote",
            "$HOME",
            "*",
          ]),
        );
        expect(
          calls.filter((args) => args[0] === "mcp" && args[1] === "add"),
        ).toHaveLength(6);
        expect(healthRequests).toHaveLength(4);
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
