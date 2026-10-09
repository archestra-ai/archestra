import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  CLAUDE_APPA_PERMISSIONS_SKIPPED_WARNING,
  claudeCodeAppaPermissionRules,
  claudeCodeAppaPermissionsAreLiteral,
} from "./agents/claude-code";
import { renderSetupScript } from "./index";
import type { SetupScriptMcpSection } from "./types";

const execFileAsync = promisify(execFile);
const powershellBin = [
  ...(process.platform === "win32" ? ["powershell.exe"] : []),
  "pwsh",
].find(
  (candidate) =>
    spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], {
      timeout: 15_000,
    }).status === 0,
);

if (process.env.CI === "true" && !powershellBin) {
  throw new Error("CI requires a working PowerShell runtime for these tests");
}

const BEGIN = "# >>> archestra:claude-appa-permissions >>>";
const END = "# <<< archestra:claude-appa-permissions <<<";
const SECRET = "arch_secret_token_value";
const NOTICE =
  "Claude Code can call the guardrail helpers without asking each time. Gateway sign-in and required human reviews still apply.";

const MCP: SetupScriptMcpSection = {
  serverName: "prod_gateway",
  toolPrefix: "archestra__",
  url: "https://archestra.example.com/v1/mcp/prod-gateway",
};

function rulesFor(mcp: SetupScriptMcpSection): string[] {
  return claudeCodeAppaPermissionRules(mcp);
}

function settingsWriteSnippet(
  script: string,
  failSettingsWrite?: boolean,
): string {
  const snippet = extractSnippet(script);
  if (!failSettingsWrite) return snippet;
  const settingsWrite =
    "Write-ArchAppaJsonAtomic $archAppaSettingsPath $archAppaSettingsJson";
  if (!snippet.includes(settingsWrite)) {
    throw new Error("Missing settings write");
  }
  return snippet.replace(settingsWrite, "throw 'settings write failed'");
}

function extractSnippet(script: string): string {
  const start = script.indexOf(BEGIN);
  const end = script.indexOf(END, start + BEGIN.length);
  if (start < 0 || end < 0) {
    throw new Error("Missing APPA permissions merge block");
  }
  return script.slice(start + BEGIN.length, end);
}

function windowsScript(mcp: SetupScriptMcpSection | null): string {
  return renderSetupScript({
    clientId: "claude-code",
    platform: "windows",
    appName: "Archestra",
    mcp,
    proxy: null,
    skills: null,
  });
}

test("MCP connect emits the allowlist merge and proxy-only connect does not", () => {
  const script = windowsScript(MCP);
  const snippet = extractSnippet(script);
  expect(snippet).toContain(NOTICE);
  expect(snippet).not.toContain("claude mcp");
  for (const rule of rulesFor(MCP)) {
    expect(snippet).toContain(rule);
  }
  const proxyOnly = renderSetupScript({
    clientId: "claude-code",
    platform: "windows",
    appName: "Archestra",
    mcp: null,
    proxy: {
      authMode: "virtual-key",
      provider: "anthropic",
      providerLabel: "Anthropic",
      baseUrl: "https://proxy.example.com/v1",
      url: "https://proxy.example.com/v1/anthropic",
      proxyName: "default_proxy",
      virtualKey: SECRET,
      virtualKeyName: null,
      passthroughVirtualKey: null,
      model: null,
    },
    skills: null,
  });
  expect(proxyOnly).not.toContain("claude-appa-permissions.json");
  expect(proxyOnly).not.toContain(NOTICE);
});

test("unsafe gateway names skip helper rules and still register MCP", () => {
  for (const mcp of [
    { ...MCP, serverName: "team_(eu)" },
    { ...MCP, toolPrefix: "archestra__*" },
  ]) {
    expect(claudeCodeAppaPermissionsAreLiteral(mcp)).toBe(false);
    const script = windowsScript(mcp);
    const snippet = extractSnippet(script);
    expect(script).toContain("mcp add");
    expect(snippet).toContain(CLAUDE_APPA_PERMISSIONS_SKIPPED_WARNING);
    expect(snippet).not.toContain(NOTICE);
    expect(snippet).not.toContain("claude-appa-permissions.json");
    expect(snippet).not.toContain("get_remedy_plans");
    expect(() => claudeCodeAppaPermissionRules(mcp)).toThrow(
      "literal server and tool names",
    );
  }
});

