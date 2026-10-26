import {
  EXTERNAL_AGENT_ID_HEADER,
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  openCodePassthroughBaseUrl,
  PROVIDER_MODEL_TIERS,
  type SupportedProvider,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { KILO_GUARD_CLIENT, OPENCODE_GUARD_CLIENT } from "../guard/clients";
import {
  KILO_CLIENT,
  OPENCODE_CLIENT,
  type OpenCodeFamilyClient,
} from "../opencode-family";
import { managedRuntimeInstall } from "../payloads/managed-runtime-install";
import { openCodeMcpMergeScript } from "../payloads/opencode-mcp-config";
import {
  type ManagedRuntimeCatalog,
  openCodePrimaryConfig,
  openCodePrimaryConfigScript,
} from "../payloads/opencode-primary-config";
import {
  renderOpenCodeRoutingPlugin,
  renderOpenCodeRoutingPluginV2,
} from "../payloads/opencode-routing-plugin";
import { starterPrompt } from "../steps/ending";
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

// Setup for OpenCode and Kilo Code (an OpenCode fork; see ../opencode-family).
// Shared helpers and the config-merge payloads first, then the bash and
// PowerShell steps side by side, then the agent modules the dispatcher in
// ../index.ts uses.

interface OpencodeProviderTarget {
  id: string;
  model: string;
}

/** Resolve the native OpenCode provider id and matching Archestra wire URL. */
function opencodeProviderTarget(
  client: OpenCodeFamilyClient,
  ctx: SetupScriptContext,
): OpencodeProviderTarget {
  const proxy = ctx.proxy as SetupScriptProxySection;
  const route = OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.find(
    (candidate) => candidate.provider === proxy.provider,
  );
  if (!route) {
    throw new Error(
      `${client.label} does not support ${proxy.provider} through local credential passthrough`,
    );
  }
  return {
    id: route.openCodeProviderId,
    model: proxy.model ?? PROVIDER_MODEL_TIERS[proxy.provider].normal,
  };
}

/**
 * The global model an older connection pinned before provider-key connections
 * moved to runtime routing, so reconnecting can clear it. It must match what
 * those connections wrote, so it keeps the default models of that time.
 */
function opencodeLegacyModelRef(
  client: OpenCodeFamilyClient,
  ctx: SetupScriptContext,
): string {
  const target = opencodeProviderTarget(client, ctx);
  const provider = (ctx.proxy as SetupScriptProxySection).provider;
  const model =
    ctx.proxy?.model ?? LEGACY_PINNED_DEFAULT_MODELS[provider] ?? target.model;
  return `${target.id}/${model}`;
}

const LEGACY_PINNED_DEFAULT_MODELS: Partial<Record<SupportedProvider, string>> =
  {
    anthropic: "claude-opus-4-8",
    openai: "gpt-5.5",
    gemini: "gemini-3.6-flash",
    openrouter: "openrouter/auto",
    kimi: "kimi-k2-0711-preview",
  };

/**
 * Primary-providers mode: the Archestra providers authenticate with the
 * virtual key, so the passthrough key goes only on the user's own sign-ins
 * (see `routeHeaders`); every route carries the client id.
 */
function opencodePrimaryHeaders(
  client: OpenCodeFamilyClient,
): Record<string, string> {
  return { [EXTERNAL_AGENT_ID_HEADER]: client.clientId };
}

/** Headers the client sends on every proxied request (attribution). */
function opencodeProxyHeaders(
  client: OpenCodeFamilyClient,
  proxy: SetupScriptProxySection,
): Record<string, string> {
  const headers: Record<string, string> = {
    [EXTERNAL_AGENT_ID_HEADER]: client.clientId,
  };
  if (proxy.passthroughVirtualKey) {
    headers[VIRTUAL_KEY_HEADER] = proxy.passthroughVirtualKey;
  }
  return headers;
}

const opencodeOwnedMergeNode = (
  client: OpenCodeFamilyClient,
  includeSchema = true,
) => `const fs = require("fs");
const os = require("os");
const path = require("path");
const configPath = process.env.ARCHESTRA_OC_CONFIG_PATH;
const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
const cfg = raw.trim() ? JSON.parse(raw.replace(/^\\uFEFF/, "")) : {};
const backupPath = configPath + ".archestra-backup";
if (fs.existsSync(configPath) && !fs.existsSync(backupPath)) fs.copyFileSync(configPath, backupPath);
${includeSchema ? `cfg.$schema ??= ${JSON.stringify(client.schemaUrl)};` : ""}
${openCodeMcpMergeScript(client)}
const managedHeaders = JSON.parse(process.env.ARCHESTRA_OC_HEADERS || "{}");
const routes = JSON.parse(process.env.ARCHESTRA_OC_PROVIDER_ROUTES || "{}");
const runtimeRouting = process.env.ARCHESTRA_OC_RUNTIME_ROUTING === "1";
const providers = cfg.provider && typeof cfg.provider === "object" ? cfg.provider : {};
const statePath = path.join(process.env.HOME || os.homedir(), ".archestra", ${JSON.stringify(`${client.stateName}-connection-state.json`)});
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
fs.mkdirSync(path.dirname(configPath), { recursive: true });
// Migrated MCP options may include a static authorization header.
if (fs.existsSync(configPath)) fs.chmodSync(configPath, 0o600);
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\\n", { mode: 0o600 });
writeMcpSibling();
console.log("Updated " + configPath);`;

// Key-scoped merge into OpenCode's documented global config. Authentication is
// stored separately by OpenCode, so existing local keys and subscriptions stay
// on the machine; only provider routes change.
// Values arrive via env.
const opencodeOwnedMergePy = (
  client: OpenCodeFamilyClient,
) => `import json, os, pathlib, shutil
path = pathlib.Path(os.environ["ARCHESTRA_OC_CONFIG_PATH"])
raw = path.read_text(encoding="utf-8-sig") if path.exists() else ""
cfg = json.loads(raw) if raw.strip() else {}
backup = path.with_name(path.name + ".archestra-backup")
if path.exists() and not backup.exists():
    shutil.copy2(path, backup)
cfg.setdefault("$schema", ${JSON.stringify(client.schemaUrl)})
if os.environ.get("ARCHESTRA_OC_MCP_NAME"):
    if (path.parent / ${JSON.stringify(client.commentedConfigFile)}).exists():
        raise SystemExit("Node.js is required to reconcile the sibling JSONC configuration. Install Node.js and rerun setup.")
    servers = cfg.setdefault("mcp", {})
    name, url = os.environ["ARCHESTRA_OC_MCP_NAME"], os.environ["ARCHESTRA_OC_MCP_URL"]
    aliases = [alias for alias, entry in servers.items() if isinstance(entry, dict) and entry.get("type") == "remote" and entry.get("url") == url]
    if any(alias != name for alias in aliases):
        raise SystemExit("Node.js is required to consolidate existing gateway aliases. Install Node.js and rerun setup.")
    previous = servers.get(name, {})
    servers[name] = {**(previous if isinstance(previous, dict) and previous.get("url") == url else {}), "type": "remote", "url": url}
    if servers[name].get("enabled") is False: servers[name]["enabled"] = True
managed_headers = json.loads(os.environ.get("ARCHESTRA_OC_HEADERS", "{}"))
routes = json.loads(os.environ.get("ARCHESTRA_OC_PROVIDER_ROUTES", "{}"))
runtime_routing = os.environ.get("ARCHESTRA_OC_RUNTIME_ROUTING") == "1"
providers = cfg.get("provider") if isinstance(cfg.get("provider"), dict) else {}
state_path = pathlib.Path(os.path.expanduser(${JSON.stringify(`~/.archestra/${client.stateName}-connection-state.json`)}))
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
legacy_model = os.environ.get("ARCHESTRA_OC_LEGACY_MODEL")
if legacy_model and cfg.get("model") == legacy_model:
    cfg.pop("model", None)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(cfg, indent=2) + "\\n")
print(f"Updated {path}")`;

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
  client: OpenCodeFamilyClient,
  env: Record<string, string>,
  manual: string,
): string {
  const exports = Object.entries(env)
    .map(([key, value]) => `  export ${key}=${sh(value)}`)
    .join("\n");
  return `if command -v node >/dev/null 2>&1; then
  export ARCHESTRA_OC_CONFIG_PATH="$ARCHESTRA_OPENCODE_CONFIG"
${exports}
  node -e ${sh(opencodeOwnedMergeNode(client))}
elif command -v python3 >/dev/null 2>&1; then
  export ARCHESTRA_OC_CONFIG_PATH="$ARCHESTRA_OPENCODE_CONFIG"
${exports}
  python3 - <<'ARCHESTRA_PY'
${opencodeOwnedMergePy(client)}
ARCHESTRA_PY
else
  warn "python3 not found — add this to $ARCHESTRA_OPENCODE_CONFIG yourself:"
  cat <<'ARCHESTRA_MANUAL'
${manual}
ARCHESTRA_MANUAL
fi`;
}

