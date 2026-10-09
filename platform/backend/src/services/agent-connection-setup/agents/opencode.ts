import {
  DEFAULT_MODELS,
  EXTERNAL_AGENT_ID_HEADER,
  OPENCODE_CLIENT_ID,
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  openCodePassthroughBaseUrl,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { OPENCODE_GUARD_CLIENT } from "../guard/clients";
import {
  OPENCODE_PRIMARY_CONFIG_SCRIPT,
  openCodePrimaryConfig,
} from "../payloads/opencode-primary-config";
import {
  renderOpenCodeRoutingPlugin,
  renderOpenCodeRoutingPluginV2,
} from "../payloads/opencode-routing-plugin";
import { starterPrompt } from "../steps/ending";
import { legacyServerNames } from "../steps/mcp";
import { psq, sh } from "../steps/quoting";
import {
  withStartupGuardBash,
  withStartupGuardPowerShell,
} from "../steps/startup-guard";
import type {
  AgentEnding,
  SetupScriptContext,
  SetupScriptProxySection,
  ShellAgentSetup,
} from "../types";

// OpenCode setup. Shared helpers and the config-merge payloads first, then the
// bash and PowerShell steps side by side, then the agent module the dispatcher
// in ../index.ts uses.

interface OpencodeProviderTarget {
  id: string;
  baseUrl: string;
  model: string;
}

/** Resolve the native OpenCode provider id and matching Archestra wire URL. */
function opencodeProviderTarget(
  ctx: SetupScriptContext,
): OpencodeProviderTarget {
  const proxy = ctx.proxy as SetupScriptProxySection;
  const route = OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.find(
    (candidate) => candidate.provider === proxy.provider,
  );
  if (!route) {
    throw new Error(
      `OpenCode does not support ${proxy.provider} through local credential passthrough`,
    );
  }
  return {
    id: route.openCodeProviderId,
    baseUrl: openCodePassthroughBaseUrl(proxy.baseUrl, route),
    model: proxy.model ?? DEFAULT_MODELS[proxy.provider],
  };
}

/** Headers OpenCode sends on every proxied request (attribution). */
function opencodeProxyHeaders(
  proxy: SetupScriptProxySection,
): Record<string, string> {
  const headers: Record<string, string> = {
    [EXTERNAL_AGENT_ID_HEADER]: OPENCODE_CLIENT_ID,
  };
  if (proxy.passthroughVirtualKey) {
    headers[VIRTUAL_KEY_HEADER] = proxy.passthroughVirtualKey;
  }
  return headers;
}

const OPENCODE_OWNED_MERGE_NODE = `const fs = require("fs");
const os = require("os");
const path = require("path");
const configPath = process.env.ARCHESTRA_OC_CONFIG_PATH;
const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
const cfg = raw.trim() ? JSON.parse(raw) : {};
const backupPath = configPath + ".archestra-backup";
if (fs.existsSync(configPath) && !fs.existsSync(backupPath)) fs.copyFileSync(configPath, backupPath);
cfg.$schema ??= "https://opencode.ai/config.json";
if (process.env.ARCHESTRA_OC_MCP_NAME) {
  cfg.mcp ??= {};
  // Move, not add: an entry left by an earlier connect run points at this same
  // gateway, so it is dropped rather than left beside the new one.
  for (const legacy of JSON.parse(process.env.ARCHESTRA_OC_MCP_LEGACY_NAMES || "[]")) delete cfg.mcp[legacy];
  cfg.mcp[process.env.ARCHESTRA_OC_MCP_NAME] = { type: "remote", url: process.env.ARCHESTRA_OC_MCP_URL };
}
const managedHeaders = JSON.parse(process.env.ARCHESTRA_OC_HEADERS || "{}");
const routes = JSON.parse(process.env.ARCHESTRA_OC_PROVIDER_ROUTES || "{}");
const runtimeRouting = process.env.ARCHESTRA_OC_RUNTIME_ROUTING === "1";
const providers = cfg.provider && typeof cfg.provider === "object" ? cfg.provider : {};
const statePath = path.join(process.env.HOME || os.homedir(), ".archestra", "opencode-connection-state.json");
if (runtimeRouting) {
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const [providerId, previous] of Object.entries(state.providerState || {})) {
      if (previous === null) delete providers[providerId];
      else providers[providerId] = previous;
    }
    if (state.enabledProvidersPresent) cfg.enabled_providers = state.enabledProviders;
    else delete cfg.enabled_providers;
    if (state.disabledProvidersPresent) cfg.disabled_providers = state.disabledProviders;
    else delete cfg.disabled_providers;
    fs.rmSync(statePath, { force: true });
  } else {
    for (const [providerId, expectedUrl] of Object.entries(routes)) {
      const entry = providers[providerId];
      const options = entry?.options;
      if (!options || typeof options !== "object") continue;
      if (options.baseURL === expectedUrl) delete options.baseURL;
      if (options.headers && typeof options.headers === "object") {
        for (const [name, value] of Object.entries(managedHeaders)) {
          if (options.headers[name] === value) delete options.headers[name];
        }
        if (Object.keys(options.headers).length === 0) delete options.headers;
      }
      if (Object.keys(options).length === 0) delete entry.options;
      if (Object.keys(entry).length === 0) delete providers[providerId];
    }
  }
  if (Object.keys(providers).length > 0) cfg.provider = providers;
  else delete cfg.provider;
}
const legacyModel = process.env.ARCHESTRA_OC_LEGACY_MODEL;
if (legacyModel && cfg.model === legacyModel) delete cfg.model;
const providerId = process.env.ARCHESTRA_OC_PROVIDER_ID;
const routeIds = Object.keys(routes);
const enabledProviderIds = runtimeRouting ? [] : routeIds.length > 0 ? routeIds : providerId ? [providerId] : [];
if (enabledProviderIds.length > 0) {
  if (!fs.existsSync(statePath)) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      enabledProvidersPresent: Object.hasOwn(cfg, "enabled_providers"),
      enabledProviders: cfg.enabled_providers,
      disabledProvidersPresent: Object.hasOwn(cfg, "disabled_providers"),
      disabledProviders: cfg.disabled_providers,
      providerState: Object.fromEntries(enabledProviderIds.map((id) => [id, providers[id] ?? null])),
    }, null, 2) + "\\n", { mode: 0o600 });
  }
  cfg.enabled_providers = enabledProviderIds;
  const disabled = (cfg.disabled_providers || []).filter((id) => !enabledProviderIds.includes(id));
  if (disabled.length > 0) cfg.disabled_providers = disabled;
  else delete cfg.disabled_providers;
}
if (!runtimeRouting) {
  for (const [id, baseURL] of Object.entries(routes)) {
    const entry = providers[id] && typeof providers[id] === "object" ? providers[id] : {};
    const options = entry.options && typeof entry.options === "object" ? entry.options : {};
    options.baseURL = baseURL;
    options.headers = { ...(options.headers || {}), ...managedHeaders };
    entry.options = options;
    providers[id] = entry;
  }
}
if (providerId) {
  const entry = providers[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : {};
  if (process.env.ARCHESTRA_OC_NPM) {
    entry.npm = process.env.ARCHESTRA_OC_NPM;
    entry.name = process.env.ARCHESTRA_OC_NAME;
    entry.models = { [process.env.ARCHESTRA_OC_MODEL]: {} };
  }
  const options = entry.options && typeof entry.options === "object" ? entry.options : {};
  options.baseURL = process.env.ARCHESTRA_OC_BASE_URL;
  options.headers = { ...(options.headers || {}), ...managedHeaders };
  if (process.env.ARCHESTRA_OC_API_KEY_REF) options.apiKey = process.env.ARCHESTRA_OC_API_KEY_REF;
  entry.options = options;
  providers[providerId] = entry;
  cfg.provider = providers;
}
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\\n");
console.log("Updated " + configPath);`;

// Key-scoped merge into OpenCode's documented global config. Authentication is
// stored separately by OpenCode, so existing local keys and subscriptions stay
// on the machine; only provider routes change.
// Values arrive via env.
const OPENCODE_OWNED_MERGE_PY = `import json, os, pathlib, shutil
path = pathlib.Path(os.environ["ARCHESTRA_OC_CONFIG_PATH"])
raw = path.read_text() if path.exists() else ""
cfg = json.loads(raw) if raw.strip() else {}
backup = path.with_name(path.name + ".archestra-backup")
if path.exists() and not backup.exists():
    shutil.copy2(path, backup)
cfg.setdefault("$schema", "https://opencode.ai/config.json")
if os.environ.get("ARCHESTRA_OC_MCP_NAME"):
    servers = cfg.setdefault("mcp", {})
    # Move, not add: an entry left by an earlier connect run points at this
    # same gateway, so it is dropped rather than left beside the new one.
    for legacy in json.loads(os.environ.get("ARCHESTRA_OC_MCP_LEGACY_NAMES", "[]")): servers.pop(legacy, None)
    servers[os.environ["ARCHESTRA_OC_MCP_NAME"]] = {"type": "remote", "url": os.environ["ARCHESTRA_OC_MCP_URL"]}
managed_headers = json.loads(os.environ.get("ARCHESTRA_OC_HEADERS", "{}"))
routes = json.loads(os.environ.get("ARCHESTRA_OC_PROVIDER_ROUTES", "{}"))
runtime_routing = os.environ.get("ARCHESTRA_OC_RUNTIME_ROUTING") == "1"
providers = cfg.get("provider") if isinstance(cfg.get("provider"), dict) else {}
state_path = pathlib.Path(os.path.expanduser("~/.archestra/opencode-connection-state.json"))
if runtime_routing:
    if state_path.exists():
        state = json.loads(state_path.read_text())
        for provider_id, previous in (state.get("providerState") or {}).items():
            if previous is None: providers.pop(provider_id, None)
            else: providers[provider_id] = previous
        if state.get("enabledProvidersPresent"): cfg["enabled_providers"] = state.get("enabledProviders")
        else: cfg.pop("enabled_providers", None)
        if state.get("disabledProvidersPresent"): cfg["disabled_providers"] = state.get("disabledProviders")
        else: cfg.pop("disabled_providers", None)
        state_path.unlink()
    else:
        for provider_id, expected_url in routes.items():
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
    if providers: cfg["provider"] = providers
    else: cfg.pop("provider", None)
else:
    cfg["provider"] = providers
legacy_model = os.environ.get("ARCHESTRA_OC_LEGACY_MODEL")
if legacy_model and cfg.get("model") == legacy_model:
    cfg.pop("model", None)
enabled_provider_ids = [] if runtime_routing else (list(routes) or ([os.environ["ARCHESTRA_OC_PROVIDER_ID"]] if os.environ.get("ARCHESTRA_OC_PROVIDER_ID") else []))
if enabled_provider_ids:
    if not state_path.exists():
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({
            "enabledProvidersPresent": "enabled_providers" in cfg,
            "enabledProviders": cfg.get("enabled_providers"),
            "disabledProvidersPresent": "disabled_providers" in cfg,
            "disabledProviders": cfg.get("disabled_providers"),
            "providerState": {provider_id: providers.get(provider_id) for provider_id in enabled_provider_ids},
        }, indent=2) + "\\n")
        state_path.chmod(0o600)
    cfg["enabled_providers"] = enabled_provider_ids
    disabled = [provider_id for provider_id in (cfg.get("disabled_providers") or []) if provider_id not in enabled_provider_ids]
    if disabled: cfg["disabled_providers"] = disabled
    else: cfg.pop("disabled_providers", None)
if not runtime_routing:
    for provider_id, base_url in routes.items():
        entry = providers.get(provider_id) if isinstance(providers.get(provider_id), dict) else {}
        options = entry.get("options") if isinstance(entry.get("options"), dict) else {}
        headers = options.get("headers") if isinstance(options.get("headers"), dict) else {}
        options["baseURL"] = base_url
        options["headers"] = {**headers, **managed_headers}
        entry["options"] = options
        providers[provider_id] = entry
if os.environ.get("ARCHESTRA_OC_PROVIDER_ID"):
    provider_id = os.environ["ARCHESTRA_OC_PROVIDER_ID"]
    entry = providers.get(provider_id) if isinstance(providers.get(provider_id), dict) else {}
    if os.environ.get("ARCHESTRA_OC_NPM"):
        entry["npm"] = os.environ["ARCHESTRA_OC_NPM"]
        entry["name"] = os.environ["ARCHESTRA_OC_NAME"]
        entry["models"] = {os.environ["ARCHESTRA_OC_MODEL"]: {}}
    options = entry.get("options") if isinstance(entry.get("options"), dict) else {}
    headers = options.get("headers") if isinstance(options.get("headers"), dict) else {}
    options["baseURL"] = os.environ["ARCHESTRA_OC_BASE_URL"]
    options["headers"] = {**headers, **managed_headers}
    if os.environ.get("ARCHESTRA_OC_API_KEY_REF"):
        options["apiKey"] = os.environ["ARCHESTRA_OC_API_KEY_REF"]
    entry["options"] = options
    providers[provider_id] = entry
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(cfg, indent=2) + "\\n")
print(f"Updated {path}")`;

const OPENCODE_EFFECTIVE_BASE_URL_PY = `import json, os, sys
try:
    d = json.load(sys.stdin)
    print(d.get("provider", {}).get(os.environ["ARCHESTRA_OC_PROVIDER_ID"], {}).get("options", {}).get("baseURL", ""))
except Exception:
    print("")`;

const OPENCODE_EFFECTIVE_ROUTES_PY = `import json, os, sys
try:
    cfg = json.load(sys.stdin)
    expected = json.loads(os.environ["ARCHESTRA_OC_PROVIDER_ROUTES"])
    providers = cfg.get("provider", {})
    enabled = set(cfg.get("enabled_providers") or [])
    for provider_id, base_url in expected.items():
        if provider_id not in enabled: continue
        actual = providers.get(provider_id, {}).get("options", {}).get("baseURL")
        if actual != base_url:
            print(f"{provider_id}={actual or 'unset'}")
except Exception as error:
    print(str(error))`;

function opencodeOwnedMergeBash(
  env: Record<string, string>,
  manual: string,
): string {
  const exports = Object.entries(env)
    .map(([key, value]) => `  export ${key}=${sh(value)}`)
    .join("\n");
  return `if command -v node >/dev/null 2>&1; then
  export ARCHESTRA_OC_CONFIG_PATH="$ARCHESTRA_OPENCODE_CONFIG"
${exports}
  node -e ${sh(OPENCODE_OWNED_MERGE_NODE)}
elif command -v python3 >/dev/null 2>&1; then
  export ARCHESTRA_OC_CONFIG_PATH="$ARCHESTRA_OPENCODE_CONFIG"
${exports}
  python3 - <<'ARCHESTRA_PY'
${OPENCODE_OWNED_MERGE_PY}
ARCHESTRA_PY
else
  warn "python3 not found — add this to $ARCHESTRA_OPENCODE_CONFIG yourself:"
  cat <<'ARCHESTRA_MANUAL'
${manual}
ARCHESTRA_MANUAL
fi`;
}

/**
 * PowerShell twin of the bash OpenCode sections: the same owned
 * ~/.config/opencode/opencode.json, written BOM-free (Windows PowerShell 5.1's
 * `Set-Content -Encoding utf8` adds a BOM), the same key file and skills clone.
 */
function opencodeProviderMergePowerShell(params: {
  providerId: string;
  baseUrl: string;
  headers: Record<string, string>;
  apiKeyRef?: string;
  customEntry?: string;
}): string {
  const headerLines = Object.entries(params.headers)
    .map(
      ([key, value]) => `Set-ArchProp $archHeaders ${psq(key)} ${psq(value)}`,
    )
    .join("\n");
  return `$archEntryProperty = $archCfg.provider.PSObject.Properties[${psq(params.providerId)}]
$archEntry = if ($archEntryProperty) { $archEntryProperty.Value } else { [pscustomobject]@{} }
$archOptionsProperty = $archEntry.PSObject.Properties['options']
$archOptions = if ($archOptionsProperty) { $archOptionsProperty.Value } else { [pscustomobject]@{} }
$archHeadersProperty = $archOptions.PSObject.Properties['headers']
$archHeaders = if ($archHeadersProperty) { $archHeadersProperty.Value } else { [pscustomobject]@{} }
${headerLines}
Set-ArchProp $archOptions 'baseURL' ${psq(params.baseUrl)}
Set-ArchProp $archOptions 'headers' $archHeaders
${params.apiKeyRef ? `Set-ArchProp $archOptions 'apiKey' ${psq(params.apiKeyRef)}` : ""}
${params.customEntry ?? ""}
Set-ArchProp $archEntry 'options' $archOptions
Set-ArchProp $archCfg.provider ${psq(params.providerId)} $archEntry`;
}

function opencodeRoutingPluginBash(params: {
  routes: Record<string, string>;
  headers: Record<string, string>;
}): string {
  const encoded = Buffer.from(
    renderOpenCodeRoutingPlugin(params),
    "utf8",
  ).toString("base64");
  const encodedV2 = Buffer.from(
    renderOpenCodeRoutingPluginV2(params),
    "utf8",
  ).toString("base64");
  const python = `import base64, json, pathlib, sys
plugin, state = map(pathlib.Path, sys.argv[1:3])
content = sys.argv[3]
if not state.exists():
    existed = plugin.exists()
    previous = base64.b64encode(plugin.read_bytes()).decode() if existed else None
    state.write_text(json.dumps({"existed": existed, "contentBase64": previous}) + "\\n")
    state.chmod(0o600)
plugin.write_bytes(base64.b64decode(content))
plugin.chmod(0o600)`;
  return `ARCHESTRA_OC_PLUGIN="$(dirname "$ARCHESTRA_OPENCODE_CONFIG")/plugins/archestra-llm-proxy.js"
ARCHESTRA_OC_PLUGIN_STATE="$HOME/.archestra/opencode-routing-plugin-state.json"
mkdir -p "$(dirname "$ARCHESTRA_OC_PLUGIN")"
mkdir -p "$(dirname "$ARCHESTRA_OC_PLUGIN_STATE")"
# OpenCode 2 loads only its own plugin API, so install the variant that matches.
if [ "$ARCHESTRA_OPENCODE_MAJOR" -ge 2 ]; then
  ARCHESTRA_OC_PLUGIN_CONTENT=${sh(encodedV2)}
else
  ARCHESTRA_OC_PLUGIN_CONTENT=${sh(encoded)}
fi
if command -v node >/dev/null 2>&1; then
  node -e 'const fs=require("node:fs"); const [plugin,state,content]=process.argv.slice(1); if(!fs.existsSync(state)){const existed=fs.existsSync(plugin); const previous=existed?fs.readFileSync(plugin).toString("base64"):null; fs.writeFileSync(state,JSON.stringify({existed,contentBase64:previous})+"\\n",{mode:0o600});} fs.writeFileSync(plugin,Buffer.from(content,"base64"),{mode:0o600});' "$ARCHESTRA_OC_PLUGIN" "$ARCHESTRA_OC_PLUGIN_STATE" "$ARCHESTRA_OC_PLUGIN_CONTENT"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c ${sh(python)} "$ARCHESTRA_OC_PLUGIN" "$ARCHESTRA_OC_PLUGIN_STATE" "$ARCHESTRA_OC_PLUGIN_CONTENT"
else
  err "Node.js or python3 is required to install the OpenCode routing guard"
  exit 1
fi
ok "Installed the OpenCode LLM proxy routing guard"`;
}

function opencodeRoutingPluginPowerShell(params: {
  routes: Record<string, string>;
  headers: Record<string, string>;
}): string {
  const encoded = Buffer.from(
    renderOpenCodeRoutingPlugin(params),
    "utf8",
  ).toString("base64");
  const encodedV2 = Buffer.from(
    renderOpenCodeRoutingPluginV2(params),
    "utf8",
  ).toString("base64");
  return `$archPluginDir = Join-Path $archOcDir 'plugins'
$archPluginFile = Join-Path $archPluginDir 'archestra-llm-proxy.js'
$archPluginState = Join-Path $env:USERPROFILE '.archestra/opencode-routing-plugin-state.json'
$null = New-Item -ItemType Directory -Force -Path $archPluginDir
if (-not (Test-Path $archPluginState)) {
  $archExistingPlugin = Test-Path $archPluginFile
  $archPluginBackup = if ($archExistingPlugin) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($archPluginFile)) } else { $null }
  $archPluginStateValue = [pscustomobject]@{ existed = $archExistingPlugin; contentBase64 = $archPluginBackup }
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archPluginState)
  [IO.File]::WriteAllText($archPluginState, ($archPluginStateValue | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
}
# OpenCode 2 loads only its own plugin API, so install the variant that matches.
$archPluginContent = if ($archOcMajor -ge 2) { ${psq(encodedV2)} } else { ${psq(encoded)} }
[IO.File]::WriteAllBytes($archPluginFile, [Convert]::FromBase64String($archPluginContent))
Ok 'Installed the OpenCode LLM proxy routing guard'`;
}

function opencodeBashSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [
    `ARCHESTRA_OPENCODE_CONFIG="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
# OpenCode 2 changed its plugin API and \`debug config\` output; steps below branch on it.
ARCHESTRA_OPENCODE_MAJOR="$( { opencode --version 2>/dev/null || true; } </dev/null | sed -n '1s/^[^0-9]*\\([0-9][0-9]*\\)\\..*$/\\1/p')"
[ -n "$ARCHESTRA_OPENCODE_MAJOR" ] || ARCHESTRA_OPENCODE_MAJOR=1`,
  ];

  if (ctx.proxy && !ctx.proxy.primaryProviders) {
    sections.push(`if [ -f "$HOME/.archestra/opencode-primary-state.json" ]; then
  ARCHESTRA_OC_PRIMARY=null node -e ${sh(OPENCODE_PRIMARY_CONFIG_SCRIPT)}
fi`);
  }

  if (ctx.mcp) {
    sections.push(`say ${sh(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
${opencodeOwnedMergeBash(
  {
    ARCHESTRA_OC_MCP_NAME: ctx.mcp.serverName,
    ARCHESTRA_OC_MCP_URL: ctx.mcp.url,
    ARCHESTRA_OC_MCP_LEGACY_NAMES: JSON.stringify(legacyServerNames(ctx.mcp)),
    ARCHESTRA_OC_PROVIDER_ID: "",
  },
  JSON.stringify(
    { mcp: { [ctx.mcp.serverName]: { type: "remote", url: ctx.mcp.url } } },
    null,
    2,
  ),
)}`);
  }

  if (ctx.proxy) {
    if (ctx.proxy.primaryProviders) {
      const { routes, providers } = openCodePrimaryConfig(ctx.proxy);
      sections.push(`say "Configuring model providers in OpenCode"
command -v node >/dev/null 2>&1 || { err "Node.js is required to configure model providers"; exit 1; }
ARCHESTRA_OC_MAJOR="$ARCHESTRA_OPENCODE_MAJOR" ARCHESTRA_OC_KEY=${sh(ctx.proxy.virtualKey ?? "")} ARCHESTRA_OC_PRIMARY=stdin node -e ${sh(OPENCODE_PRIMARY_CONFIG_SCRIPT)} <<'ARCHESTRA_PRIMARY_CATALOG'
${JSON.stringify({ providers })}
ARCHESTRA_PRIMARY_CATALOG
${opencodeRoutingPluginBash({ routes, headers: opencodeProxyHeaders(ctx.proxy) })}`);
    } else if (ctx.proxy.authMode === "provider-key") {
      const routes = Object.fromEntries(
        OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => [
          route.openCodeProviderId,
          openCodePassthroughBaseUrl(ctx.proxy?.baseUrl ?? "", route),
        ]),
      );
      const headers = opencodeProxyHeaders(ctx.proxy);
      const legacyTarget = opencodeProviderTarget(ctx);
      const manual =
        "The routing plugin is installed. Node.js or Python is required to remove provider settings left by an older connection.";
      sections.push(`say "Routing supported OpenCode providers through the LLM proxy"
${opencodeRoutingPluginBash({ routes, headers })}
${opencodeOwnedMergeBash(
  {
    ARCHESTRA_OC_MCP_NAME: "",
    ARCHESTRA_OC_PROVIDER_ID: "",
    ARCHESTRA_OC_PROVIDER_ROUTES: JSON.stringify(routes),
    ARCHESTRA_OC_RUNTIME_ROUTING: "1",
    ARCHESTRA_OC_LEGACY_MODEL: `${legacyTarget.id}/${legacyTarget.model}`,
    ARCHESTRA_OC_HEADERS: JSON.stringify(headers),
  },
  manual,
)}
if [ "$ARCHESTRA_OPENCODE_MAJOR" -lt 2 ] && command -v python3 >/dev/null 2>&1; then
  EFFECTIVE_CONFIG=$(cd "$HOME" && opencode debug config 2>/dev/null || true)
  ROUTE_MISMATCHES=$(printf '%s' "$EFFECTIVE_CONFIG" | ARCHESTRA_OC_PROVIDER_ROUTES=${sh(JSON.stringify(routes))} python3 -c ${sh(OPENCODE_EFFECTIVE_ROUTES_PY)} || true)
  if [ -z "$ROUTE_MISMATCHES" ]; then
    ok "OpenCode's credentialed native providers resolve through the LLM proxy"
  else
    warn "Another OpenCode config overrides these provider routes: $ROUTE_MISMATCHES"
  fi
fi`);
    } else {
      const target = opencodeProviderTarget(ctx);
      const apiKeyRef = ctx.proxy.virtualKey
        ? `{file:~/.archestra/opencode-${target.id}.key}`
        : "";
      const writeKey = ctx.proxy.virtualKey
        ? `
ARCHESTRA_VIRTUAL_KEY=${sh(ctx.proxy.virtualKey)}
mkdir -p "$HOME/.archestra"
( umask 077; printf '%s' "$ARCHESTRA_VIRTUAL_KEY" > "$HOME/.archestra/opencode-${target.id}.key" )
echo "Stored the virtual key in $HOME/.archestra/opencode-${target.id}.key"`
        : "";
      sections.push(`say ${sh(`Routing OpenCode's "${target.id}" provider through the LLM proxy`)}${writeKey}
${opencodeRoutingPluginBash({
  routes: { [target.id]: target.baseUrl },
  headers: opencodeProxyHeaders(ctx.proxy),
})}
${opencodeOwnedMergeBash(
  {
    ARCHESTRA_OC_MCP_NAME: "",
    ARCHESTRA_OC_PROVIDER_ID: target.id,
    ARCHESTRA_OC_BASE_URL: target.baseUrl,
    ARCHESTRA_OC_NPM: "",
    ARCHESTRA_OC_NAME: "",
    ARCHESTRA_OC_MODEL: "",
    ARCHESTRA_OC_HEADERS: JSON.stringify(opencodeProxyHeaders(ctx.proxy)),
    ARCHESTRA_OC_API_KEY_REF: apiKeyRef,
  },
  JSON.stringify(
    {
      enabled_providers: [target.id],
      provider: { [target.id]: { options: { baseURL: target.baseUrl } } },
    },
    null,
    2,
  ),
)}
if [ "$ARCHESTRA_OPENCODE_MAJOR" -lt 2 ] && command -v python3 >/dev/null 2>&1; then
  EFFECTIVE_CONFIG=$(cd "$HOME" && opencode debug config 2>/dev/null || true)
  EFFECTIVE_BASE_URL=$(printf '%s' "$EFFECTIVE_CONFIG" | ARCHESTRA_OC_PROVIDER_ID=${sh(target.id)} python3 -c ${sh(OPENCODE_EFFECTIVE_BASE_URL_PY)} || true)
  if [ "$EFFECTIVE_BASE_URL" = ${sh(target.baseUrl)} ]; then
    ok ${sh(`OpenCode resolves "${target.id}" through the LLM proxy`)}
  else
    warn "Another OpenCode config overrides provider.${target.id}.options.baseURL (resolved: \${EFFECTIVE_BASE_URL:-unset}). Remove that override to use the proxy."
  fi
fi`);
    }
  }

  if (ctx.skills) {
    sections.push(`say ${sh(`Installing the "${ctx.skills.marketplaceName}" skills`)}
SKILLS_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/${ctx.skills.marketplaceName}"
if ! command -v git >/dev/null 2>&1; then
  warn "git not found — clone the marketplace into $SKILLS_DIR yourself."
elif [ -d "$SKILLS_DIR/.git" ]; then
  git -C "$SKILLS_DIR" remote set-url origin ${sh(ctx.skills.cloneUrl)}
  git -C "$SKILLS_DIR" pull --ff-only -q || warn "Could not update $SKILLS_DIR."
else
  mkdir -p "$(dirname "$SKILLS_DIR")"
  git clone -q ${sh(ctx.skills.cloneUrl)} "$SKILLS_DIR" || warn "Could not clone the marketplace into $SKILLS_DIR."
fi
echo "Skills folder: $SKILLS_DIR"`);
  }

  if (ctx.mcp) {
    sections.push(`say "OpenCode MCP servers"
cli opencode mcp list || true`);
  }
  return withStartupGuardBash(ctx, OPENCODE_GUARD_CLIENT, sections);
}

function opencodePowerShellSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [
    `$archOcDir = if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'opencode' } else { Join-Path $env:USERPROFILE '.config/opencode' }
$archOcFile = Join-Path $archOcDir 'opencode.json'
# OpenCode 2 changed its plugin API and \`debug config\` output; steps below branch on it.
$archOcMajor = 1
try { if ((& opencode --version 2>$null | Out-String) -match '(\\d+)\\.\\d+') { $archOcMajor = [int]$Matches[1] } } catch { }
function Read-ArchOcOwned {
  if (Test-Path $archOcFile) {
    $raw = Get-Content -Raw -Path $archOcFile
    if ($raw -and $raw.Trim()) { return ($raw | ConvertFrom-Json) }
  }
  return [pscustomobject]@{ '$schema' = 'https://opencode.ai/config.json' }
}
function Write-ArchOcOwned($cfg) {
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archOcFile)
  $archBackup = $archOcFile + '.archestra-backup'
  if ((Test-Path $archOcFile) -and -not (Test-Path $archBackup)) { Copy-Item -Path $archOcFile -Destination $archBackup }
  [IO.File]::WriteAllText($archOcFile, ($cfg | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false))
  Write-Host ('Updated ' + $archOcFile)
}
function Set-ArchProp($obj, $name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value } else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}
function Enable-ArchOcProviders($cfg, [string[]]$providerIds) {
  $archStateFile = Join-Path $env:USERPROFILE '.archestra/opencode-connection-state.json'
  if (-not (Test-Path $archStateFile)) {
    $enabled = $cfg.PSObject.Properties['enabled_providers']
    $disabled = $cfg.PSObject.Properties['disabled_providers']
    $providerState = [pscustomobject]@{}
    foreach ($providerId in $providerIds) {
      $providerEntry = if ($cfg.PSObject.Properties['provider']) { $cfg.provider.PSObject.Properties[$providerId] } else { $null }
      $providerState | Add-Member -NotePropertyName $providerId -NotePropertyValue $(if ($providerEntry) { $providerEntry.Value } else { $null })
    }
    $state = [pscustomobject]@{
      enabledProvidersPresent = [bool]$enabled
      enabledProviders = if ($enabled) { @($enabled.Value) } else { $null }
      disabledProvidersPresent = [bool]$disabled
      disabledProviders = if ($disabled) { @($disabled.Value) } else { $null }
      providerState = $providerState
    }
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archStateFile)
    [IO.File]::WriteAllText($archStateFile, ($state | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
  }
  Set-ArchProp $cfg 'enabled_providers' @($providerIds)
  $disabled = $cfg.PSObject.Properties['disabled_providers']
  if ($disabled) {
    $remaining = @($disabled.Value | Where-Object { $_ -notin $providerIds })
    if ($remaining.Count -gt 0) { Set-ArchProp $cfg 'disabled_providers' $remaining }
    else { $cfg.PSObject.Properties.Remove('disabled_providers') }
  }
}`,
  ];

  if (ctx.mcp) {
    sections.push(`Say ${psq(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
$archCfg = Read-ArchOcOwned
if (-not $archCfg.PSObject.Properties['mcp']) { Set-ArchProp $archCfg 'mcp' ([pscustomobject]@{}) }
foreach ($archLegacy in @(${legacyServerNames(ctx.mcp).map(psq).join(", ") || "''"})) {
  if ($archLegacy -and $archCfg.mcp.PSObject.Properties[$archLegacy]) { $archCfg.mcp.PSObject.Properties.Remove($archLegacy) }
}
Set-ArchProp $archCfg.mcp ${psq(ctx.mcp.serverName)} ([pscustomobject]@{ type = 'remote'; url = ${psq(ctx.mcp.url)} })
Write-ArchOcOwned $archCfg`);
  }

  if (ctx.proxy && !ctx.proxy.primaryProviders) {
    sections.push(`if (Test-Path (Join-Path $env:USERPROFILE '.archestra/opencode-primary-state.json')) {
$archPrimaryRestore = @'
${OPENCODE_PRIMARY_CONFIG_SCRIPT}
'@
$env:ARCHESTRA_OC_PRIMARY = 'null'
try { $archPrimaryRestore | & node -; if ($LASTEXITCODE -ne 0) { throw 'Could not restore previous provider configuration' } }
finally { Remove-Item Env:ARCHESTRA_OC_PRIMARY -ErrorAction SilentlyContinue }
}`);
  }
  if (ctx.proxy) {
    if (ctx.proxy.primaryProviders) {
      const { routes, providers } = openCodePrimaryConfig(ctx.proxy);
      sections.push(`Say 'Configuring model providers in OpenCode'
$env:ARCHESTRA_OC_MAJOR = [string]$archOcMajor
$env:ARCHESTRA_OC_KEY = ${psq(ctx.proxy.virtualKey ?? "")}
$env:ARCHESTRA_OC_PRIMARY = 'stdin'
$archPrimaryCatalog = ${psq(JSON.stringify({ providers }))}
$archPrimaryScript = @'
${OPENCODE_PRIMARY_CONFIG_SCRIPT}
'@
try { $archPrimaryCatalog | & node -e $archPrimaryScript; if ($LASTEXITCODE -ne 0) { throw 'Could not configure model providers' } }
finally { Remove-Item Env:ARCHESTRA_OC_KEY, Env:ARCHESTRA_OC_PRIMARY, Env:ARCHESTRA_OC_MAJOR -ErrorAction SilentlyContinue }
${opencodeRoutingPluginPowerShell({ routes, headers: opencodeProxyHeaders(ctx.proxy) })}`);
    } else if (ctx.proxy.authMode === "provider-key") {
      const headers = opencodeProxyHeaders(ctx.proxy);
      const legacyTarget = opencodeProviderTarget(ctx);
      const routes = Object.fromEntries(
        OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => [
          route.openCodeProviderId,
          openCodePassthroughBaseUrl(ctx.proxy?.baseUrl ?? "", route),
        ]),
      );
      const cleanup = OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => {
        const providerId = psq(route.openCodeProviderId);
        const expected = psq(
          openCodePassthroughBaseUrl(ctx.proxy?.baseUrl ?? "", route),
        );
        const managedHeaders = Object.entries(headers)
          .map(
            ([name, value]) =>
              `      if ($archHeaders.PSObject.Properties[${psq(name)}] -and $archHeaders.${psq(name)} -eq ${psq(value)}) { $archHeaders.PSObject.Properties.Remove(${psq(name)}) }`,
          )
          .join("\n");
        return `$archEntryProp = $archCfg.provider.PSObject.Properties[${providerId}]
  if ($archEntryProp -and $archEntryProp.Value.PSObject.Properties['options']) {
    $archOptions = $archEntryProp.Value.options
    if ($archOptions.PSObject.Properties['baseURL'] -and $archOptions.baseURL -eq ${expected}) { $archOptions.PSObject.Properties.Remove('baseURL') }
    $archHeadersProp = $archOptions.PSObject.Properties['headers']
    if ($archHeadersProp) {
      $archHeaders = $archHeadersProp.Value
${managedHeaders}
      if (@($archHeaders.PSObject.Properties).Count -eq 0) { $archOptions.PSObject.Properties.Remove('headers') }
    }
    if (@($archOptions.PSObject.Properties).Count -eq 0) { $archEntryProp.Value.PSObject.Properties.Remove('options') }
    if (@($archEntryProp.Value.PSObject.Properties).Count -eq 0) { $archCfg.provider.PSObject.Properties.Remove(${providerId}) }
  }`;
      }).join("\n");
      sections.push(`Say 'Routing supported OpenCode providers through the LLM proxy'
${opencodeRoutingPluginPowerShell({ routes, headers })}
$archCfg = Read-ArchOcOwned
if (-not $archCfg.PSObject.Properties['provider']) { Set-ArchProp $archCfg 'provider' ([pscustomobject]@{}) }
if ($archCfg.PSObject.Properties['model'] -and $archCfg.model -eq ${psq(`${legacyTarget.id}/${legacyTarget.model}`)}) { $archCfg.PSObject.Properties.Remove('model') }
$archStateFile = Join-Path $env:USERPROFILE '.archestra/opencode-connection-state.json'
if (Test-Path $archStateFile) {
  $archState = Get-Content -Raw -Path $archStateFile | ConvertFrom-Json
  if ($archState.PSObject.Properties['providerState']) {
    foreach ($archSavedProvider in $archState.providerState.PSObject.Properties) {
      if ($null -ne $archSavedProvider.Value) { Set-ArchProp $archCfg.provider $archSavedProvider.Name $archSavedProvider.Value }
      else { $archCfg.provider.PSObject.Properties.Remove($archSavedProvider.Name) }
    }
  }
  if ($archState.enabledProvidersPresent) { Set-ArchProp $archCfg 'enabled_providers' @($archState.enabledProviders) }
  else { $archCfg.PSObject.Properties.Remove('enabled_providers') }
  if ($archState.disabledProvidersPresent) { Set-ArchProp $archCfg 'disabled_providers' @($archState.disabledProviders) }
  else { $archCfg.PSObject.Properties.Remove('disabled_providers') }
  Remove-Item -Force $archStateFile
} else {
${cleanup}
}
if (@($archCfg.provider.PSObject.Properties).Count -eq 0) { $archCfg.PSObject.Properties.Remove('provider') }
Write-ArchOcOwned $archCfg
Ok "OpenCode's credentialed native providers will resolve through the LLM proxy"`);
    } else {
      const target = opencodeProviderTarget(ctx);
      const apiKeyRef = ctx.proxy.virtualKey
        ? `{file:~/.archestra/opencode-${target.id}.key}`
        : "";
      const writeKey = ctx.proxy.virtualKey
        ? `
$ARCHESTRA_VIRTUAL_KEY = ${psq(ctx.proxy.virtualKey)}
$archKeyPath = Join-Path $env:USERPROFILE ${psq(`.archestra/opencode-${target.id}.key`)}
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archKeyPath)
[IO.File]::WriteAllText($archKeyPath, $ARCHESTRA_VIRTUAL_KEY, (New-Object System.Text.UTF8Encoding $false))
Write-Host ('Stored the virtual key in ' + $archKeyPath)`
        : "";
      sections.push(`Say ${psq(`Routing OpenCode's "${target.id}" provider through the LLM proxy`)}${writeKey}
${opencodeRoutingPluginPowerShell({
  routes: { [target.id]: target.baseUrl },
  headers: opencodeProxyHeaders(ctx.proxy),
})}
$archCfg = Read-ArchOcOwned
if (-not $archCfg.PSObject.Properties['provider']) { Set-ArchProp $archCfg 'provider' ([pscustomobject]@{}) }
Enable-ArchOcProviders $archCfg @(${psq(target.id)})
${opencodeProviderMergePowerShell({
  providerId: target.id,
  baseUrl: target.baseUrl,
  headers: opencodeProxyHeaders(ctx.proxy),
  apiKeyRef,
})}
Write-ArchOcOwned $archCfg
if ($archOcMajor -lt 2) {
  $archEffective = $null
  try {
    Push-Location $env:USERPROFILE
    $archResolved = (& opencode debug config 2>$null | Out-String) | ConvertFrom-Json
    $archEffective = $archResolved.provider.${psq(target.id)}.options.baseURL
  } catch { } finally { Pop-Location }
  if ($archEffective -eq ${psq(target.baseUrl)}) { Ok ${psq(`OpenCode resolves "${target.id}" through the LLM proxy`)} }
  else { Warn ('Another OpenCode config overrides provider.${target.id}.options.baseURL (resolved: ' + $archEffective + '). Remove that override to use the proxy.') }
}`);
    }
  }

  if (ctx.skills) {
    sections.push(`Say ${psq(`Installing the "${ctx.skills.marketplaceName}" skills`)}
$archSkillsDir = Join-Path $archOcDir ${psq(`skills/${ctx.skills.marketplaceName}`)}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Warn ('git not found — clone the marketplace into ' + $archSkillsDir + ' yourself.') }
elseif (Test-Path (Join-Path $archSkillsDir '.git')) {
  try { & git -C $archSkillsDir remote set-url origin ${psq(ctx.skills.cloneUrl)} 2>$null; & git -C $archSkillsDir pull --ff-only -q 2>$null } catch { }
  if ($LASTEXITCODE -ne 0) { Warn ('Could not update ' + $archSkillsDir) }
} else {
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archSkillsDir)
  try { & git clone -q ${psq(ctx.skills.cloneUrl)} $archSkillsDir 2>$null } catch { }
  if ($LASTEXITCODE -ne 0) { Warn ('Could not clone the marketplace into ' + $archSkillsDir) }
}
Write-Host ('Skills folder: ' + $archSkillsDir)`);
  }

  if (ctx.mcp) {
    sections.push(`Say 'OpenCode MCP servers'
