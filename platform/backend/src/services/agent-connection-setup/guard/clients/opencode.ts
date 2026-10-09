// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these files build bash/PowerShell source as JS strings, so `${VAR}` is shell
// parameter expansion for the emitted script, not a JS template placeholder

import {
  EXTERNAL_AGENT_ID_HEADER,
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  openCodePassthroughBaseUrl,
  STARTUP_GUARD_INSTALL,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import logger from "@/logging";
import { OPENCODE_PRIMARY_CONFIG_SCRIPT } from "../../payloads/opencode-primary-config";
import { psq, sh } from "../../steps/quoting";
import type { StartupGuardClient, StartupGuardContext } from "../startup-guard";

/**
 * OpenCode's connect merges the provider and MCP entries it owns into the
 * documented global config, writes a key file under ~/.archestra in
 * virtual-key mode, and clones skills separately. Disconnect removes only
 * those entries; OpenCode's auth store is never
 * touched, so local keys and subscriptions remain available.
 */
function opencodeProviderId(provider: string): string {
  return (
    OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.find(
      (route) => route.provider === provider,
    )?.openCodeProviderId ?? provider
  );
}

function opencodePassthroughRoutes(
  ctx: StartupGuardContext,
): Record<string, string> {
  const providerSuffix = ctx.proxy?.provider ? `/${ctx.proxy.provider}` : "";
  const rawUrl = ctx.proxy?.url ?? "";
  const stripped = Boolean(providerSuffix) && rawUrl.endsWith(providerSuffix);
  if (providerSuffix && rawUrl && !stripped) {
    logger.warn(
      { provider: ctx.proxy?.provider, proxyUrl: rawUrl },
      "OpenCode passthrough proxy URL does not end with the provider suffix; using the full URL as the route base",
    );
  }
  const baseUrl = stripped ? rawUrl.slice(0, -providerSuffix.length) : rawUrl;
  return Object.fromEntries(
    OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => [
      route.openCodeProviderId,
      openCodePassthroughBaseUrl(baseUrl, route),
    ]),
  );
}

function opencodeManagedHeaders(
  ctx: StartupGuardContext,
): Record<string, string> {
  const headers: Record<string, string> = {
    [EXTERNAL_AGENT_ID_HEADER]: "opencode",
  };
  if (ctx.proxy?.passthroughVirtualKey) {
    headers[VIRTUAL_KEY_HEADER] = ctx.proxy.passthroughVirtualKey;
  }
  return headers;
}

// Drops `<section>.<name>` from the global config. Inputs arrive via env, never argv.
const OPENCODE_OWNED_STRIP_PY = `import json, os, pathlib
p = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))) / "opencode" / "opencode.json"
if p.exists():
    d = json.loads(p.read_text() or "{}")
    section = os.environ["ARCH_OC_SECTION"]
    name = os.environ["ARCH_OC_NAME"]
    entries = d.get(section)
    if isinstance(entries, dict):
        entries.pop(name, None)
        if not entries:
            d.pop(section, None)
    if section == "provider":
        state_path = pathlib.Path(os.path.expanduser("~/.archestra/opencode-connection-state.json"))
        if state_path.exists():
            state = json.loads(state_path.read_text())
            provider_state = state.get("providerState") or {}
            if name in provider_state:
                providers = d.setdefault("provider", {})
                if provider_state[name] is None: providers.pop(name, None)
                else: providers[name] = provider_state[name]
                if not providers: d.pop("provider", None)
            if state.get("enabledProvidersPresent"): d["enabled_providers"] = state.get("enabledProviders")
            else: d.pop("enabled_providers", None)
            if state.get("disabledProvidersPresent"): d["disabled_providers"] = state.get("disabledProviders")
            else: d.pop("disabled_providers", None)
            state_path.unlink()
    backup = p.with_name(p.name + ".archestra-backup")
    if [k for k in d if k != "$schema"] or backup.exists():
        p.write_text(json.dumps(d, indent=2) + "\\n")
    else:
        p.unlink()`;

// Exit 0 when `<section>.<name>` is still in the global config.
const OPENCODE_OWNED_HAS_PY = `import json, os, pathlib, sys
p = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))) / "opencode" / "opencode.json"
d = json.loads(p.read_text() or "{}") if p.exists() else {}
sys.exit(0 if os.environ["ARCH_OC_NAME"] in (d.get(os.environ["ARCH_OC_SECTION"]) or {}) else 1)`;

