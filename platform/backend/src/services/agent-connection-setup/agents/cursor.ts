import { mergeJsonFileBash } from "../steps/json-merge";
import { describeMarketplaceContents } from "../steps/marketplace-copy";
import { legacyServerNames } from "../steps/mcp";
import { psq, sh } from "../steps/quoting";
import type {
  AgentEnding,
  SetupScriptContext,
  ShellAgentSetup,
} from "../types";

// Cursor setup. Cursor has no CLI to drive: the script merges ~/.cursor/mcp.json,
// clones the skills, and prints the model settings to paste. Bash and
// PowerShell versions sit side by side, then the agent module the dispatcher in
// ../index.ts uses.

const CURSOR_MCP_MERGE_PY = `import json, os, pathlib
path = pathlib.Path(os.path.expanduser("~/.cursor/mcp.json"))
config = {}
if path.exists():
    raw = path.read_text().strip()
    if raw:
        config = json.loads(raw)
servers = config.setdefault("mcpServers", {})
# Move, not add: an entry left by an earlier connect run points at this same
# gateway, so it is dropped rather than left beside the new one.
for legacy in json.loads(os.environ.get("ARCHESTRA_MCP_LEGACY_NAMES", "[]")):
    servers.pop(legacy, None)
servers[os.environ["ARCHESTRA_MCP_SERVER_NAME"]] = {
    "url": os.environ["ARCHESTRA_MCP_SERVER_URL"],
}
path.write_text(json.dumps(config, indent=2) + "\\n")
print(f"Updated {path}")`;

function cursorBashSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp && ctx.runtimeHandoffInstructions) {
    sections.push(`say ${sh("Runtime handoff instructions — copy into Cursor User Rules")}
printf '%s\\n' ${sh(ctx.runtimeHandoffInstructions)}`);
  }

  if (ctx.mcp) {
    sections.push(`say ${sh(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
${mergeJsonFileBash({
  file: "$HOME/.cursor/mcp.json",
  env: {
    ARCHESTRA_MCP_SERVER_NAME: ctx.mcp.serverName,
    ARCHESTRA_MCP_SERVER_URL: ctx.mcp.url,
    ARCHESTRA_MCP_LEGACY_NAMES: JSON.stringify(legacyServerNames(ctx.mcp)),
  },
  python: CURSOR_MCP_MERGE_PY,
  fallbackMessage:
    "python3 not found — merge this into ~/.cursor/mcp.json manually:",
  fallbackSnippet: JSON.stringify(
    { mcpServers: { [ctx.mcp.serverName]: { url: ctx.mcp.url } } },
    null,
    2,
  ),
})}`);
  }

  if (ctx.proxy) {
    // Cursor's model settings are UI-only; print everything needed for paste.
    sections.push(`say ${sh("Cursor model settings (manual step)")}
cat <<'ARCHESTRA_CURSOR'

In Cursor: Settings -> Models -> API Keys -> OpenAI API Key
  1. Turn on "Override OpenAI Base URL" and paste: ${ctx.proxy.url}
  2. ${
    ctx.proxy.virtualKey
      ? `Paste this key into the API Key field and turn on "Use OpenAI API Key":
     ${ctx.proxy.virtualKey}`
      : `Paste your own ${ctx.proxy.providerLabel} API key into the API Key field and turn on "Use OpenAI API Key". A Cursor subscription cannot be used as a provider credential.`
  }
ARCHESTRA_CURSOR`);
  }

  if (ctx.skills) {
    sections.push(`say ${sh(`Installing ${describeMarketplaceContents(ctx.skills).label} for Cursor`)}
CURSOR_SKILLS_DIR="$HOME/.cursor/skills/${ctx.skills.marketplaceName}"
cursor_skills_installed=0
if command -v git >/dev/null 2>&1; then
  if [ -d "$CURSOR_SKILLS_DIR/.git" ]; then
    if git -C "$CURSOR_SKILLS_DIR" remote set-url origin ${sh(ctx.skills.cloneUrl)} && git -C "$CURSOR_SKILLS_DIR" pull --ff-only -q; then
      cursor_skills_installed=1
    fi
  elif [ ! -e "$CURSOR_SKILLS_DIR" ]; then
    mkdir -p "$(dirname "$CURSOR_SKILLS_DIR")"
    if git clone -q ${sh(ctx.skills.cloneUrl)} "$CURSOR_SKILLS_DIR"; then
      cursor_skills_installed=1
    fi
  else
    warn ${sh("Cursor skills folder already exists and is not a Git repository.")}
  fi
else
  warn ${sh("git is not installed. Install git to fetch shared skills for Cursor.")}
fi
if [ "$cursor_skills_installed" -eq 1 ]; then
  ok ${sh(`Cursor skills installed in ~/.cursor/skills/${ctx.skills.marketplaceName}.`)}
else
  warn ${sh("Cursor skills installation failed. Retry after checking git access to the marketplace.")}
cat <<'ARCHESTRA_CURSOR_SKILLS'

Clone the marketplace into ~/.cursor/skills/${ctx.skills.marketplaceName}:
  git clone ${sh(ctx.skills.cloneUrl)} "$HOME/.cursor/skills/${ctx.skills.marketplaceName}"
ARCHESTRA_CURSOR_SKILLS
fi
cat <<'ARCHESTRA_CURSOR_SKILLS'

Reload Cursor and open Customize > Skills to confirm the shared skills are available.
ARCHESTRA_CURSOR_SKILLS`);
  }

  return sections;
}

function cursorPowerShellSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp && ctx.runtimeHandoffInstructions) {
    sections.push(`Say ${psq("Runtime handoff instructions — copy into Cursor User Rules")}
Write-Host ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(ctx.runtimeHandoffInstructions).toString("base64")}')))`);
  }

  if (ctx.mcp) {
    sections.push(`Say ${psq(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
$arch_path = Join-Path $env:USERPROFILE '.cursor\\mcp.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $arch_path) | Out-Null
if ((Test-Path $arch_path) -and -not (Test-Path ($arch_path + '.archestra-backup'))) {
  Copy-Item -Path $arch_path -Destination ($arch_path + '.archestra-backup')
}
$arch_config = [pscustomobject]@{}
if (Test-Path $arch_path) {
  $arch_raw = Get-Content -Raw -Path $arch_path
  if ($arch_raw -and $arch_raw.Trim()) { $arch_config = $arch_raw | ConvertFrom-Json }
}
if (-not $arch_config.PSObject.Properties['mcpServers']) { $arch_config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{}) }
$arch_servers = $arch_config.mcpServers
$arch_server_name = ${psq(ctx.mcp.serverName)}
$arch_entry = [pscustomobject]@{ url = ${psq(ctx.mcp.url)} }
foreach ($arch_legacy in @(${legacyServerNames(ctx.mcp).map(psq).join(", ") || "''"})) {
  if ($arch_legacy -and $arch_servers.PSObject.Properties[$arch_legacy]) { $arch_servers.PSObject.Properties.Remove($arch_legacy) }
}
if ($arch_servers.PSObject.Properties[$arch_server_name]) { $arch_servers.$arch_server_name = $arch_entry } else { $arch_servers | Add-Member -NotePropertyName $arch_server_name -NotePropertyValue $arch_entry }
$arch_config | ConvertTo-Json -Depth 32 | Set-Content -Path $arch_path -Encoding utf8
Write-Host ('Updated ' + $arch_path)`);
  }

  if (ctx.proxy) {
    sections.push(`Say ${psq("Cursor model settings (manual step)")}
Write-Host @'

In Cursor: Settings -> Models -> API Keys -> OpenAI API Key
  1. Turn on "Override OpenAI Base URL" and paste: ${ctx.proxy.url}
  2. ${
    ctx.proxy.virtualKey
      ? `Paste this key into the API Key field and turn on "Use OpenAI API Key":
     ${ctx.proxy.virtualKey}`
      : `Paste your own ${ctx.proxy.providerLabel} API key into the API Key field and turn on "Use OpenAI API Key". A Cursor subscription cannot be used as a provider credential.`
  }
'@`);
  }

  if (ctx.skills) {
    const pluginNames = ctx.skills.pluginNames ?? [];
    sections.push(`Say ${psq(`Installing ${describeMarketplaceContents(ctx.skills).label} for Cursor`)}
$cursorSkillsDir = Join-Path $env:USERPROFILE ${psq(`.cursor/skills/${ctx.skills.marketplaceName}`)}
$cursorSkillsInstalled = $false
if (Get-Command git -ErrorAction SilentlyContinue) {
  if (Test-Path (Join-Path $cursorSkillsDir '.git')) {
    & git -C $cursorSkillsDir remote set-url origin ${psq(ctx.skills.cloneUrl)} *> $null
    if ($LASTEXITCODE -eq 0) {
      & git -C $cursorSkillsDir pull --ff-only -q *> $null
      $cursorSkillsInstalled = $LASTEXITCODE -eq 0
    }
  } elseif (-not (Test-Path $cursorSkillsDir)) {
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cursorSkillsDir)
    & git clone -q ${psq(ctx.skills.cloneUrl)} $cursorSkillsDir *> $null
    $cursorSkillsInstalled = $LASTEXITCODE -eq 0
  } else {
    Warn ${psq("Cursor skills folder already exists and is not a Git repository.")}
  }
} else {
  Warn ${psq("git is not installed. Install git to fetch shared skills for Cursor.")}
}
if ($cursorSkillsInstalled) {
  Ok ${psq(`Cursor skills installed in ~/.cursor/skills/${ctx.skills.marketplaceName}.`)}
} else {
  Warn ${psq("Cursor skills installation failed. Retry after checking git access to the marketplace.")}
Write-Host @'

Clone the marketplace into ~/.cursor/skills/${ctx.skills.marketplaceName}:
  git clone ${psq(ctx.skills.cloneUrl)} "$HOME/.cursor/skills/${ctx.skills.marketplaceName}"
'@
}
Write-Host @'

Reload Cursor and open Customize > Skills to confirm the shared skills are available.
${
  pluginNames.length > 0
    ? `
Then install these plugins from Customize -> Plugins:
  ${pluginNames.join("\n  ")}`
    : ""
}
'@`);
  }

  return sections;
}

function cursorEnding(ctx: SetupScriptContext): AgentEnding {
  const notes: string[] = [];
  if (ctx.skills) {
    notes.push("Reload Cursor to load the shared skills (Customize > Skills).");
    if (ctx.skills.pluginNames?.length) {
      notes.push(
        `Install these plugins from Customize > Plugins: ${ctx.skills.pluginNames.join(", ")}.`,
      );
    }
  }
  notes.push(
    ctx.mcp && ctx.runtimeHandoffInstructions
      ? "Paste the handoff instructions printed above into Cursor Customize > Rules > User Rules, next to your own rules."
      : `If you pasted ${ctx.appName} handoff instructions into Cursor User Rules before, you can remove them.`,
  );
  return {
    proxyDetail:
      "Paste the model settings printed above into Cursor Settings > Models",
    signIn: ctx.mcp
      ? {
          command: null,
          howTo: `In Cursor, open Customize > MCPs and sign in to "${ctx.mcp.serverName}".`,
        }
      : null,
    launch: null,
    notes,
  };
}

export const cursorSetup: ShellAgentSetup = {
  label: "Cursor",
  bash: { sections: cursorBashSections },
  powerShell: {
    sections: cursorPowerShellSections,
  },
  ending: cursorEnding,
};
