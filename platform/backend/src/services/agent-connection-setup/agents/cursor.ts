import { mergeJsonFileBash } from "../steps/json-merge";
import { describeMarketplaceContents } from "../steps/marketplace-copy";
import { legacyServerNames } from "../steps/mcp";
import { psq, sh } from "../steps/quoting";
import type {
  AgentEnding,
  SetupScriptContext,
  SetupScriptProxySection,
  ShellAgentSetup,
} from "../types";

/** Cursor's settings-store row behind Settings > Models > API Keys. */
const CURSOR_APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

/** Row recording the Model Router ids the last setup added to Cursor's picker. */
const CURSOR_ROUTER_MODELS_KEY = "archestra/cursorModelRouterModels";

// Cursor setup. Cursor has no CLI to drive: the script merges ~/.cursor/mcp.json,
// clones the skills, and writes the model settings into Cursor's settings
// database. Bash and PowerShell versions sit side by side, then the agent module
// the dispatcher in ../index.ts uses.

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

// Cursor keeps its API key settings in a SQLite store rather than a JSON file.
// The Settings > Models > API Keys toggles live in the applicationUser blob and
// the key in its own row. Values arrive through the child process env.
//
// The picker then lists only the Model Router's models: they become user-added
// models, and every built-in model Cursor knows of is switched off (a user can
// switch one back on). The ids written are remembered in their own row, so a
// re-run replaces them instead of keeping models the router no longer lists.
const CURSOR_MODEL_SETTINGS_PY = `import json, os, sqlite3

def set_picker_models(db, user, models):
    ids = models["ids"]
    marker = "${CURSOR_ROUTER_MODELS_KEY}"
    row = db.execute("SELECT value FROM ItemTable WHERE key = ?", (marker,)).fetchone()
    stale = set(json.loads(row[0])) if row and row[0] else set()
    built_in = [m["name"] for m in user.get("availableDefaultModels2", []) if m.get("name")]
    ours = set(ids) | stale
    settings = user.setdefault("aiSettings", {})
    settings["userAddedModels"] = [
        m for m in settings.get("userAddedModels", []) if m not in ours
    ] + ids
    settings["modelOverrideEnabled"] = [
        m for m in settings.get("modelOverrideEnabled", [])
        if m not in ours and m not in built_in
    ] + ids
    settings["modelOverrideDisabled"] = [
        m for m in settings.get("modelOverrideDisabled", [])
        if m not in ours and m not in built_in
    ] + built_in
    # Chat, Cmd+K and the other features keep their own selected model; move
    # any still on a built-in model to the organization's default.
    default = models.get("defaultId")
    if default:
        for feature in settings.get("modelConfig", {}).values():
            if isinstance(feature, dict) and feature.get("modelName") not in ids:
                feature["modelName"] = default
                feature["selectedModels"] = [{"modelId": default, "parameters": []}]
    db.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        (marker, json.dumps(ids)),
    )

path = os.environ["ARCHESTRA_CURSOR_STATE_DB"]
backup = path + ".archestra-backup"
db = sqlite3.connect(path, timeout=5)
try:
    # Back up once, so a re-run keeps the pre-Archestra copy.
    if not os.path.exists(backup):
        copy = sqlite3.connect(backup)
        db.backup(copy)
        copy.close()
    row = db.execute(
        "SELECT key, value FROM ItemTable WHERE key LIKE ?",
        ("%persistentStorage.applicationUser",),
    ).fetchone()
    key = row[0] if row else "${CURSOR_APPLICATION_USER_KEY}"
    user = json.loads(row[1]) if row and row[1] else {}
    user["openAIBaseUrl"] = os.environ["ARCHESTRA_CURSOR_BASE_URL"]
    user["useOpenAIKey"] = True
    models = json.loads(os.environ.get("ARCHESTRA_CURSOR_MODELS") or "null")
    if models and models["ids"]:
        set_picker_models(db, user, models)
    db.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        (key, json.dumps(user)),
    )
    db.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ("cursorAuth/openAIKey", os.environ["ARCHESTRA_CURSOR_API_KEY"]),
    )
    db.commit()
finally:
    db.close()`;

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
    sections.push(cursorModelSettingsBash(ctx, ctx.proxy));
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
    sections.push(cursorModelSettingsPowerShell(ctx, ctx.proxy));
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