const OPENCODE_OWNED_STRIP_NODE = `const fs=require("fs"),path=require("path"),os=require("os");
const home=process.env.HOME||os.homedir();
const p=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),"opencode","opencode.json");
if(fs.existsSync(p)){
  const d=JSON.parse(fs.readFileSync(p,"utf8")||"{}");
  const section=process.env.ARCH_OC_SECTION,name=process.env.ARCH_OC_NAME;
  const entries=d[section];
  if(entries&&typeof entries==="object") { delete entries[name]; if(Object.keys(entries).length===0) delete d[section]; }
  if(section==="provider"){
    const statePath=path.join(home,".archestra","opencode-connection-state.json");
    if(fs.existsSync(statePath)){
      const state=JSON.parse(fs.readFileSync(statePath,"utf8"));
      const providerState=state.providerState||{};
      if(Object.hasOwn(providerState,name)){
        d.provider??={};
        if(providerState[name]===null) delete d.provider[name]; else d.provider[name]=providerState[name];
        if(Object.keys(d.provider).length===0) delete d.provider;
      }
      if(state.enabledProvidersPresent) d.enabled_providers=state.enabledProviders; else delete d.enabled_providers;
      if(state.disabledProvidersPresent) d.disabled_providers=state.disabledProviders; else delete d.disabled_providers;
      fs.rmSync(statePath,{force:true});
    }
  }
  const backup=p+".archestra-backup";
  if(Object.keys(d).some((key)=>key!=="$schema")||fs.existsSync(backup)) fs.writeFileSync(p,JSON.stringify(d,null,2)+"\\n");
  else fs.rmSync(p,{force:true});
}`;

const OPENCODE_OWNED_HAS_NODE = `const fs=require("fs"),path=require("path"),os=require("os");
const home=process.env.HOME||os.homedir();
const p=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),"opencode","opencode.json");
const d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")||"{}"):{};
process.exit(Object.hasOwn(d[process.env.ARCH_OC_SECTION]||{},process.env.ARCH_OC_NAME)?0:1);`;

const OPENCODE_PASSTHROUGH_STRIP_PY = `import json, os, pathlib
p = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))) / "opencode" / "opencode.json"
if p.exists():
    d = json.loads(p.read_text() or "{}")
    providers = d.get("provider")
    expected_routes = json.loads(os.environ["ARCH_OC_PROVIDER_ROUTES"])
    managed_headers = json.loads(os.environ["ARCH_OC_HEADERS"])
    if isinstance(providers, dict):
        for provider_id, expected_url in expected_routes.items():
            entry = providers.get(provider_id)
            if not isinstance(entry, dict): continue
            options = entry.get("options")
            if not isinstance(options, dict): continue
            if options.get("baseURL") == expected_url: options.pop("baseURL", None)
            headers = options.get("headers")
            if isinstance(headers, dict):
                for name, value in managed_headers.items():
                    if headers.get(name) == value: headers.pop(name, None)
                if not headers: options.pop("headers", None)
            if not options: entry.pop("options", None)
            if not entry: providers.pop(provider_id, None)
        if not providers: d.pop("provider", None)
    state_path = pathlib.Path(os.path.expanduser("~/.archestra/opencode-connection-state.json"))
    if state_path.exists():
        state = json.loads(state_path.read_text())
        provider_state = state.get("providerState") or {}
        providers = d.setdefault("provider", {})
        for provider_id, previous in provider_state.items():
            if previous is None:
                if provider_id in providers and not providers[provider_id]: providers.pop(provider_id, None)
            else: providers[provider_id] = previous
        if not providers: d.pop("provider", None)
        if state.get("enabledProvidersPresent"): d["enabled_providers"] = state.get("enabledProviders")
        else: d.pop("enabled_providers", None)
        if state.get("disabledProvidersPresent"): d["disabled_providers"] = state.get("disabledProviders")
        else: d.pop("disabled_providers", None)
        state_path.unlink()
    p.write_text(json.dumps(d, indent=2) + "\\n")`;

