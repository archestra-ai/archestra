import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { renderSetupScript } from "./index";

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

const NAME = "acme-skills";
const CLONE_URL =
  "http://token:archestra_mkt_test@stack2.localhost9002/skills/marketplace.git";
const START = "$archMarketplaceState = 'unknown'";
const END =
  "Warn \"Marketplace may already be registered — run 'copilot plugin marketplace browse' to inspect.\" }\n}";

/** The marketplace step of the Windows Copilot CLI setup script. */
function marketplaceSnippet(): string {
  const script = renderSetupScript({
    clientId: "copilot-cli",
    platform: "windows",
    appName: "Archestra",
    mcp: null,
    proxy: null,
    skills: { cloneUrl: CLONE_URL, marketplaceName: NAME },
  });
  const start = script.indexOf(START);
  const end = script.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error("Missing marketplace step");
  return script.slice(start, end + END.length);
}

/**
 * Runs the step under PowerShell with a `copilot` that keeps marketplaces in
 * COPILOT_HOME/settings.json and, like Copilot CLI, refuses `marketplace add`
 * for a name it already holds.
 */
async function runMarketplaceStep(
  initialSource: "stale" | "current" | "missing",
) {
  const root = await mkdtemp(path.join(tmpdir(), "archestra-copilot-ps-"));
  const copilotHome = path.join(root, "copilot-home");
  const settingsPath = path.join(copilotHome, "settings.json");
  const commandLog = path.join(root, "commands.log");
  const driver = path.join(root, "step.ps1");
  try {
    await mkdir(copilotHome, { recursive: true });
    await writeFile(commandLog, "");
    const url =
      initialSource === "stale"
        ? "http://token:archestra_mkt_earlier@stack2.localhost9002/skills/marketplace.git"
        : CLONE_URL;
    await writeFile(
      settingsPath,
      JSON.stringify({
        model: "archestra/gpt-6.1-sol",
        extraKnownMarketplaces: {
          "other-marketplace": {
            source: { source: "git", url: "https://example.com/other.git" },
          },
          ...(initialSource === "missing"
            ? {}
            : { [NAME]: { source: { source: "git", url } } }),
        },
      }),
    );
    await writeFile(
      driver,
      `$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
function Say($m) { Write-Host ('==> ' + $m) }
function Ok($m) { Write-Host ('==> ' + $m) }
function Warn($m) { Write-Host ('warning: ' + $m) }
function Hide-ArchUrlCredentials($Text) { ([string]$Text) -replace '://[^/@\\s]+@', '://***@' }
function Invoke-ArchRedacted([scriptblock]$Command) {
  $ErrorActionPreference = 'Continue'
  & $Command 2>&1 | ForEach-Object { Write-Host (Hide-ArchUrlCredentials $_) }
}
function copilot {
  Add-Content -Path $env:ARCHESTRA_TEST_COMMAND_LOG -Value ($args -join ' ')
  $settingsPath = Join-Path $env:COPILOT_HOME 'settings.json'
  $settings = Get-Content -Raw $settingsPath | ConvertFrom-Json
  if ($args[1] -eq 'marketplace' -and $args[2] -eq 'add') {
    if ($settings.extraKnownMarketplaces.PSObject.Properties['${NAME}']) {
      Write-Error 'Marketplace "${NAME}" already registered' -ErrorAction Continue
      $global:LASTEXITCODE = 1
      return
    }
    $settings.extraKnownMarketplaces | Add-Member -NotePropertyName '${NAME}' -NotePropertyValue ([pscustomobject]@{ source = [pscustomobject]@{ source = 'git'; url = $args[3] } })
    $settings | ConvertTo-Json -Depth 10 | Set-Content -Path $settingsPath
  }
  $global:LASTEXITCODE = 0
}
${marketplaceSnippet()}
`,
    );
    const { stdout, stderr } = await execFileAsync(
      powershellBin ?? "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driver],
      {
        cwd: root,
        timeout: 30_000,
        env: {
          ...process.env,
          COPILOT_HOME: copilotHome,
          NO_COLOR: "1",
          ARCHESTRA_TEST_COMMAND_LOG: commandLog,
        },
      },
    );
    return {
      commands: (await readFile(commandLog, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean),
      settings: JSON.parse(await readFile(settingsPath, "utf8")),
      output: `${stdout}${stderr}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(!powershellBin)(
  "Windows Copilot CLI skills marketplace",
  () => {
    test("points an earlier registration at this setup's credential and keeps the rest of settings.json", async () => {
      const result = await runMarketplaceStep("stale");

      expect(result.commands).toEqual([`plugin marketplace update ${NAME}`]);
      expect(result.settings).toEqual({
        model: "archestra/gpt-6.1-sol",
        extraKnownMarketplaces: {
          "other-marketplace": {
            source: { source: "git", url: "https://example.com/other.git" },
          },
          [NAME]: { source: { source: "git", url: CLONE_URL } },
        },
      });
      expect(result.output).toContain(
        `Pointed the "${NAME}" marketplace at this setup's source`,
      );
      expect(result.output).not.toContain("archestra_mkt_");
    });

    test.each([
      ["current", []],
      ["missing", [`plugin marketplace add ${CLONE_URL}`]],
    ] as const)("a %s registration ends on this setup's source", async (initialSource, commands) => {
      const result = await runMarketplaceStep(initialSource);

      expect(result.commands).toEqual(commands);
      expect(result.settings.extraKnownMarketplaces[NAME]).toEqual({
        source: { source: "git", url: CLONE_URL },
      });
      expect(result.output).not.toContain("may already be registered");
    });
  },
);
