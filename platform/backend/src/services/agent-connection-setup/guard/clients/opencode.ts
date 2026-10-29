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
import {
  KILO_CLIENT,
  OPENCODE_CLIENT,
  type OpenCodeFamilyClient,
} from "../../opencode-family";
import { openCodeMcpMergeScript } from "../../payloads/opencode-mcp-config";
import { openCodePrimaryConfigScript } from "../../payloads/opencode-primary-config";
import { psq, sh } from "../../steps/quoting";
import type { StartupGuardClient, StartupGuardContext } from "../startup-guard";

/**
 * OpenCode's connect merges the provider and MCP entries it owns into the
 * documented global config, writes a key file under ~/.archestra in
 * virtual-key mode, and clones skills separately. Disconnect removes only
 * those entries; OpenCode's auth store is never
 * touched, so local keys and subscriptions remain available. Kilo Code, an
 * OpenCode fork, takes the same guard with its own paths and names.
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
  client: OpenCodeFamilyClient,
  ctx: StartupGuardContext,
): Record<string, string> {
  const headers: Record<string, string> = {
    [EXTERNAL_AGENT_ID_HEADER]: client.clientId,
  };
  if (ctx.proxy?.passthroughVirtualKey) {
    headers[VIRTUAL_KEY_HEADER] = ctx.proxy.passthroughVirtualKey;
  }
  return headers;
}

// Drops `<section>.<name>` from the global config. Inputs arrive via env, never argv.
const opencodeOwnedStripPy = (
  client: OpenCodeFamilyClient,
) => `import json, os, pathlib
p = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))) / ${JSON.stringify(client.dir)} / ${JSON.stringify(client.configFile)}
if os.environ.get("ARCH_OC_SECTION") == "mcp" and (p.parent / ${JSON.stringify(client.commentedConfigFile)}).exists():
    raise SystemExit("Node.js is required to disconnect the sibling JSONC gateway configuration.")
if p.exists():
    d = json.loads(p.read_text(encoding="utf-8-sig") or "{}")
    section = os.environ["ARCH_OC_SECTION"]
    name = os.environ["ARCH_OC_NAME"]
    entries = d.get(section)
    if isinstance(entries, dict):
        entries.pop(name, None)
        if not entries:
            d.pop(section, None)
    if section == "provider":
        state_path = pathlib.Path(os.path.expanduser(${JSON.stringify(`~/.archestra/${client.stateName}-connection-state.json`)}))
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

// Exit 0 only when `<section>.<name>` is absent from the global config.
const opencodeOwnedHasPy = (
  client: OpenCodeFamilyClient,
) => `import json, os, pathlib, sys
p = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))) / ${JSON.stringify(client.dir)} / ${JSON.stringify(client.configFile)}
d = json.loads(p.read_text(encoding="utf-8-sig") or "{}") if p.exists() else {}
sys.exit(1 if os.environ["ARCH_OC_NAME"] in (d.get(os.environ["ARCH_OC_SECTION"]) or {}) else 0)`;

const opencodeOwnedStripNode = (
  client: OpenCodeFamilyClient,
) => `const fs=require("fs"),path=require("path"),os=require("os");
const home=process.env.HOME||os.homedir();
const p=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),${JSON.stringify(client.dir)},${JSON.stringify(client.configFile)});
const section=process.env.ARCH_OC_SECTION,name=process.env.ARCH_OC_NAME;
if(fs.existsSync(p)||section==="mcp"){
  const d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8").replace(/^\\uFEFF/,"")||"{}"):{};
  let saveMcpSibling=()=>{};
  if(section==="mcp") {
    const configPath=p,cfg=d;
    process.env.ARCHESTRA_OC_MCP_NAME=name;
    process.env.ARCHESTRA_OC_MCP_URL=process.env.ARCH_OC_URL;
    ${openCodeMcpMergeScript(client, "disconnect").replaceAll("\n", "\n    ")}
    saveMcpSibling=writeMcpSibling;
  }
  const entries=d[section];
  if(entries&&typeof entries==="object") { delete entries[name]; if(Object.keys(entries).length===0) delete d[section]; }
  if(section==="provider"){
    const statePath=path.join(home,".archestra",${JSON.stringify(`${client.stateName}-connection-state.json`)});
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
  saveMcpSibling();
}`;

const opencodeMcpVerifyNode = (
  client: OpenCodeFamilyClient,
) => `const fs=require("fs"),path=require("path"),os=require("os");
const home=process.env.HOME||os.homedir();
const configPath=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),${JSON.stringify(client.dir)},${JSON.stringify(client.configFile)});
const cfg=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,"utf8").replace(/^\\uFEFF/,"")||"{}"):{};
process.env.ARCHESTRA_OC_MCP_NAME=process.env.ARCH_OC_NAME;
process.env.ARCHESTRA_OC_MCP_URL=process.env.ARCH_OC_URL;
${openCodeMcpMergeScript(client, "verify").replaceAll("\n", "\n  ")}`;

const opencodePassthroughStripPy = (
  client: OpenCodeFamilyClient,
) => `import json, os, pathlib
p = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))) / ${JSON.stringify(client.dir)} / ${JSON.stringify(client.configFile)}
if p.exists():
    d = json.loads(p.read_text(encoding="utf-8-sig") or "{}")
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
    state_path = pathlib.Path(os.path.expanduser(${JSON.stringify(`~/.archestra/${client.stateName}-connection-state.json`)}))
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

const opencodePassthroughStripNode = (
  client: OpenCodeFamilyClient,
) => `const fs=require("fs"),path=require("path"),os=require("os");
const home=process.env.HOME||os.homedir();
const p=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),${JSON.stringify(client.dir)},${JSON.stringify(client.configFile)});
if(fs.existsSync(p)){
  const d=JSON.parse(fs.readFileSync(p,"utf8").replace(/^\\uFEFF/,"")||"{}");
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
  const statePath=path.join(home,".archestra",${JSON.stringify(`${client.stateName}-connection-state.json`)});
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

const opencodeSkillsDirSh = (client: OpenCodeFamilyClient) =>
  `"\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/skills/$SKILLS_MARKETPLACE_NAME"`;

function opencodeRestoreRoutingPluginSh(client: OpenCodeFamilyClient): string {
  return `arch_oc_plugin="\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/plugins/archestra-llm-proxy.js"
  arch_oc_plugin_state="$HOME/.archestra/${client.stateName}-routing-plugin-state.json"
  if command -v node >/dev/null 2>&1; then
    node -e ${sh(OPENCODE_PLUGIN_RESTORE_NODE)} "$arch_oc_plugin" "$arch_oc_plugin_state"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c ${sh(OPENCODE_PLUGIN_RESTORE_PY)} "$arch_oc_plugin" "$arch_oc_plugin_state"
  else
    printf '%s  Node.js and python3 are unavailable. Restore or remove %s yourself.%s\n' "$C_WARN" "$arch_oc_plugin" "$C_RESET"
    return 1
  fi`;
}

function opencodeProxyDisconnect(
  client: OpenCodeFamilyClient,
  ctx: StartupGuardContext,
): string {
  if (
    ctx.proxy?.usesModelCatalog ||
    ctx.proxy?.authMode === "primary-providers"
  ) {
    return `disconnect_proxy() {
  ARCHESTRA_OC_PRIMARY=null node -e ${sh(openCodePrimaryConfigScript(client))} || return 1
  ${opencodeRestoreRoutingPluginSh(client)}
}
proxy_disconnect_notes() {
  printf '%s\\n' 'Restored the provider configuration from before model-provider setup.'
}`;
  }

  if (ctx.proxy?.authMode === "provider-key") {
    const routes = opencodePassthroughRoutes(ctx);
    const headers = opencodeManagedHeaders(client, ctx);
    return `disconnect_proxy() {
  ${opencodeRestoreRoutingPluginSh(client)}
  if command -v node >/dev/null 2>&1; then
    ARCH_OC_PROVIDER_ROUTES=${sh(JSON.stringify(routes))} ARCH_OC_HEADERS=${sh(JSON.stringify(headers))} node -e ${sh(opencodePassthroughStripNode(client))} >/dev/null 2>&1 || true
  elif command -v python3 >/dev/null 2>&1; then
    ARCH_OC_PROVIDER_ROUTES=${sh(JSON.stringify(routes))} ARCH_OC_HEADERS=${sh(JSON.stringify(headers))} python3 -c ${sh(opencodePassthroughStripPy(client))} >/dev/null 2>&1 || true
  fi
  rm -f "\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/${client.configFile}.archestra-backup"
}

proxy_disconnect_notes() {
  line_reset
  printf '%s  Removed ${ctx.appName} route overrides from supported ${client.label} providers. Local authentication and model selection are unchanged.%s\n' "$C_DIM" "$C_RESET"
  return 0
}`;
  }
  const id = opencodeProviderId(ctx.proxy?.provider ?? "");
  return `disconnect_proxy() {
  ${opencodeRestoreRoutingPluginSh(client)}
  if command -v node >/dev/null 2>&1; then
    ARCH_OC_SECTION=provider ARCH_OC_NAME=${sh(id)} node -e ${sh(opencodeOwnedStripNode(client))} >/dev/null 2>&1 || true
  elif command -v python3 >/dev/null 2>&1; then
    ARCH_OC_SECTION=provider ARCH_OC_NAME=${sh(id)} python3 -c ${sh(opencodeOwnedStripPy(client))} >/dev/null 2>&1 || true
  fi
  rm -f "$HOME/.archestra/${client.stateName}-${id}.key"
  rm -f "\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/${client.configFile}.archestra-backup"
}

proxy_disconnect_notes() {
  line_reset
  if command -v node >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
    printf '%s  Removed the ${ctx.appName} provider settings from ~/.config/${client.dir}/${client.configFile}. Local provider authentication is unchanged.%s\n' "$C_DIM" "$C_RESET"
  else
    printf '%s  Node.js and python3 are unavailable. Delete provider.${id} from ~/.config/${client.dir}/${client.configFile} yourself.%s\n' "$C_WARN" "$C_RESET"
  fi
  return 0
}`;
}

function opencodeConfigDirPs(client: OpenCodeFamilyClient): string {
  return `$(if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME ${psq(client.dir)} } else { Join-Path $env:USERPROFILE ${psq(`.config/${client.dir}`)} })`;
}

/** PowerShell: drop `<section>.<name>` from the global config (BOM-free write). */
function opencodeWindowsStrip(
  client: OpenCodeFamilyClient,
  section: string,
  nameExpr: string,
): string {
  return `    $archOc = Join-Path ${opencodeConfigDirPs(client)} ${psq(client.configFile)}
    if (Test-Path $archOc) {
      try {
        $archCfg = Get-Content -Raw -Path $archOc | ConvertFrom-Json
        $archSection = $archCfg.PSObject.Properties[${psq(section)}]
        if ($archSection -and $archSection.Value.PSObject.Properties[${nameExpr}]) {
          $archSection.Value.PSObject.Properties.Remove(${nameExpr})
          if (@($archSection.Value.PSObject.Properties).Count -eq 0) { $archCfg.PSObject.Properties.Remove(${psq(section)}) }
        }
        ${section === "provider" ? opencodeWindowsRestoreProviderCatalog(client) : ""}
        $archBackup = $archOc + '.archestra-backup'
        if (@($archCfg.PSObject.Properties | Where-Object { $_.Name -ne '$schema' }).Count -eq 0 -and -not (Test-Path $archBackup)) { Remove-Item -Force $archOc }
        else { [IO.File]::WriteAllText($archOc, ($archCfg | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false)) }
      } catch { }
    }`;
}