const OPENCODE_PASSTHROUGH_STRIP_NODE = `const fs=require("fs"),path=require("path"),os=require("os");
const home=process.env.HOME||os.homedir();
const p=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),"opencode","opencode.json");
if(fs.existsSync(p)){
  const d=JSON.parse(fs.readFileSync(p,"utf8")||"{}");
  const providers=d.provider,expected=JSON.parse(process.env.ARCH_OC_PROVIDER_ROUTES),managed=JSON.parse(process.env.ARCH_OC_HEADERS);
  if(providers&&typeof providers==="object"){
    for(const [providerId,expectedUrl] of Object.entries(expected)){
      const entry=providers[providerId],options=entry?.options;
      if(!options||typeof options!=="object") continue;
      if(options.baseURL===expectedUrl) delete options.baseURL;
      if(options.headers&&typeof options.headers==="object"){
        for(const [name,value] of Object.entries(managed)) if(options.headers[name]===value) delete options.headers[name];
        if(Object.keys(options.headers).length===0) delete options.headers;
      }
      if(Object.keys(options).length===0) delete entry.options;
      if(Object.keys(entry).length===0) delete providers[providerId];
    }
    if(Object.keys(providers).length===0) delete d.provider;
  }
  const statePath=path.join(home,".archestra","opencode-connection-state.json");
  if(fs.existsSync(statePath)){
    const state=JSON.parse(fs.readFileSync(statePath,"utf8"));
    d.provider??={};
    for(const [providerId,previous] of Object.entries(state.providerState||{})){
      if(previous===null){ if(d.provider[providerId]&&Object.keys(d.provider[providerId]).length===0) delete d.provider[providerId]; }
      else d.provider[providerId]=previous;
    }
    if(Object.keys(d.provider).length===0) delete d.provider;
    if(state.enabledProvidersPresent) d.enabled_providers=state.enabledProviders; else delete d.enabled_providers;
    if(state.disabledProvidersPresent) d.disabled_providers=state.disabledProviders; else delete d.disabled_providers;
    fs.rmSync(statePath,{force:true});
  }
  fs.writeFileSync(p,JSON.stringify(d,null,2)+"\\n");
}`;

const OPENCODE_PLUGIN_RESTORE_NODE = `const fs=require("node:fs");
const [plugin,state]=process.argv.slice(1);
try {
  if (fs.existsSync(state)) {
    const saved=JSON.parse(fs.readFileSync(state,"utf8"));
    if (saved.existed && saved.contentBase64) { fs.mkdirSync(require("node:path").dirname(plugin),{recursive:true}); fs.writeFileSync(plugin,Buffer.from(saved.contentBase64,"base64"),{mode:0o600}); }
    else fs.rmSync(plugin,{force:true});
    fs.rmSync(state,{force:true});
  } else fs.rmSync(plugin,{force:true});
} catch { fs.rmSync(plugin,{force:true}); }`;

const OPENCODE_PLUGIN_RESTORE_PY = `import base64, json, pathlib, sys
plugin, state = map(pathlib.Path, sys.argv[1:3])
try:
    if state.exists():
        saved = json.loads(state.read_text())
        if saved.get("existed") and saved.get("contentBase64"):
            plugin.parent.mkdir(parents=True, exist_ok=True)
            plugin.write_bytes(base64.b64decode(saved["contentBase64"]))
            plugin.chmod(0o600)
        else:
            plugin.unlink(missing_ok=True)
        state.unlink(missing_ok=True)
    else:
        plugin.unlink(missing_ok=True)
except Exception:
    plugin.unlink(missing_ok=True)`;

const OPENCODE_SKILLS_DIR_SH =
  '"${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/$SKILLS_MARKETPLACE_NAME"';

function opencodeRestoreRoutingPluginSh(): string {
  return `arch_oc_plugin="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/archestra-llm-proxy.js"
  arch_oc_plugin_state="$HOME/.archestra/opencode-routing-plugin-state.json"
  if command -v node >/dev/null 2>&1; then
    node -e ${sh(OPENCODE_PLUGIN_RESTORE_NODE)} "$arch_oc_plugin" "$arch_oc_plugin_state"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c ${sh(OPENCODE_PLUGIN_RESTORE_PY)} "$arch_oc_plugin" "$arch_oc_plugin_state"
  else
    printf '%s  Node.js and python3 are unavailable. Restore or remove %s yourself.%s\n' "$C_WARN" "$arch_oc_plugin" "$C_RESET"
    return 1
  fi`;
}