function cursorModelSettingsBash(
  ctx: SetupScriptContext,
  proxy: SetupScriptProxySection,
): string {
  if (!proxy.virtualKey) {
    return `say ${sh("Cursor model settings")}
warn ${sh("This setup has no virtual key for Cursor. Generate a new setup command to route Cursor's models.")}`;
  }
  const manual = manualModelSettings({
    url: proxy.url,
    virtualKey: proxy.virtualKey,
  });
  return `say ${sh(`Routing Cursor's models through ${ctx.appName}`)}
cursor_state_db=""
for arch_candidate in "$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb" "\${XDG_CONFIG_HOME:-$HOME/.config}/Cursor/User/globalStorage/state.vscdb"; do
  if [ -f "$arch_candidate" ]; then cursor_state_db="$arch_candidate"; break; fi
done
cursor_models_set=0
if [ -n "$cursor_state_db" ] && command -v python3 >/dev/null 2>&1; then
  if ARCHESTRA_CURSOR_STATE_DB="$cursor_state_db" ARCHESTRA_CURSOR_BASE_URL=${sh(proxy.url)} ARCHESTRA_CURSOR_API_KEY=${sh(proxy.virtualKey)} ARCHESTRA_CURSOR_MODELS=${sh(JSON.stringify(proxy.cursorModels ?? null))} python3 - <<'ARCHESTRA_CURSOR_PY'
${CURSOR_MODEL_SETTINGS_PY}
ARCHESTRA_CURSOR_PY
  then
    cursor_models_set=1
  fi
fi
if [ "$cursor_models_set" -eq 1 ]; then
  ok ${sh(`Cursor's OpenAI API key settings now point at ${ctx.appName}.`)}
  if pgrep -x Cursor >/dev/null 2>&1 || pgrep -x cursor >/dev/null 2>&1; then
    warn ${sh("Quit and reopen Cursor to load the new model settings.")}
  fi
else
  warn ${sh("Could not update Cursor's settings automatically (open Cursor once first, and install python3). Enter them by hand:")}
cat <<'ARCHESTRA_CURSOR'
${manual}
ARCHESTRA_CURSOR
fi`;
}

function cursorModelSettingsPowerShell(
  ctx: SetupScriptContext,
  proxy: SetupScriptProxySection,
): string {
  if (!proxy.virtualKey) {
    return `Say ${psq("Cursor model settings")}
Warn ${psq("This setup has no virtual key for Cursor. Generate a new setup command to route Cursor's models.")}`;
  }
  const manual = manualModelSettings({
    url: proxy.url,
    virtualKey: proxy.virtualKey,
  });
  return `Say ${psq(`Routing Cursor's models through ${ctx.appName}`)}
$cursorStateDb = Join-Path $env:APPDATA 'Cursor/User/globalStorage/state.vscdb'
$cursorPython = @('python3', 'python', 'py') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
$cursorModelsSet = $false
if ((Test-Path $cursorStateDb) -and $cursorPython) {
  $env:ARCHESTRA_CURSOR_STATE_DB = $cursorStateDb
  $env:ARCHESTRA_CURSOR_BASE_URL = ${psq(proxy.url)}
  $env:ARCHESTRA_CURSOR_API_KEY = ${psq(proxy.virtualKey)}
  $env:ARCHESTRA_CURSOR_MODELS = ${psq(JSON.stringify(proxy.cursorModels ?? null))}
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(CURSOR_MODEL_SETTINGS_PY).toString("base64")}')) | & $cursorPython - *> $null
  $cursorModelsSet = $LASTEXITCODE -eq 0
  Remove-Item Env:ARCHESTRA_CURSOR_API_KEY -ErrorAction SilentlyContinue
}
if ($cursorModelsSet) {
  Ok ${psq(`Cursor's OpenAI API key settings now point at ${ctx.appName}.`)}
  if (Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue) {
    Warn ${psq("Quit and reopen Cursor to load the new model settings.")}
  }
} else {
  Warn ${psq("Could not update Cursor's settings automatically (open Cursor once first, and install Python). Enter them by hand:")}
Write-Host @'
${manual}
'@
}`;
}

/** The fallback when the settings store can't be written. */
function manualModelSettings(params: {
  url: string;
  virtualKey: string;
}): string {
  return `
In Cursor: Settings -> Models -> API Keys -> OpenAI API Key
  1. Turn on "Override OpenAI Base URL" and paste: ${params.url}
  2. Paste this key into the API Key field and turn on "Use OpenAI API Key":
     ${params.virtualKey}`;
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
  if (ctx.proxy?.virtualKey) {
    notes.push(
      ctx.proxy.cursorModels?.ids.length
        ? `Cursor's model picker now lists only ${ctx.appName} models; its built-in models are switched off (Settings > Models turns one back on).`
        : `Add models in Cursor Settings > Models by their ${ctx.appName} id, such as anthropic:<model>. ${ctx.proxy.url}/models lists them.`,
    );
  }
  return {
    proxyDetail: `Cursor's models use the ${ctx.appName} Model Router (Settings > Models > API Keys)`,
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