function opencodeRoutingPluginBash(params: {
  context?: SetupScriptContext;
  client: OpenCodeFamilyClient;
  routes: Record<string, string>;
  headers: Record<string, string>;
  routeHeaders?: Record<string, Record<string, string>>;
  /** Setup-time catalog for the fallback plugin; the runtime builds its own. */
  catalog?: ManagedRuntimeCatalog;
}): string {
  const runtime = params.context
    ? managedRuntimeInstall({ ...params, context: params.context })
    : null;
  const encoded = Buffer.from(
    runtime?.v1 ??
      renderOpenCodeRoutingPlugin({
        ...params,
        appName: params.context?.appName,
      }),
    "utf8",
  ).toString("base64");
  const encodedV2 = Buffer.from(
    runtime?.v2 ??
      renderOpenCodeRoutingPluginV2({
        ...params,
        appName: params.context?.appName,
      }),
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
ARCHESTRA_OC_PLUGIN_STATE="$HOME/.archestra/${params.client.stateName}-routing-plugin-state.json"
mkdir -p "$(dirname "$ARCHESTRA_OC_PLUGIN")"
mkdir -p "$(dirname "$ARCHESTRA_OC_PLUGIN_STATE")"
${
  runtime
    ? `command -v node >/dev/null 2>&1 || { err "Node.js is required for managed launcher updates"; exit 1; }
ARCHESTRA_OC_RUNTIME_API_MAJOR="$ARCHESTRA_OPENCODE_MAJOR" node - <<'ARCHESTRA_RUNTIME_INSTALL'
${runtime.script}
ARCHESTRA_RUNTIME_INSTALL`
    : ""
}
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
  err "Node.js or python3 is required to install the ${params.client.label} routing guard"
  exit 1
fi
ok "Installed the ${params.client.label} LLM proxy routing guard"`;
}

function opencodeRoutingPluginPowerShell(params: {
  context?: SetupScriptContext;
  client: OpenCodeFamilyClient;
  routes: Record<string, string>;
  headers: Record<string, string>;
  routeHeaders?: Record<string, Record<string, string>>;
  /** Setup-time catalog for the fallback plugin; the runtime builds its own. */
  catalog?: ManagedRuntimeCatalog;
}): string {
  const runtime = params.context
    ? managedRuntimeInstall({ ...params, context: params.context })
    : null;
  const encoded = Buffer.from(
    runtime?.v1 ??
      renderOpenCodeRoutingPlugin({
        ...params,
        appName: params.context?.appName,
      }),
    "utf8",
  ).toString("base64");
  const encodedV2 = Buffer.from(
    runtime?.v2 ??
      renderOpenCodeRoutingPluginV2({
        ...params,
        appName: params.context?.appName,
      }),
    "utf8",
  ).toString("base64");
  return `$archPluginDir = Join-Path $archOcDir 'plugins'
$archPluginFile = Join-Path $archPluginDir 'archestra-llm-proxy.js'
$archPluginState = Join-Path $env:USERPROFILE ${psq(`.archestra/${params.client.stateName}-routing-plugin-state.json`)}
$null = New-Item -ItemType Directory -Force -Path $archPluginDir
${
  runtime
    ? `if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required for managed launcher updates' }
$archRuntimeInstall = @'
${runtime.script}
'@
$archPreviousRuntimeMajor = $env:ARCHESTRA_OC_RUNTIME_API_MAJOR
$archPreviousOutputEncoding = $OutputEncoding
try {
  $env:ARCHESTRA_OC_RUNTIME_API_MAJOR = [string]$archOcMajor
  # Native stdin defaults to ASCII in Windows PowerShell 5.1. Keep the exact
  # UTF-8 artifact sources intact for the managed runtime hash checks.
  $OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $archRuntimeInstall | & node -
} finally {
  $env:ARCHESTRA_OC_RUNTIME_API_MAJOR = $archPreviousRuntimeMajor
  $OutputEncoding = $archPreviousOutputEncoding
}
if ($LASTEXITCODE -ne 0) { throw 'Could not install managed launcher updates' }`
    : ""
}
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
Ok ${psq(`Installed the ${params.client.label} LLM proxy routing guard`)}`;
}

function opencodeBashSections(
  client: OpenCodeFamilyClient,
  ctx: SetupScriptContext,
): string[] {
  const configPath = `"\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/${client.configFile}"`;
  const sections: string[] = [
    client.versionedPluginApi
      ? `ARCHESTRA_OPENCODE_CONFIG=${configPath}
# OpenCode 2 changed its plugin API and \`debug config\` output; steps below branch on it.
ARCHESTRA_OPENCODE_MAJOR="$( { ${client.binary} --version 2>/dev/null || true; } </dev/null | sed -n '1s/^[^0-9]*\\([0-9][0-9]*\\)\\..*$/\\1/p')"
[ -n "$ARCHESTRA_OPENCODE_MAJOR" ] || ARCHESTRA_OPENCODE_MAJOR=1`
      : `ARCHESTRA_OPENCODE_CONFIG=${configPath}
# ${client.label} keeps OpenCode 1's plugin API and \`debug config\` output at every version.
ARCHESTRA_OPENCODE_MAJOR=1`,
  ];

  if (ctx.proxy && !ctx.proxy.primaryProviders) {
    sections.push(`if [ -f "$HOME/.archestra/${client.stateName}-primary-state.json" ]; then
  ARCHESTRA_OC_PRIMARY=null node -e ${sh(openCodePrimaryConfigScript(client))}
fi`);
  }

  if (ctx.mcp) {
    sections.push(`say ${sh(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
${opencodeOwnedMergeBash(
  client,
  {
    ARCHESTRA_OC_MCP_NAME: ctx.mcp.serverName,
    ARCHESTRA_OC_MCP_URL: ctx.mcp.url,
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
      const { routes, routeHeaders, catalog, unsupported, appName } =
        openCodePrimaryConfig(ctx.proxy, ctx.appName);
      sections.push(`say "Configuring model providers in ${client.label}"
command -v node >/dev/null 2>&1 || { err "Node.js is required to configure model providers"; exit 1; }
ARCHESTRA_OC_NOTICES="$(ARCHESTRA_OC_MAJOR="$ARCHESTRA_OPENCODE_MAJOR" ARCHESTRA_OC_KEY=${sh(ctx.proxy.virtualKey ?? "")} ARCHESTRA_OC_PRIMARY=stdin node -e ${sh(openCodePrimaryConfigScript(client))} <<'ARCHESTRA_PRIMARY_CATALOG'
${JSON.stringify({ appName, routes, catalog, unsupported })}
ARCHESTRA_PRIMARY_CATALOG
)"
[ -z "$ARCHESTRA_OC_NOTICES" ] || printf '%s\\n' "$ARCHESTRA_OC_NOTICES" | while IFS= read -r archNotice; do
  case "$archNotice" in
    info:*) ok "\${archNotice#info:}" ;;
    warn:*) warn "\${archNotice#warn:}" ;;
  esac
done
${opencodeRoutingPluginBash({ client, context: ctx, routes, routeHeaders, catalog, headers: opencodePrimaryHeaders(client) })}`);
    } else if (ctx.proxy.authMode === "provider-key") {
      const routes = Object.fromEntries(
        OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => [
          route.openCodeProviderId,
          openCodePassthroughBaseUrl(ctx.proxy?.baseUrl ?? "", route),
        ]),
      );
      const headers = opencodeProxyHeaders(client, ctx.proxy);
      const legacyModel = opencodeLegacyModelRef(client, ctx);
      const manual =
        "The routing plugin is installed. Node.js or Python is required to remove provider settings left by an older connection.";
      sections.push(`say "Routing supported ${client.label} providers through the LLM proxy"
${opencodeRoutingPluginBash({ client, context: ctx, routes, headers })}
${opencodeOwnedMergeBash(
  client,
  {
    ARCHESTRA_OC_MCP_NAME: "",
    ARCHESTRA_OC_PROVIDER_ROUTES: JSON.stringify(routes),
    ARCHESTRA_OC_RUNTIME_ROUTING: "1",
    ARCHESTRA_OC_LEGACY_MODEL: legacyModel,
    ARCHESTRA_OC_HEADERS: JSON.stringify(headers),
  },
  manual,
)}
if [ "$ARCHESTRA_OPENCODE_MAJOR" -lt 2 ] && command -v python3 >/dev/null 2>&1; then
  EFFECTIVE_CONFIG=$(cd "$HOME" && ${client.binary} debug config 2>/dev/null || true)
  ROUTE_MISMATCHES=$(printf '%s' "$EFFECTIVE_CONFIG" | ARCHESTRA_OC_PROVIDER_ROUTES=${sh(JSON.stringify(routes))} python3 -c ${sh(OPENCODE_EFFECTIVE_ROUTES_PY)} || true)
  if [ -z "$ROUTE_MISMATCHES" ]; then
    ok "${client.label}'s credentialed native providers resolve through the LLM proxy"
  else
    warn "Another ${client.label} config overrides these provider routes: $ROUTE_MISMATCHES"
  fi
fi`);
    }
  }

  if (ctx.skills) {
    sections.push(`say ${sh(`Installing the "${ctx.skills.marketplaceName}" skills`)}
SKILLS_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/${client.dir}/skills/${ctx.skills.marketplaceName}"
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

  if (ctx.mcp && !ctx.proxy && ctx.managedRuntimeSource) {
    sections.push(
      opencodeRoutingPluginBash({
        client,
        context: ctx,
        routes: {},
        headers: {},
      }),
    );
  }

  if (ctx.mcp) {
    sections.push(`say "${client.label} MCP servers"
cli ${client.binary} mcp list || true`);
  }
  return withStartupGuardBash(ctx, guardClientFor(client), sections);
}

function opencodePowerShellSections(
  client: OpenCodeFamilyClient,
  ctx: SetupScriptContext,
): string[] {
  const sections: string[] = [
    `$archOcDir = if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME ${psq(client.dir)} } else { Join-Path $env:USERPROFILE ${psq(`.config/${client.dir}`)} }
$archOcFile = Join-Path $archOcDir ${psq(client.configFile)}
${
  client.versionedPluginApi
    ? `# OpenCode 2 changed its plugin API and \`debug config\` output; steps below branch on it.
$archOcMajor = 1
try { if ((& ${client.binary} --version 2>$null | Out-String) -match '(\\d+)\\.\\d+') { $archOcMajor = [int]$Matches[1] } } catch { }`
    : `# ${client.label} keeps OpenCode 1's plugin API and \`debug config\` output at every version.
$archOcMajor = 1`
}
function Read-ArchOcOwned {
  if (Test-Path $archOcFile) {
    $raw = Get-Content -Raw -Path $archOcFile
    if ($raw -and $raw.Trim()) { return ($raw | ConvertFrom-Json) }
  }
  return [pscustomobject]@{ '$schema' = ${psq(client.schemaUrl)} }
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
`,
  ];

  if (ctx.mcp) {
    sections.push(`Say ${psq(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
if (Get-Command node -ErrorAction SilentlyContinue) {
  $env:ARCHESTRA_OC_CONFIG_PATH = $archOcFile
  $env:ARCHESTRA_OC_MCP_NAME = ${psq(ctx.mcp.serverName)}
  $env:ARCHESTRA_OC_MCP_URL = ${psq(ctx.mcp.url)}
  $archMcpScript = @'
${opencodeOwnedMergeNode(client, false)}
'@
  $archMcpFile = Join-Path ([IO.Path]::GetTempPath()) ('archestra-mcp-' + [guid]::NewGuid().ToString('N') + '.cjs')
  try {
    [IO.File]::WriteAllText($archMcpFile, $archMcpScript)
    & node $archMcpFile
    if ($LASTEXITCODE -ne 0) { throw 'Could not consolidate MCP gateway configuration' }
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $archMcpFile
    Remove-Item Env:ARCHESTRA_OC_CONFIG_PATH, Env:ARCHESTRA_OC_MCP_NAME, Env:ARCHESTRA_OC_MCP_URL -ErrorAction SilentlyContinue
  }
} else {
if (Test-Path (Join-Path $archOcDir ${psq(client.commentedConfigFile)})) { throw 'Node.js is required to reconcile the sibling JSONC configuration. Install Node.js and rerun setup.' }
$archCfg = Read-ArchOcOwned
if (-not $archCfg.PSObject.Properties['mcp']) { Set-ArchProp $archCfg 'mcp' ([pscustomobject]@{}) }
foreach ($archEntry in $archCfg.mcp.PSObject.Properties) {
  if ($archEntry.Value.type -eq 'remote' -and $archEntry.Value.url -eq ${psq(ctx.mcp.url)} -and $archEntry.Name -ne ${psq(ctx.mcp.serverName)}) { throw 'Node.js is required to consolidate existing gateway aliases. Install Node.js and rerun setup.' }
}
$archExisting = $archCfg.mcp.PSObject.Properties[${psq(ctx.mcp.serverName)}]
if ($archExisting -and $archExisting.Value.url -eq ${psq(ctx.mcp.url)}) {
  Set-ArchProp $archExisting.Value 'type' 'remote'
  if ($archExisting.Value.enabled -eq $false) { Set-ArchProp $archExisting.Value 'enabled' $true }
} else { Set-ArchProp $archCfg.mcp ${psq(ctx.mcp.serverName)} ([pscustomobject]@{ type = 'remote'; url = ${psq(ctx.mcp.url)} }) }
Write-ArchOcOwned $archCfg
}`);
  }

  if (ctx.proxy && !ctx.proxy.primaryProviders) {
    sections.push(`if (Test-Path (Join-Path $env:USERPROFILE ${psq(`.archestra/${client.stateName}-primary-state.json`)})) {
$archPrimaryRestore = @'
${openCodePrimaryConfigScript(client)}
'@
$env:ARCHESTRA_OC_PRIMARY = 'null'
try { $archPrimaryRestore | & node -; if ($LASTEXITCODE -ne 0) { throw 'Could not restore previous provider configuration' } }
finally { Remove-Item Env:ARCHESTRA_OC_PRIMARY -ErrorAction SilentlyContinue }
}`);
  }
  if (ctx.proxy) {
    if (ctx.proxy.primaryProviders) {
      const { routes, routeHeaders, catalog, unsupported, appName } =
        openCodePrimaryConfig(ctx.proxy, ctx.appName);
      sections.push(`Say ${psq(`Configuring model providers in ${client.label}`)}
$env:ARCHESTRA_OC_MAJOR = [string]$archOcMajor
$env:ARCHESTRA_OC_KEY = ${psq(ctx.proxy.virtualKey ?? "")}
$env:ARCHESTRA_OC_PRIMARY = 'stdin'
$archPrimaryCatalog = ${psq(JSON.stringify({ appName, routes, catalog, unsupported }))}
$archPrimaryScript = @'
${openCodePrimaryConfigScript(client)}
'@
# Run the script from a file: Windows PowerShell 5.1 drops the double quotes
# inside a native command argument, so node -e would get broken code.
$archPrimaryFile = Join-Path ([IO.Path]::GetTempPath()) ('archestra-opencode-primary-' + [guid]::NewGuid().ToString('N') + '.cjs')
try {
  [IO.File]::WriteAllText($archPrimaryFile, $archPrimaryScript)
  $archNotices = $archPrimaryCatalog | & node $archPrimaryFile; if ($LASTEXITCODE -ne 0) { throw 'Could not configure model providers' }
  foreach ($archNotice in @($archNotices)) {
    $archLine = [string]$archNotice
    if ($archLine.StartsWith('info:')) { Ok $archLine.Substring(5) } elseif ($archLine.StartsWith('warn:')) { Warn $archLine.Substring(5) }
  }
}
finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $archPrimaryFile
  Remove-Item Env:ARCHESTRA_OC_KEY, Env:ARCHESTRA_OC_PRIMARY, Env:ARCHESTRA_OC_MAJOR -ErrorAction SilentlyContinue
}
${opencodeRoutingPluginPowerShell({ client, context: ctx, routes, routeHeaders, catalog, headers: opencodePrimaryHeaders(client) })}`);
    } else if (ctx.proxy.authMode === "provider-key") {
      const headers = opencodeProxyHeaders(client, ctx.proxy);
      const legacyModel = opencodeLegacyModelRef(client, ctx);
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
      sections.push(`Say ${psq(`Routing supported ${client.label} providers through the LLM proxy`)}
${opencodeRoutingPluginPowerShell({ client, context: ctx, routes, headers })}
$archCfg = Read-ArchOcOwned
if (-not $archCfg.PSObject.Properties['provider']) { Set-ArchProp $archCfg 'provider' ([pscustomobject]@{}) }
if ($archCfg.PSObject.Properties['model'] -and $archCfg.model -eq ${psq(legacyModel)}) { $archCfg.PSObject.Properties.Remove('model') }
$archStateFile = Join-Path $env:USERPROFILE ${psq(`.archestra/${client.stateName}-connection-state.json`)}
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
Ok "${client.label}'s credentialed native providers will resolve through the LLM proxy"`);
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

  if (ctx.mcp && !ctx.proxy && ctx.managedRuntimeSource) {
    sections.push(
      opencodeRoutingPluginPowerShell({
        client,
        context: ctx,
        routes: {},
        headers: {},
      }),
    );
  }

  if (ctx.mcp) {
    sections.push(`Say ${psq(`${client.label} MCP servers`)}
try { & ${client.binary} mcp list 2>$null | Out-Host } catch { }`);
  }
  return withStartupGuardPowerShell(ctx, guardClientFor(client), sections);
}

function opencodeEnding(
  client: OpenCodeFamilyClient,
  ctx: SetupScriptContext,
): AgentEnding {
  let proxyDetail: string | undefined;
  if (ctx.proxy?.authMode === "primary-providers") {
    proxyDetail = `All usable primary providers are available in ${client.label}’s model picker`;
  } else if (ctx.proxy?.primaryProviders) {
    proxyDetail = `${ctx.proxy.providerLabel} models are available in ${client.label}’s model picker`;
  } else if (ctx.proxy?.authMode === "provider-key") {
    proxyDetail = `Providers you have signed in to in ${client.label} now go through the ${ctx.appName} LLM proxy`;
  }
  return {
    proxyDetail,
    parts:
      ctx.mcp || ctx.proxy || ctx.skills
        ? [
            {
              name: "Launch check",
              detail: `Runs each time you start ${client.binary}`,
            },
          ]
        : [],
    signIn: ctx.mcp
      ? {
          command: [client.binary, "mcp", "auth", ctx.mcp.serverName],
          howTo: `Run ${client.binary} mcp auth ${ctx.mcp.serverName} and finish the sign-in in your browser.`,
        }
      : null,
    launch: [client.binary, "--prompt", starterPrompt(ctx)],
    notes:
      ctx.mcp || ctx.proxy || ctx.skills
        ? [
            `If ${client.label} is already open, close it first so it picks up the new settings.`,
          ]
        : [],
  };
}

function openCodeFamilySetup(client: OpenCodeFamilyClient): ShellAgentSetup {
  return {
    label: client.label,
    binary: client.binary,
    bash: { sections: (ctx) => opencodeBashSections(client, ctx) },
    powerShell: {
      sections: (ctx) => opencodePowerShellSections(client, ctx),
    },
    ending: (ctx) => opencodeEnding(client, ctx),
  };
}

function guardClientFor(client: OpenCodeFamilyClient) {
  return client.clientId === "kilo" ? KILO_GUARD_CLIENT : OPENCODE_GUARD_CLIENT;
}

export const opencodeSetup = openCodeFamilySetup(OPENCODE_CLIENT);
export const kiloSetup = openCodeFamilySetup(KILO_CLIENT);