function opencodeProxyDisconnect(ctx: StartupGuardContext): string {
  if (ctx.proxy?.authMode === "primary-providers") {
    return `disconnect_proxy() {
  ARCHESTRA_OC_PRIMARY=null node -e ${sh(OPENCODE_PRIMARY_CONFIG_SCRIPT)} || return 1
  ${opencodeRestoreRoutingPluginSh()}
}
proxy_disconnect_notes() {
  printf '%s\\n' 'Restored the provider configuration from before primary-provider setup.'
}`;
  }

  if (ctx.proxy?.authMode === "provider-key") {
    const routes = opencodePassthroughRoutes(ctx);
    const headers = opencodeManagedHeaders(ctx);
    return `disconnect_proxy() {
  ${opencodeRestoreRoutingPluginSh()}
  if command -v node >/dev/null 2>&1; then
    ARCH_OC_PROVIDER_ROUTES=${sh(JSON.stringify(routes))} ARCH_OC_HEADERS=${sh(JSON.stringify(headers))} node -e ${sh(OPENCODE_PASSTHROUGH_STRIP_NODE)} >/dev/null 2>&1 || true
  elif command -v python3 >/dev/null 2>&1; then
    ARCH_OC_PROVIDER_ROUTES=${sh(JSON.stringify(routes))} ARCH_OC_HEADERS=${sh(JSON.stringify(headers))} python3 -c ${sh(OPENCODE_PASSTHROUGH_STRIP_PY)} >/dev/null 2>&1 || true
  fi
  rm -f "\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json.archestra-backup"
}

proxy_disconnect_notes() {
  line_reset
  printf '%s  Removed ${ctx.appName} route overrides from supported OpenCode providers. Local authentication and model selection are unchanged.%s\n' "$C_DIM" "$C_RESET"
  return 0
}`;
  }
  const id = opencodeProviderId(ctx.proxy?.provider ?? "");
  return `disconnect_proxy() {
  ${opencodeRestoreRoutingPluginSh()}
  if command -v node >/dev/null 2>&1; then
    ARCH_OC_SECTION=provider ARCH_OC_NAME=${sh(id)} node -e ${sh(OPENCODE_OWNED_STRIP_NODE)} >/dev/null 2>&1 || true
  elif command -v python3 >/dev/null 2>&1; then
    ARCH_OC_SECTION=provider ARCH_OC_NAME=${sh(id)} python3 -c ${sh(OPENCODE_OWNED_STRIP_PY)} >/dev/null 2>&1 || true
  fi
  rm -f "$HOME/.archestra/opencode-${id}.key"
  rm -f "\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json.archestra-backup"
}

proxy_disconnect_notes() {
  line_reset
  if command -v node >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
    printf '%s  Removed the ${ctx.appName} provider settings from ~/.config/opencode/opencode.json. Local provider authentication is unchanged.%s\n' "$C_DIM" "$C_RESET"
  else
    printf '%s  Node.js and python3 are unavailable. Delete provider.${id} from ~/.config/opencode/opencode.json yourself.%s\n' "$C_WARN" "$C_RESET"
  fi
  return 0
}`;
}

function opencodeConfigDirPs(): string {
  return "$(if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'opencode' } else { Join-Path $env:USERPROFILE '.config/opencode' })";
}

/** PowerShell: drop `<section>.<name>` from the global config (BOM-free write). */
function opencodeWindowsStrip(section: string, nameExpr: string): string {
  return `    $archOc = Join-Path ${opencodeConfigDirPs()} 'opencode.json'
    if (Test-Path $archOc) {
      try {
        $archCfg = Get-Content -Raw -Path $archOc | ConvertFrom-Json
        $archSection = $archCfg.PSObject.Properties[${psq(section)}]
        if ($archSection -and $archSection.Value.PSObject.Properties[${nameExpr}]) {
          $archSection.Value.PSObject.Properties.Remove(${nameExpr})
          if (@($archSection.Value.PSObject.Properties).Count -eq 0) { $archCfg.PSObject.Properties.Remove(${psq(section)}) }
        }
        ${section === "provider" ? opencodeWindowsRestoreProviderCatalog() : ""}
        $archBackup = $archOc + '.archestra-backup'
        if (@($archCfg.PSObject.Properties | Where-Object { $_.Name -ne '$schema' }).Count -eq 0 -and -not (Test-Path $archBackup)) { Remove-Item -Force $archOc }
        else { [IO.File]::WriteAllText($archOc, ($archCfg | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false)) }
      } catch { }
    }`;
}