describe.skipIf(!powershellBin)("Windows APPA permission merge", () => {
  test("serializes wrapped CLR dictionaries and arrays without reflecting over PowerShell metadata", async () => {
    const settings = {
      permissions: { deny: ["Bash"] },
      env: { KEEP: "value" },
    };
    const result = await runMerge({
      contexts: [MCP],
      existing: JSON.stringify(settings),
      afterMerge: `
$PSVersionTable.PSVersion = [version]'5.1'
$wrapped = New-Object 'System.Collections.Generic.Dictionary[string,object]'
$wrapped['settings'] = [psobject]::AsPSObject($archAppaSettings)
$empty = [object[]]@()
$wrapped['empty'] = [psobject]::AsPSObject($empty)
$wrapped['single'] = [psobject]::AsPSObject([object[]]@('Read'))
$wrapped['flag'] = $false
$wrapped['number'] = 17
$wrapped['nil'] = $null
$json = ConvertTo-ArchAppaJson ([psobject]::AsPSObject($wrapped))
[IO.File]::WriteAllText($archAppaSettingsPath, $json)
`,
    });
    expect(result.failed).toBe(false);
    expect(JSON.parse(result.settingsRaw ?? "")).toEqual({
      settings: {
        ...settings,
        permissions: { ...settings.permissions, allow: rulesFor(MCP) },
      },
      empty: [],
      single: ["Read"],
      flag: false,
      number: 17,
      nil: null,
    });
  });

  test("adds only missing helper rules, preserves ask/deny/other settings, and does not claim preexisting rules", async () => {
    const rules = rulesFor(MCP);
    const added = rules.filter((rule) => rule !== rules[3]);
    const existing = {
      permissions: {
        allow: ["Read", rules[3]],
        ask: [rules[1]],
        deny: ["Bash"],
        additionalDirectories: [] as string[],
      },
      env: {
        ANTHROPIC_AUTH_TOKEN: SECRET,
        QUOTED: 'quote"and\\slash',
      },
      theme: "dark",
      enabled: true,
      note: null,
      timeout: 30,
      installedAt: "2024-01-15T00:00:00Z",
      reviewedOn: "2024-01-15",
    };
    const first = await runMerge({
      contexts: [MCP],
      existing: JSON.stringify(existing),
      ownership: JSON.stringify({ other_gateway: ["mcp__other__keep"] }),
    });
    expect(first.failed).toBe(false);
    expect(JSON.parse(first.settingsRaw ?? "")).toEqual({
      ...existing,
      permissions: {
        ...existing.permissions,
        allow: ["Read", rules[3], ...added],
      },
    });
    expect(JSON.parse(first.ownershipRaw ?? "")).toEqual({
      other_gateway: ["mcp__other__keep"],
      prod_gateway: added,
    });
    expect(first.backupRaw).toBe(JSON.stringify(existing));
    expect(first.stdout).toContain(NOTICE);
    expect(first.stdout).not.toContain(SECRET);
    expect(first.stderr).not.toContain(SECRET);

    const second = await runMerge({
      contexts: [MCP, MCP],
      existing: JSON.stringify(existing),
      ownership: JSON.stringify({ other_gateway: ["mcp__other__keep"] }),
    });
    expect(JSON.parse(second.settingsRaw ?? "")).toEqual(
      JSON.parse(first.settingsRaw ?? ""),
    );
    expect(JSON.parse(second.ownershipRaw ?? "")).toEqual(
      JSON.parse(first.ownershipRaw ?? ""),
    );
    expect(second.backupRaw).toBe(JSON.stringify(existing));
  });

  test("migrates legacy ownership without deleting user rules or other connections", async () => {
    const branded: SetupScriptMcpSection = {
      ...MCP,
      serverName: "company_gateway",
      toolPrefix: "company__",
      legacyServerNames: ["my_gateway"],
    };
    const desired = rulesFor(branded);
    const old = "mcp__my_gateway__archestra__get_remedy_plans";
    const userRule = "mcp__my_gateway__archestra__ask_user";
    const other = "mcp__other__archestra__yell";
    const result = await runMerge({
      contexts: [branded],
      existing: JSON.stringify({
        permissions: { allow: [old, userRule, other], deny: ["Bash"] },
      }),
      ownership: JSON.stringify({ my_gateway: [old], other: [other] }),
    });
    expect(JSON.parse(result.settingsRaw ?? "").permissions.allow).toEqual([
      userRule,
      other,
      ...desired,
    ]);
    expect(JSON.parse(result.ownershipRaw ?? "")).toEqual({
      other: [other],
      company_gateway: desired,
    });
  });

  test("drops stale owned rules case-sensitively and omits an empty server entry", async () => {
    const rules = rulesFor(MCP);
    const result = await runMerge({
      contexts: [{ ...MCP, legacyServerNames: ["my_gateway"] }],
      existing: JSON.stringify({
        permissions: {
          allow: [...rules, "StaleOwned", "stalecase"],
          deny: ["Bash"],
        },
      }),
      ownership: JSON.stringify({
        my_gateway: ["StaleOwned"],
        other_gateway: ["mcp__other__keep"],
      }),
    });
    expect(JSON.parse(result.settingsRaw ?? "").permissions.allow).toEqual([
      ...rules,
      "stalecase",
    ]);
    expect(JSON.parse(result.ownershipRaw ?? "")).toEqual({
      other_gateway: ["mcp__other__keep"],
    });
  });

  test("preserves case-distinct settings and ledger keys", async () => {
    const rules = rulesFor(MCP);
    const result = await runMerge({
      contexts: [MCP],
      existing: JSON.stringify({
        Theme: "Dark",
        theme: "light",
        permissions: { allow: ["Read"], deny: ["Bash"] },
      }),
      ownership: JSON.stringify({
        Keep: ["owned-upper"],
        keep: ["owned-lower"],
      }),
    });
    const settings = JSON.parse(result.settingsRaw ?? "");
    const ownership = JSON.parse(result.ownershipRaw ?? "");
    expect(settings.Theme).toBe("Dark");
    expect(settings.theme).toBe("light");
    expect(settings.permissions.deny).toEqual(["Bash"]);
    expect(ownership.Keep).toEqual(["owned-upper"]);
    expect(ownership.keep).toEqual(["owned-lower"]);
    expect(ownership.prod_gateway).toEqual(rules);
  });

  test("honors CLAUDE_CONFIG_DIR for settings and the ownership ledger", async () => {
    const result = await runMerge({
      contexts: [MCP],
      existing: "{}",
      customConfigDir: true,
    });
    expect(JSON.parse(result.settingsRaw ?? "").permissions.allow).toEqual(
      rulesFor(MCP),
    );
    expect(result.homeClaudeSettingsExists).toBe(false);
    expect(result.homeLedgerExists).toBe(false);
    expect(result.ownershipRaw).toContain("prod_gateway");
  });

  test("treats a blank settings file as empty and backs it up once", async () => {
    const blank = "  \n";
    const result = await runMerge({
      contexts: [MCP],
      existing: blank,
    });
    expect(JSON.parse(result.settingsRaw ?? "").permissions.allow).toEqual(
      rulesFor(MCP),
    );
    expect(result.backupRaw).toBe(blank);
  });

  test("leaves invalid settings JSON unchanged and does not create a backup or ledger", async () => {
    const broken = `{not json ${SECRET}`;
    const result = await runMerge({
      contexts: [MCP],
      existing: broken,
      expectFailure: true,
    });
    expect(result.failed).toBe(true);
    expect(result.settingsRaw).toBe(broken);
    expect(result.backupRaw).toBeNull();
    expect(result.ownershipRaw).toBeNull();
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SECRET);
  });

  test("does not replace an invalid allow list or a malformed ledger", async () => {
    const settings = JSON.stringify({
      permissions: { allow: "Read", deny: ["Bash"] },
      env: { ANTHROPIC_AUTH_TOKEN: SECRET },
    });
    const invalidAllow = await runMerge({
      contexts: [MCP],
      existing: settings,
      ownership: "{}",
      expectFailure: true,
    });
    expect(invalidAllow.failed).toBe(true);
    expect(invalidAllow.settingsRaw).toBe(settings);
    expect(invalidAllow.ownershipRaw).toBe("{}");
    expect(invalidAllow.backupRaw).toBeNull();
    expect(`${invalidAllow.stdout}\n${invalidAllow.stderr}`).not.toContain(
      SECRET,
    );

    const ledger = JSON.stringify({ other_gateway: "not-an-array" });
    const invalidLedger = await runMerge({
      contexts: [MCP],
      existing: settings,
      ownership: ledger,
      expectFailure: true,
    });
    expect(invalidLedger.failed).toBe(true);
    expect(invalidLedger.settingsRaw).toBe(settings);
    expect(invalidLedger.ownershipRaw).toBe(ledger);
    expect(invalidLedger.backupRaw).toBeNull();
  });

  test("a failed settings write after the ledger is recovered on retry", async () => {
    const rules = rulesFor(MCP);
    const original = JSON.stringify({
      permissions: { allow: ["Read"], deny: ["Bash"] },
      env: { KEEP: "value" },
    });
    const failed = await runMerge({
      contexts: [MCP],
      existing: original,
      failSettingsWrite: true,
      expectFailure: true,
    });
    expect(failed.failed).toBe(true);
    expect(failed.settingsRaw).toBe(original);
    expect(JSON.parse(failed.ownershipRaw ?? "")).toEqual({
      prod_gateway: rules,
    });

    const recovered = await runMerge({
      contexts: [MCP],
      existing: failed.settingsRaw,
      ownership: failed.ownershipRaw,
    });
    expect(recovered.failed).toBe(false);
    expect(JSON.parse(recovered.settingsRaw ?? "").permissions.allow).toEqual([
      "Read",
      ...rules,
    ]);
    expect(JSON.parse(recovered.settingsRaw ?? "").permissions.deny).toEqual([
      "Bash",
    ]);
    expect(JSON.parse(recovered.ownershipRaw ?? "")).toEqual({
      prod_gateway: rules,
    });
  });
});