try { & opencode mcp list 2>$null | Out-Host } catch { }`);
  }
  return withStartupGuardPowerShell(ctx, OPENCODE_GUARD_CLIENT, sections);
}

function opencodeEnding(ctx: SetupScriptContext): AgentEnding {
  let proxyDetail: string | undefined;
  if (ctx.proxy?.authMode === "primary-providers") {
    proxyDetail = `All usable primary providers are available in OpenCode’s model picker`;
  } else if (ctx.proxy?.primaryProviders) {
    proxyDetail = `${ctx.proxy.providerLabel} models are available in OpenCode’s model picker`;
  } else if (ctx.proxy?.authMode === "provider-key") {
    proxyDetail = `Providers you have signed in to in OpenCode now go through the ${ctx.appName} LLM proxy`;
  } else if (ctx.proxy) {
    const target = opencodeProviderTarget(ctx);
    proxyDetail = `Pick ${target.id}/${target.model} in OpenCode's model picker to use it`;
  }
  return {
    proxyDetail,
    parts:
      ctx.mcp || ctx.proxy || ctx.skills
        ? [
            {
              name: "Launch check",
              detail: "Runs each time you start opencode",
            },
          ]
        : [],
    signIn: ctx.mcp
      ? {
          command: ["opencode", "mcp", "auth", ctx.mcp.serverName],
          howTo: `Run opencode mcp auth ${ctx.mcp.serverName} and finish the sign-in in your browser.`,
        }
      : null,
    launch: ["opencode", "--prompt", starterPrompt(ctx)],
    notes:
      ctx.mcp || ctx.proxy || ctx.skills
        ? [
            "If OpenCode is already open, close it first so it picks up the new settings.",
          ]
        : [],
  };
}

export const opencodeSetup: ShellAgentSetup = {
  label: "OpenCode",
  binary: "opencode",
  bash: { sections: opencodeBashSections },
  powerShell: {
    sections: opencodePowerShellSections,
  },
  ending: opencodeEnding,
};