function opencodeWindowsVerifyGone(section: string, nameExpr: string): string {
  return `    $archOc = Join-Path ${opencodeConfigDirPs()} 'opencode.json'
    if (Test-Path $archOc) {
      try {
        $archCfg = Get-Content -Raw -Path $archOc | ConvertFrom-Json
        $archSection = $archCfg.PSObject.Properties[${psq(section)}]
        if ($archSection -and $archSection.Value.PSObject.Properties[${nameExpr}]) {
          $Script:ArchDisconnectReason = ${nameExpr} + ' is still in ' + $archOc + ' — remove it from the ${section} block yourself.'
          return $false
        }
      } catch { }
    }`;
}

function opencodeWindowsRestoreProviderCatalog(): string {
  return `$archStateFile = Join-Path $env:USERPROFILE '.archestra/opencode-connection-state.json'
        if (Test-Path $archStateFile) {
          $archState = Get-Content -Raw -Path $archStateFile | ConvertFrom-Json
          if ($archState.PSObject.Properties['providerState']) {
            if (-not $archCfg.PSObject.Properties['provider']) { $archCfg | Add-Member -NotePropertyName 'provider' -NotePropertyValue ([pscustomobject]@{}) }
            foreach ($archSavedProvider in $archState.providerState.PSObject.Properties) {
              if ($null -ne $archSavedProvider.Value) {
                if ($archCfg.provider.PSObject.Properties[$archSavedProvider.Name]) { $archCfg.provider.($archSavedProvider.Name) = $archSavedProvider.Value }
                else { $archCfg.provider | Add-Member -NotePropertyName $archSavedProvider.Name -NotePropertyValue $archSavedProvider.Value }
              } else {
                $archCurrentProvider = $archCfg.provider.PSObject.Properties[$archSavedProvider.Name]
                if ($archCurrentProvider -and @($archCurrentProvider.Value.PSObject.Properties).Count -eq 0) { $archCfg.provider.PSObject.Properties.Remove($archSavedProvider.Name) }
              }
            }
            if (@($archCfg.provider.PSObject.Properties).Count -eq 0) { $archCfg.PSObject.Properties.Remove('provider') }
          }
          if ($archState.enabledProvidersPresent) {
            if ($archCfg.PSObject.Properties['enabled_providers']) { $archCfg.enabled_providers = @($archState.enabledProviders) }
            else { $archCfg | Add-Member -NotePropertyName 'enabled_providers' -NotePropertyValue @($archState.enabledProviders) }
          }
          else { $archCfg.PSObject.Properties.Remove('enabled_providers') }
          if ($archState.disabledProvidersPresent) {
            if ($archCfg.PSObject.Properties['disabled_providers']) { $archCfg.disabled_providers = @($archState.disabledProviders) }
            else { $archCfg | Add-Member -NotePropertyName 'disabled_providers' -NotePropertyValue @($archState.disabledProviders) }
          }
          else { $archCfg.PSObject.Properties.Remove('disabled_providers') }
          Remove-Item -Force $archStateFile
        }`;
}

function opencodeWindowsRestoreRoutingPlugin(): string {
  return `$archPluginFile = Join-Path ${opencodeConfigDirPs()} 'plugins/archestra-llm-proxy.js'
  $archPluginState = Join-Path $env:USERPROFILE '.archestra/opencode-routing-plugin-state.json'
  if (Test-Path $archPluginState) {
    try {
      $archSavedPlugin = Get-Content -Raw -Path $archPluginState | ConvertFrom-Json
      if ($archSavedPlugin.existed -and $archSavedPlugin.contentBase64) { $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archPluginFile); [IO.File]::WriteAllBytes($archPluginFile, [Convert]::FromBase64String($archSavedPlugin.contentBase64)) }
      else { Remove-Item -Force -ErrorAction SilentlyContinue $archPluginFile }
    } catch { Remove-Item -Force -ErrorAction SilentlyContinue $archPluginFile }
    Remove-Item -Force -ErrorAction SilentlyContinue $archPluginState
  } else { Remove-Item -Force -ErrorAction SilentlyContinue $archPluginFile }`;
}