async function runMerge(params: {
  contexts: SetupScriptMcpSection[];
  existing?: string | null;
  ownership?: string | null;
  customConfigDir?: boolean;
  expectFailure?: boolean;
  failSettingsWrite?: boolean;
  afterMerge?: string;
}): Promise<{
  settingsRaw: string | null;
  ownershipRaw: string | null;
  backupRaw: string | null;
  stdout: string;
  stderr: string;
  failed: boolean;
  homeClaudeSettingsExists: boolean;
  homeLedgerExists: boolean;
}> {
  const home = await mkdtemp(path.join(tmpdir(), "archestra-win-appa-"));
  const configDir = path.join(
    home,
    params.customConfigDir ? "profile" : ".claude",
  );
  const settingsPath = path.join(configDir, "settings.json");
  const stateRoot = params.customConfigDir ? configDir : home;
  const statePath = path.join(
    stateRoot,
    ".archestra",
    "claude-appa-permissions.json",
  );
  const backupPath = `${settingsPath}.archestra-backup`;
  try {
    if (params.existing != null) {
      await mkdir(configDir, { recursive: true });
      await writeFile(settingsPath, params.existing);
    }
    if (params.ownership != null) {
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, params.ownership);
    }
    let failed = false;
    let stdout = "";
    let stderr = "";
    for (const mcp of params.contexts) {
      const driver = path.join(home, `merge-${mcp.serverName}.ps1`);
      await writeFile(
        driver,
        `$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host ('==> ' + $m) }
function Ok($m) { Write-Host ('==> ' + $m) }
function Warn($m) { Write-Host ('warning: ' + $m) }
function Err($m) { Write-Host ('error: ' + $m) }
${settingsWriteSnippet(windowsScript(mcp), params.failSettingsWrite)}
${params.afterMerge ?? ""}
`,
      );
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: "1",
        CLAUDE_CONFIG_DIR: params.customConfigDir ? configDir : "",
      };
      try {
        const result = await execFileAsync(
          powershellBin ?? "pwsh",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driver],
          { cwd: home, env, timeout: 30_000 },
        );
        stdout += result.stdout;
        stderr += result.stderr;
      } catch (error) {
        failed = true;
        const failedRun = error as { stdout?: string; stderr?: string };
        stdout += failedRun.stdout ?? "";
        stderr += failedRun.stderr ?? String(error);
        if (!params.expectFailure) throw error;
      }
    }
    return {
      settingsRaw: await readIfExists(settingsPath),
      ownershipRaw: await readIfExists(statePath),
      backupRaw: await readIfExists(backupPath),
      stdout,
      stderr,
      failed,
      homeClaudeSettingsExists:
        (await readIfExists(path.join(home, ".claude", "settings.json"))) !==
        null,
      homeLedgerExists:
        (await readIfExists(
          path.join(home, ".archestra", "claude-appa-permissions.json"),
        )) !== null,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