function opencodeWindowsVerifyGone(
  client: OpenCodeFamilyClient,
  section: string,
  nameExpr: string,
): string {
  return `    $archOc = Join-Path ${opencodeConfigDirPs(client)} ${psq(client.configFile)}
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

function opencodeWindowsRestoreProviderCatalog(
  client: OpenCodeFamilyClient,
): string {
  return `$archStateFile = Join-Path $env:USERPROFILE ${psq(`.archestra/${client.stateName}-connection-state.json`)}
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

function opencodeWindowsRestoreRoutingPlugin(
  client: OpenCodeFamilyClient,
): string {
  return `$archPluginFile = Join-Path ${opencodeConfigDirPs(client)} 'plugins/archestra-llm-proxy.js'
  $archPluginState = Join-Path $env:USERPROFILE ${psq(`.archestra/${client.stateName}-routing-plugin-state.json`)}
  if (Test-Path $archPluginState) {
    try {
      $archSavedPlugin = Get-Content -Raw -Path $archPluginState | ConvertFrom-Json
      if ($archSavedPlugin.existed -and $archSavedPlugin.contentBase64) { $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archPluginFile); [IO.File]::WriteAllBytes($archPluginFile, [Convert]::FromBase64String($archSavedPlugin.contentBase64)) }
      else { Remove-Item -Force -ErrorAction SilentlyContinue $archPluginFile }
    } catch { Remove-Item -Force -ErrorAction SilentlyContinue $archPluginFile }
    Remove-Item -Force -ErrorAction SilentlyContinue $archPluginState
  } else { Remove-Item -Force -ErrorAction SilentlyContinue $archPluginFile }`;
}

function opencodeWindowsRemoveConfigBackup(
  client: OpenCodeFamilyClient,
): string {
  // After plugin restore and proxy strip, matching Bash disconnect_proxy.
  return `  Remove-Item -Force -ErrorAction SilentlyContinue ((Join-Path ${opencodeConfigDirPs(client)} ${psq(client.configFile)}) + '.archestra-backup')`;
}

function opencodeWindowsProxyDisconnect(
  client: OpenCodeFamilyClient,
  ctx: StartupGuardContext,
): string {
  if (
    ctx.proxy?.usesModelCatalog ||
    ctx.proxy?.authMode === "primary-providers"
  ) {
    return `function Disconnect-ArchProxy {
$env:ARCHESTRA_OC_PRIMARY = 'null'
try { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(Buffer.from(openCodePrimaryConfigScript(client)).toString("base64"))})) | & node -; if ($LASTEXITCODE -ne 0) { throw 'Could not restore provider configuration' } }
finally { Remove-Item Env:ARCHESTRA_OC_PRIMARY -ErrorAction SilentlyContinue }
${opencodeWindowsRestoreRoutingPlugin(client)}
}`;
  }

  if (ctx.proxy?.authMode === "provider-key") {
    const routes = opencodePassthroughRoutes(ctx);
    const headers = opencodeManagedHeaders(client, ctx);
    const routeJson = psq(JSON.stringify(routes));
    const headerJson = psq(JSON.stringify(headers));
    return `function Disconnect-ArchProxy {
  ${opencodeWindowsRestoreRoutingPlugin(client)}
  $archOc = Join-Path ${opencodeConfigDirPs(client)} ${psq(client.configFile)}
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
      ${opencodeWindowsRestoreProviderCatalog(client)}
      [IO.File]::WriteAllText($archOc, ($archCfg | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false))
    } catch { }
  }
${opencodeWindowsRemoveConfigBackup(client)}
}`;
  }
  const id = opencodeProviderId(ctx.proxy?.provider ?? "");
  return `function Disconnect-ArchProxy {
  ${opencodeWindowsRestoreRoutingPlugin(client)}
${opencodeWindowsStrip(client, "provider", psq(id))}
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE ${psq(`.archestra/${client.stateName}-${id}.key`)})
${opencodeWindowsRemoveConfigBackup(client)}
}`;
}

function openCodeFamilyGuardClient(
  client: OpenCodeFamilyClient,
  commands: Pick<
    StartupGuardClient,
    | "disableEnvVar"
    | "nonInteractiveArgPatterns"
    | "utilitySubcommands"
    | "handoffSkipSubcommands"
  >,
): StartupGuardClient {
  const skillsDir = opencodeSkillsDirSh(client);
  return {
    clientId: client.clientId,
    binary: client.binary,
    label: client.label,
    promptName: client.label,
    ...commands,
    inlineConfigEnv: client.inlineConfigEnv,
    ...STARTUP_GUARD_INSTALL[client.clientId],
    mcpDisconnectCommands: `      command ${client.binary} mcp logout "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      if command -v node >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" ARCH_OC_URL="\${MCP_SERVER_URL:-}" node -e ${sh(opencodeOwnedStripNode(client))} >/dev/null 2>&1 || true
      elif command -v python3 >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" python3 -c ${sh(opencodeOwnedStripPy(client))} >/dev/null 2>&1 || true
      fi`,
    skillsDisconnectCommands: `      [ -n "$SKILLS_MARKETPLACE_NAME" ] && rm -rf ${skillsDir}`,
    skillsRefreshCommands: `  arch_oc_skills="\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/skills/$arch_refresh_marketplace"
  [ -d "$arch_oc_skills/.git" ] || return 0
  command -v git >/dev/null 2>&1 || return 1
  git -C "$arch_oc_skills" pull --ff-only -q </dev/null >/dev/null 2>&1 || return 1`,
    mcpDisconnectVerify: `      if command -v node >/dev/null 2>&1; then
        if ! ARCH_OC_NAME="$MCP_SERVER_NAME" ARCH_OC_URL="\${MCP_SERVER_URL:-}" node -e ${sh(opencodeMcpVerifyNode(client))} >/dev/null 2>&1; then
          line_reset
          printf '%s  Could not verify that the gateway is disabled in ${client.configFile} and ${client.commentedConfigFile}.%s\\n' "$C_WARN" "$C_RESET"
          return 1
        fi
      elif command -v python3 >/dev/null 2>&1; then
        [ ! -f "\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/${client.commentedConfigFile}" ] || return 1
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" python3 -c ${sh(opencodeOwnedHasPy(client))} 2>/dev/null || return 1
      else
        if [ -f "\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/${client.configFile}" ] || [ -f "\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/${client.commentedConfigFile}" ]; then return 1; fi
      fi`,
    skillsDisconnectVerify: `      if [ -n "$SKILLS_MARKETPLACE_NAME" ] && [ -d ${skillsDir} ]; then
        line_reset
        printf '%s  %s is still there — delete it yourself.%s\\n' "$C_WARN" ${skillsDir} "$C_RESET"
        return 1
      fi`,
    renderProxyDisconnect: (ctx) => opencodeProxyDisconnect(client, ctx),
    windows: {
      mcpDisconnect: `      if ($archRealExe) { try { & $archRealExe.Source mcp logout $McpServerName 2>$null | Out-Null } catch { } }
      if (Get-Command node -ErrorAction SilentlyContinue) {
        $env:ARCH_OC_SECTION = 'mcp'
        $env:ARCH_OC_NAME = $McpServerName
        $env:ARCH_OC_URL = $McpServerUrl
        try { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(Buffer.from(opencodeOwnedStripNode(client)).toString("base64"))})) | & node - }
        finally { Remove-Item Env:ARCH_OC_SECTION, Env:ARCH_OC_NAME, Env:ARCH_OC_URL -ErrorAction SilentlyContinue }
      } elseif (-not (Test-Path (Join-Path ${opencodeConfigDirPs(client)} ${psq(client.commentedConfigFile)}))) {
${opencodeWindowsStrip(client, "mcp", "$McpServerName")}
      }`,
      skillsDisconnect: `      if ($SkillsMarketplaceName) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path ${opencodeConfigDirPs(client)} ('skills/' + $SkillsMarketplaceName)) }`,
      skillsRefreshCommands: `  $archOcSkills = Join-Path ${opencodeConfigDirPs(client)} ('skills/' + $ArchRefreshMarketplace)
  if (-not (Test-Path (Join-Path $archOcSkills '.git'))) { return $true }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
  try { & git -C $archOcSkills pull --ff-only -q 2>$null | Out-Null } catch { return $false }
  if ($LASTEXITCODE -ne 0) { return $false }`,
      mcpDisconnectVerify: `    if (Get-Command node -ErrorAction SilentlyContinue) {
      $env:ARCH_OC_NAME = $McpServerName
      $env:ARCH_OC_URL = $McpServerUrl
      try { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(Buffer.from(opencodeMcpVerifyNode(client)).toString("base64"))})) | & node - | Out-Null }
      finally { Remove-Item Env:ARCH_OC_NAME, Env:ARCH_OC_URL -ErrorAction SilentlyContinue }
      if ($LASTEXITCODE -ne 0) {
        $Script:ArchDisconnectReason = 'Could not verify that the gateway is disabled in both config files.'
        return $false
      }
    } elseif (Test-Path (Join-Path ${opencodeConfigDirPs(client)} ${psq(client.commentedConfigFile)})) {
      $Script:ArchDisconnectReason = 'Node.js is required to verify the sibling JSONC gateway configuration.'
      return $false
    } else {
${opencodeWindowsVerifyGone(client, "mcp", "$McpServerName")}
    }`,
      skillsDisconnectVerify: `    $archOcSkills = Join-Path ${opencodeConfigDirPs(client)} ('skills/' + $SkillsMarketplaceName)
    if ($SkillsMarketplaceName -and (Test-Path $archOcSkills)) {
      $Script:ArchDisconnectReason = $archOcSkills + ' is still there — delete it yourself.'
      return $false
    }`,
      renderProxyDisconnect: (ctx) =>
        opencodeWindowsProxyDisconnect(client, ctx),
      proxyDisconnectNote: (ctx) =>
        ctx.proxy?.authMode === "provider-key"
          ? `Removed ${ctx.appName} route overrides from supported ${client.label} providers. Local authentication and model selection were preserved.`
          : `Removed the ${ctx.appName} provider settings from ${client.configFile}. Local provider authentication was preserved.`,
    },
  };
}

const OPENCODE_SUBCOMMANDS = {
  // One-shot and headless subcommands: warn on stderr, skip the pre-loader.
  nonInteractive: [
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
  utility: [
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
  handoffSkip: [
    "serve",
    "web",
    "acp",
    "models",
    "stats",
    "export",
    "import",
    "github",
    "session",
    "attach",
    "providers",
    "db",
    "pr",
    "agent",
  ],
};

export const OPENCODE_GUARD_CLIENT = openCodeFamilyGuardClient(
  OPENCODE_CLIENT,
  {
    disableEnvVar: OPENCODE_CLIENT.guardEnvVar,
    nonInteractiveArgPatterns: OPENCODE_SUBCOMMANDS.nonInteractive,
    utilitySubcommands: OPENCODE_SUBCOMMANDS.utility,
    handoffSkipSubcommands: OPENCODE_SUBCOMMANDS.handoffSkip,
  },
);

// Kilo 7.8.8 has none of these OpenCode subcommands (captured 2026-10-13).
const KILO_MISSING_SUBCOMMANDS = new Set([
  "web",
  "plugins",
  "install",
  "update",
  "doctor",
  "completions",
  "login",
  "logout",
]);
// Kilo's own: its cloud, profile and daemon commands.
const KILO_ONLY_SUBCOMMANDS = [
  "console",
  "cloud",
  "profile",
  "remote",
  "daemon",
  "worktree",
  "roll-call",
];
const kiloSubcommands = (base: string[], extra: string[]) => [
  ...base.filter((subcommand) => !KILO_MISSING_SUBCOMMANDS.has(subcommand)),
  ...extra,
];

export const KILO_GUARD_CLIENT = openCodeFamilyGuardClient(KILO_CLIENT, {
  disableEnvVar: KILO_CLIENT.guardEnvVar,
  nonInteractiveArgPatterns: kiloSubcommands(
    OPENCODE_SUBCOMMANDS.nonInteractive,
    ["daemon", "roll-call"],
  ),
  utilitySubcommands: kiloSubcommands(
    OPENCODE_SUBCOMMANDS.utility,
    KILO_ONLY_SUBCOMMANDS,
  ),
  handoffSkipSubcommands: kiloSubcommands(
    OPENCODE_SUBCOMMANDS.handoffSkip,
    KILO_ONLY_SUBCOMMANDS,
  ),
});