function opencodeWindowsRemoveConfigBackup(): string {
  // After plugin restore and proxy strip, matching Bash disconnect_proxy.
  return `  Remove-Item -Force -ErrorAction SilentlyContinue ((Join-Path ${opencodeConfigDirPs()} 'opencode.json') + '.archestra-backup')`;
}

function opencodeWindowsProxyDisconnect(ctx: StartupGuardContext): string {
  if (ctx.proxy?.authMode === "primary-providers") {
    return `function Disconnect-ArchProxy {
$archPrimaryRestore = @'
${OPENCODE_PRIMARY_CONFIG_SCRIPT}
'@
$env:ARCHESTRA_OC_PRIMARY = 'null'
try { $archPrimaryRestore | & node -; if ($LASTEXITCODE -ne 0) { throw 'Could not restore provider configuration' } }
finally { Remove-Item Env:ARCHESTRA_OC_PRIMARY -ErrorAction SilentlyContinue }
${opencodeWindowsRestoreRoutingPlugin()}
}`;
  }

  if (ctx.proxy?.authMode === "provider-key") {
    const routes = opencodePassthroughRoutes(ctx);
    const headers = opencodeManagedHeaders(ctx);
    const routeJson = psq(JSON.stringify(routes));
    const headerJson = psq(JSON.stringify(headers));
    return `function Disconnect-ArchProxy {
  ${opencodeWindowsRestoreRoutingPlugin()}
  $archOc = Join-Path ${opencodeConfigDirPs()} 'opencode.json'
  if (Test-Path $archOc) {
    try {
      $archCfg = Get-Content -Raw -Path $archOc | ConvertFrom-Json
      $archRoutes = ${routeJson} | ConvertFrom-Json
      $archManagedHeaders = ${headerJson} | ConvertFrom-Json
      foreach ($archRoute in $archRoutes.PSObject.Properties) {
        $archEntry = $archCfg.provider.PSObject.Properties[$archRoute.Name]
        if (-not $archEntry) { continue }
        $archOptions = $archEntry.Value.PSObject.Properties['options']
        if (-not $archOptions) { continue }
        if ($archOptions.Value.baseURL -eq $archRoute.Value) { $archOptions.Value.PSObject.Properties.Remove('baseURL') }
        $archHeaders = $archOptions.Value.PSObject.Properties['headers']
        if ($archHeaders) {
          foreach ($archHeader in $archManagedHeaders.PSObject.Properties) {
            if ($archHeaders.Value.($archHeader.Name) -eq $archHeader.Value) { $archHeaders.Value.PSObject.Properties.Remove($archHeader.Name) }
          }
          if (@($archHeaders.Value.PSObject.Properties).Count -eq 0) { $archOptions.Value.PSObject.Properties.Remove('headers') }
        }
        if (@($archOptions.Value.PSObject.Properties).Count -eq 0) { $archEntry.Value.PSObject.Properties.Remove('options') }
        if (@($archEntry.Value.PSObject.Properties).Count -eq 0) { $archCfg.provider.PSObject.Properties.Remove($archRoute.Name) }
      }
      ${opencodeWindowsRestoreProviderCatalog()}
      [IO.File]::WriteAllText($archOc, ($archCfg | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false))
    } catch { }
  }
${opencodeWindowsRemoveConfigBackup()}
}`;
  }
  const id = opencodeProviderId(ctx.proxy?.provider ?? "");
  return `function Disconnect-ArchProxy {
  ${opencodeWindowsRestoreRoutingPlugin()}
${opencodeWindowsStrip("provider", psq(id))}
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE ${psq(`.archestra/opencode-${id}.key`)})
${opencodeWindowsRemoveConfigBackup()}
}`;
}

export const OPENCODE_GUARD_CLIENT: StartupGuardClient = {
  clientId: "opencode",
  binary: "opencode",
  label: "OpenCode",
  promptName: "OpenCode",
  disableEnvVar: "ARCHESTRA_OPENCODE_GUARD",
  ...STARTUP_GUARD_INSTALL.opencode,
  // One-shot and headless subcommands: warn on stderr, skip the pre-loader.
  nonInteractiveArgPatterns: [
    "run",
    "serve",
    "web",
    "acp",
    "mcp",
    "auth",
    "debug",
    "models",
    "export",
    "import",
    "stats",
    "upgrade",
    "uninstall",
  ],
  utilitySubcommands: [
    "auth",
    "mcp",
    "plugin",
    "plugins",
    "install",
    "uninstall",
    "update",
    "upgrade",
    "doctor",
    "completion",
    "completions",
    "config",
    "login",
    "logout",
    "debug",
    "models",
    "stats",
    "export",
    "import",
    "github",
    "session",
    "providers",
    "db",
    "help",
  ],
  mcpDisconnectCommands: `      command opencode mcp logout "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      if command -v node >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" node -e ${sh(OPENCODE_OWNED_STRIP_NODE)} >/dev/null 2>&1 || true
      elif command -v python3 >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" python3 -c ${sh(OPENCODE_OWNED_STRIP_PY)} >/dev/null 2>&1 || true
      fi`,
  skillsDisconnectCommands: `      [ -n "$SKILLS_MARKETPLACE_NAME" ] && rm -rf ${OPENCODE_SKILLS_DIR_SH}`,
  skillsRefreshCommands: `  arch_oc_skills="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/$arch_refresh_marketplace"
  [ -d "$arch_oc_skills/.git" ] || return 0
  command -v git >/dev/null 2>&1 || return 1
  git -C "$arch_oc_skills" pull --ff-only -q </dev/null >/dev/null 2>&1 || return 1`,
  mcpDisconnectVerify: `      arch_oc_mcp_present=1
      if command -v node >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" node -e ${sh(OPENCODE_OWNED_HAS_NODE)} 2>/dev/null && arch_oc_mcp_present=0
      elif command -v python3 >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" python3 -c ${sh(OPENCODE_OWNED_HAS_PY)} 2>/dev/null && arch_oc_mcp_present=0
      fi
      if [ -f "\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json" ] && [ "$arch_oc_mcp_present" -eq 0 ]; then
        line_reset
        printf '%s  "%s" is still in ~/.config/opencode/opencode.json — remove it from the mcp block yourself.%s\\n' "$C_WARN" "$MCP_SERVER_NAME" "$C_RESET"
        return 1
      fi`,
  skillsDisconnectVerify: `      if [ -n "$SKILLS_MARKETPLACE_NAME" ] && [ -d ${OPENCODE_SKILLS_DIR_SH} ]; then
        line_reset
        printf '%s  %s is still there — delete it yourself.%s\\n' "$C_WARN" ${OPENCODE_SKILLS_DIR_SH} "$C_RESET"
        return 1
      fi`,
  renderProxyDisconnect: opencodeProxyDisconnect,
  windows: {
    mcpDisconnect: `      if ($archRealExe) { try { & $archRealExe.Source mcp logout $McpServerName 2>$null | Out-Null } catch { } }
${opencodeWindowsStrip("mcp", "$McpServerName")}`,
    skillsDisconnect: `      if ($SkillsMarketplaceName) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path ${opencodeConfigDirPs()} ('skills/' + $SkillsMarketplaceName)) }`,
    skillsRefreshCommands: `  $archOcSkills = Join-Path ${opencodeConfigDirPs()} ('skills/' + $ArchRefreshMarketplace)
  if (-not (Test-Path (Join-Path $archOcSkills '.git'))) { return $true }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
  try { & git -C $archOcSkills pull --ff-only -q 2>$null | Out-Null } catch { return $false }
  if ($LASTEXITCODE -ne 0) { return $false }`,
    mcpDisconnectVerify: opencodeWindowsVerifyGone("mcp", "$McpServerName"),
    skillsDisconnectVerify: `    $archOcSkills = Join-Path ${opencodeConfigDirPs()} ('skills/' + $SkillsMarketplaceName)
    if ($SkillsMarketplaceName -and (Test-Path $archOcSkills)) {
      $Script:ArchDisconnectReason = $archOcSkills + ' is still there — delete it yourself.'
      return $false
    }`,
    renderProxyDisconnect: opencodeWindowsProxyDisconnect,
    proxyDisconnectNote: (ctx) =>
      ctx.proxy?.authMode === "provider-key"
        ? `Removed ${ctx.appName} route overrides from supported OpenCode providers. Local authentication and model selection were preserved.`
        : `Removed the ${ctx.appName} provider settings from opencode.json. Local provider authentication was preserved.`,
  },
};
