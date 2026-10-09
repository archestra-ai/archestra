// biome-ignore-all lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion

import {
  COPILOT_CLI_CLIENT_ID,
  DEFAULT_MODELS,
  EXTERNAL_AGENT_ID_HEADER,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { COPILOT_GUARD_CLIENT } from "../guard/clients";
import {
  COPILOT_PROVIDER_CONFIG_NODE,
  COPILOT_PROVIDER_INSTRUCTIONS_NODE,
} from "../payloads/copilot-provider-config";
import { starterPrompt } from "../steps/ending";
import { describeMarketplaceContents } from "../steps/marketplace-copy";
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

export const copilotCliSetup: ShellAgentSetup = {
  label: "Copilot CLI",
  binary: "copilot",
  bash: { sections: copilotBashSections },
  powerShell: {
    sections: copilotPowerShellSections,
  },
  ending: copilotEnding,
};

// Native provider setup, GitHub sign-in, and optional environment instructions.

function copilotProviderConfig(proxy: SetupScriptProxySection): string {
  return JSON.stringify({
    url: proxy.url,
    model: proxy.model ?? DEFAULT_MODELS[proxy.provider],
    headers: {
      [EXTERNAL_AGENT_ID_HEADER]: COPILOT_CLI_CLIENT_ID,
      ...(proxy.passthroughVirtualKey
        ? { [VIRTUAL_KEY_HEADER]: proxy.passthroughVirtualKey }
        : {}),
    },
  });
}

function copilotProviderBash(proxy: SetupScriptProxySection): string {
  const key = proxy.virtualKey
    ? sh(proxy.virtualKey)
    : proxy.provider === "github-copilot"
      ? '"${ARCHESTRA_GHCP_TOKEN:-}"'
      : '"${COPILOT_PROVIDER_API_KEY:-}"';
  return `say 'Saving Copilot provider settings'
ARCHESTRA_COPILOT_VERSION="$(cli copilot --version)" ARCHESTRA_COPILOT_ACTION=install ARCHESTRA_COPILOT_CONFIG=${sh(copilotProviderConfig(proxy))} ARCHESTRA_COPILOT_API_KEY=${key} node <<'ARCHESTRA_COPILOT_NODE'
${COPILOT_PROVIDER_CONFIG_NODE}
ARCHESTRA_COPILOT_NODE`;
}

function copilotProviderPowerShell(proxy: SetupScriptProxySection): string {
  const key = proxy.virtualKey
    ? psq(proxy.virtualKey)
    : proxy.provider === "github-copilot"
      ? "$ArchGhcpToken"
      : "$env:COPILOT_PROVIDER_API_KEY";
  return `Say 'Saving Copilot provider settings'
  $env:ARCHESTRA_COPILOT_VERSION = (copilot --version | Out-String)
  $env:ARCHESTRA_COPILOT_ACTION = 'install'
  $env:ARCHESTRA_COPILOT_CONFIG = ${psq(copilotProviderConfig(proxy))}
  $env:ARCHESTRA_COPILOT_API_KEY = ${key}
  try {
    @'
${COPILOT_PROVIDER_CONFIG_NODE}
'@ | node
    if ($LASTEXITCODE -ne 0) { throw 'Could not update Copilot provider configuration.' }
  } finally {
    Remove-Item Env:ARCHESTRA_COPILOT_VERSION, Env:ARCHESTRA_COPILOT_ACTION, Env:ARCHESTRA_COPILOT_CONFIG, Env:ARCHESTRA_COPILOT_API_KEY -ErrorAction SilentlyContinue
  }`;
}

/**
 * GitHub Copilot in passthrough mode: there is no static API key — the proxy
 * expects the user's long-lived GitHub OAuth token as the bearer. The script
 * obtains one locally for providers.json and the optional export lines:
 *  1. reuse a token the Copilot CLI / VS Code already stored in
 *     ~/.config/github-copilot/{apps,hosts}.json — but only if Copilot's token
 *     exchange accepts it (valid + active Copilot seat);
 *  2. otherwise run the GitHub device flow (RFC 8628): show a code, poll
 *     until the user authorizes in the browser, honoring interval/slow_down
 *     with a hard deadline from expires_in.
 * The token is never passed as argv to external commands (curl reads it via
 * stdin config / request bodies via stdin).
 */
function copilotGithubLinkBash(proxy: SetupScriptProxySection): string {
  const gh = proxy.githubCopilot;
  if (!gh) {
    throw new Error(
      "github-copilot passthrough proxy section requires githubCopilot device-flow configuration",
    );
  }

  const deviceCodeUrl = `${gh.deviceAuthBaseUrl.replace(/\/+$/, "")}/login/device/code`;
  const accessTokenUrl = `${gh.deviceAuthBaseUrl.replace(/\/+$/, "")}/login/oauth/access_token`;
  const deviceRequestBody = JSON.stringify({
    client_id: gh.clientId,
    scope: "read:user",
  });

  return `say 'Linking your GitHub Copilot subscription'
ARCHESTRA_GHCP_TOKEN=""

# Probe the Copilot token exchange: succeeds only for a valid GitHub token on
# an account with an active Copilot seat. Token goes via stdin, never argv.
ghcp_validate() {
  [ -n "$1" ] || return 1
  printf 'header = "authorization: token %s"\\n' "$1" | curl -fsS -o /dev/null \\
    --connect-timeout 10 --max-time 30 -K - \\
    -H 'accept: application/json' \\
    -H 'editor-version: vscode/1.99.0' \\
    -H 'copilot-integration-id: vscode-chat' \\
    ${sh(gh.tokenExchangeUrl)} 2>/dev/null
}

if ! command -v python3 >/dev/null 2>&1; then
  cat <<'ARCHESTRA_GHCP_MANUAL'
python3 not found — skipping the automatic GitHub sign-in.
Sign in manually instead: run the Copilot CLI once and complete its login,
then use the "oauth_token" value from ~/.config/github-copilot/apps.json
as apiKey in providers.json.
ARCHESTRA_GHCP_MANUAL
else
  # 1. Reuse a GitHub token already stored by the Copilot CLI / VS Code.
  ghcp_candidates="$(python3 - "$HOME/.config/github-copilot/apps.json" "$HOME/.config/github-copilot/hosts.json" <<'ARCHESTRA_GHCP_PY'
import json, sys
seen = []
for path in sys.argv[1:]:
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        continue
    if not isinstance(data, dict):
        continue
    for value in data.values():
        if isinstance(value, dict):
            token = value.get("oauth_token")
            if isinstance(token, str) and token and token not in seen:
                seen.append(token)
print("\\n".join(seen))
ARCHESTRA_GHCP_PY
)" || ghcp_candidates=""
  for ghcp_candidate in $ghcp_candidates; do
    if ghcp_validate "$ghcp_candidate"; then
      ARCHESTRA_GHCP_TOKEN="$ghcp_candidate"
      echo "Re-using the GitHub token stored by the Copilot CLI on this machine."
      break
    fi
  done

  # 2. No usable stored token: run the GitHub device flow.
  if [ -z "$ARCHESTRA_GHCP_TOKEN" ]; then
    ghcp_device="$(printf '%s' ${sh(deviceRequestBody)} | curl -fsS --connect-timeout 10 --max-time 30 \\
      -X POST -H 'accept: application/json' -H 'content-type: application/json' \\
      --data @- ${sh(deviceCodeUrl)})" || {
      err "could not reach GitHub to start the device flow."
      exit 1
    }
    ghcp_field() { printf '%s' "$ghcp_device" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"; }
    ghcp_device_code="$(ghcp_field device_code)"
    ghcp_user_code="$(ghcp_field user_code)"
    ghcp_verification_uri="$(ghcp_field verification_uri)"
    ghcp_interval="$(ghcp_field interval)"
    ghcp_expires_in="$(ghcp_field expires_in)"
    [ -n "$ghcp_interval" ] || ghcp_interval=5
    [ -n "$ghcp_expires_in" ] || ghcp_expires_in=900
    if [ -z "$ghcp_device_code" ]; then
      err "GitHub did not return a device code."
      exit 1
    fi
    ghcp_deadline=$(( $(date +%s) + ghcp_expires_in ))
    echo
    printf '  Open:        %s\\n' "$ghcp_verification_uri"
    printf '  Enter code:  %s\\n' "$ghcp_user_code"
    echo
    echo 'Waiting for you to authorize in the browser...'
    while [ -z "$ARCHESTRA_GHCP_TOKEN" ]; do
      if [ "$(date +%s)" -ge "$ghcp_deadline" ]; then
        err "timed out waiting for GitHub authorization — re-run this command to try again."
        exit 1
      fi
      sleep "$ghcp_interval"
      ghcp_poll="$(printf '{"client_id":"%s","device_code":"%s","grant_type":"urn:ietf:params:oauth:grant-type:device_code"}' ${sh(gh.clientId)} "$ghcp_device_code" | \\
        curl -sS --connect-timeout 10 --max-time 30 \\
          -X POST -H 'accept: application/json' -H 'content-type: application/json' \\
          --data @- ${sh(accessTokenUrl)})" || continue
      ghcp_token="$(printf '%s' "$ghcp_poll" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token","") or "")' 2>/dev/null)" || ghcp_token=""
      if [ -n "$ghcp_token" ]; then
        ARCHESTRA_GHCP_TOKEN="$ghcp_token"
        break
      fi
      ghcp_error="$(printf '%s' "$ghcp_poll" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))' 2>/dev/null)" || ghcp_error=""
      case "$ghcp_error" in
        # keep polling on pending and on transient/parse hiccups
        authorization_pending|"") ;;
        slow_down) ghcp_interval=$((ghcp_interval + 5)) ;;
        *) err "GitHub sign-in failed: $ghcp_error"; exit 1 ;;
      esac
    done
    ok "GitHub account linked."
    if ! ghcp_validate "$ARCHESTRA_GHCP_TOKEN"; then
      err "this GitHub account does not appear to have an active Copilot subscription."
      exit 1
    fi
  fi
fi
`;
}

/**
 * GitHub Copilot in passthrough mode: there is no static API key — the proxy
 * expects the user's long-lived GitHub OAuth token as the bearer. Mirrors the
 * bash device flow: reuse a token the Copilot CLI / VS Code already stored (only
 * if Copilot's token exchange accepts it), otherwise run the GitHub device flow
 * (RFC 8628). The token stays in a PowerShell variable and is passed via
 * Invoke-RestMethod headers / request bodies, never as argv to an external
 * command; it is saved to providers.json and printed in the optional env instructions.
 */
function copilotGithubLinkPowerShell(proxy: SetupScriptProxySection): string {
  const gh = proxy.githubCopilot;
  if (!gh) {
    throw new Error(
      "github-copilot passthrough proxy section requires githubCopilot device-flow configuration",
    );
  }

  const deviceCodeUrl = `${gh.deviceAuthBaseUrl.replace(/\/+$/, "")}/login/device/code`;
  const accessTokenUrl = `${gh.deviceAuthBaseUrl.replace(/\/+$/, "")}/login/oauth/access_token`;
  const deviceRequestBody = JSON.stringify({
    client_id: gh.clientId,
    scope: "read:user",
  });

  return `Say 'Linking your GitHub Copilot subscription'
$ArchGhcpToken = ''

# Probe the Copilot token exchange: succeeds only for a valid GitHub token on
# an account with an active Copilot seat. Token is sent in a request header
# (in-process), never as argv.
function Test-ArchGhcp($arch_tok) {
  if ([string]::IsNullOrEmpty($arch_tok)) { return $false }
  try {
    Invoke-RestMethod -Method Get -Uri ${psq(gh.tokenExchangeUrl)} -TimeoutSec 30 -Headers @{
      'authorization' = ('token ' + $arch_tok)
      'accept' = 'application/json'
      'editor-version' = 'vscode/1.99.0'
      'copilot-integration-id' = 'vscode-chat'
    } -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

# 1. Reuse a GitHub token already stored by the Copilot CLI / VS Code.
$arch_ghcp_paths = @(
  (Join-Path $env:USERPROFILE '.config\\github-copilot\\apps.json'),
  (Join-Path $env:USERPROFILE '.config\\github-copilot\\hosts.json')
)
if ($env:LOCALAPPDATA) {
  $arch_ghcp_paths += (Join-Path $env:LOCALAPPDATA 'github-copilot\\apps.json')
  $arch_ghcp_paths += (Join-Path $env:LOCALAPPDATA 'github-copilot\\hosts.json')
}
$arch_ghcp_candidates = @()
foreach ($arch_p in $arch_ghcp_paths) {
  if (Test-Path $arch_p) {
    try {
      $arch_data = Get-Content -Raw -Path $arch_p | ConvertFrom-Json
      foreach ($arch_prop in $arch_data.PSObject.Properties) {
        $arch_v = $arch_prop.Value
        if ($arch_v -and $arch_v.PSObject.Properties['oauth_token']) {
          $arch_t = $arch_v.oauth_token
          if ($arch_t -and ($arch_ghcp_candidates -notcontains $arch_t)) { $arch_ghcp_candidates += $arch_t }
        }
      }
    } catch { }
  }
}
foreach ($arch_cand in $arch_ghcp_candidates) {
  if (Test-ArchGhcp $arch_cand) {
    $ArchGhcpToken = $arch_cand
    Write-Host 'Re-using the GitHub token stored by the Copilot CLI on this machine.'
    break
  }
}

# 2. No usable stored token: run the GitHub device flow (RFC 8628).
if ([string]::IsNullOrEmpty($ArchGhcpToken)) {
  try {
    $arch_device = Invoke-RestMethod -Method Post -Uri ${psq(deviceCodeUrl)} -TimeoutSec 30 -Headers @{ 'accept' = 'application/json' } -ContentType 'application/json' -Body ${psq(deviceRequestBody)}
  } catch {
    Err 'could not reach GitHub to start the device flow.'
    exit 1
  }
  $arch_device_code = $arch_device.device_code
  $arch_user_code = $arch_device.user_code
  $arch_verification_uri = $arch_device.verification_uri
  $arch_interval = 5
  if ($arch_device.interval) { $arch_interval = [int]$arch_device.interval }
  $arch_expires_in = 900
  if ($arch_device.expires_in) { $arch_expires_in = [int]$arch_device.expires_in }
  if ([string]::IsNullOrEmpty($arch_device_code)) {
    Err 'GitHub did not return a device code.'
    exit 1
  }
  $arch_deadline = (Get-Date).AddSeconds($arch_expires_in)
  Write-Host ''
  Write-Host ('  Open:        ' + $arch_verification_uri)
  Write-Host ('  Enter code:  ' + $arch_user_code)
  Write-Host ''
  Write-Host 'Waiting for you to authorize in the browser...'
  while ([string]::IsNullOrEmpty($ArchGhcpToken)) {
    if ((Get-Date) -ge $arch_deadline) {
      Err 'timed out waiting for GitHub authorization — re-run this command to try again.'
      exit 1
    }
    Start-Sleep -Seconds $arch_interval
    $arch_poll_body = (@{ client_id = ${psq(gh.clientId)}; device_code = $arch_device_code; grant_type = 'urn:ietf:params:oauth:grant-type:device_code' } | ConvertTo-Json -Compress)
    try {
      $arch_poll = Invoke-RestMethod -Method Post -Uri ${psq(accessTokenUrl)} -TimeoutSec 30 -Headers @{ 'accept' = 'application/json' } -ContentType 'application/json' -Body $arch_poll_body
    } catch {
      continue
    }
    if ($arch_poll.access_token) {
      $ArchGhcpToken = $arch_poll.access_token
      break
    }
    $arch_err = ''
    if ($arch_poll.PSObject.Properties['error']) { $arch_err = [string]$arch_poll.error }
    switch ($arch_err) {
      'authorization_pending' { }
      '' { }
      'slow_down' { $arch_interval = $arch_interval + 5 }
      default {
        Err ('GitHub sign-in failed: ' + $arch_err)
        exit 1
      }
    }
  }
  Ok 'GitHub account linked.'
  if (-not (Test-ArchGhcp $ArchGhcpToken)) {
    Err 'this GitHub account does not appear to have an active Copilot subscription.'
    exit 1
  }
}
`;
}

function copilotBashSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    const stale = legacyServerNames(ctx.mcp)
      .map(
        (name) => `cli copilot mcp remove ${sh(name)} >/dev/null 2>&1 || true`,
      )
      .join("\n");
    sections.push(`say ${sh(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
cli copilot mcp remove ${sh(ctx.mcp.serverName)} >/dev/null 2>&1 || true${stale ? `\n${stale}` : ""}
cli copilot mcp add --transport http ${sh(ctx.mcp.serverName)} ${sh(ctx.mcp.url)}
cli copilot mcp get ${sh(ctx.mcp.serverName)}`);
  }

  if (ctx.proxy) {
    if (ctx.proxy.provider === "github-copilot" && !ctx.proxy.virtualKey) {
      sections.push(copilotGithubLinkBash(ctx.proxy));
    }
    sections.push(copilotProviderBash(ctx.proxy));
  }

  if (ctx.skills) {
    const installs = (ctx.skills.pluginNames ?? []).map((pluginName) => {
      const ref = `${pluginName}@${ctx.skills?.marketplaceName}`;
      return `if ! cli copilot plugin install ${sh(ref)}; then
  warn ${sh(`Could not install plugin — run 'copilot plugin install ${ref}'.`)}
fi`;
    });
    sections.push(`say ${sh(`Registering the "${ctx.skills.marketplaceName}" marketplace`)}
if ! cli copilot plugin marketplace add ${sh(ctx.skills.cloneUrl)}; then
  warn "Marketplace may already be registered — run 'copilot plugin marketplace browse' to inspect."
fi
${installs.join("\n")}`);
  }

  return [
    ...(ctx.proxy
      ? [
          `if ! command -v node >/dev/null 2>&1; then
  err 'Node.js is required to save Copilot provider settings. Install Node.js and re-run setup.'
  exit 1
fi`,
        ]
      : []),
    ...withStartupGuardBash(ctx, COPILOT_GUARD_CLIENT, sections),
  ];
}

function copilotPowerShellSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    const stale = legacyServerNames(ctx.mcp)
      .map(
        (name) =>
          `try { copilot mcp remove ${psq(name)} 2>$null | Out-Null } catch { }`,
      )
      .join("\n");
    sections.push(`Say ${psq(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
try { copilot mcp remove ${psq(ctx.mcp.serverName)} 2>$null | Out-Null } catch { }${stale ? `\n${stale}` : ""}
copilot mcp add --transport http ${psq(ctx.mcp.serverName)} ${psq(ctx.mcp.url)}
if ($LASTEXITCODE -ne 0) { throw 'Could not register the MCP gateway. Fix the error above and re-run setup.' }
copilot mcp get ${psq(ctx.mcp.serverName)}`);
  }

  if (ctx.proxy) {
    if (ctx.proxy.provider === "github-copilot" && !ctx.proxy.virtualKey) {
      sections.push(copilotGithubLinkPowerShell(ctx.proxy));
    }
    sections.push(copilotProviderPowerShell(ctx.proxy));
  }

  if (ctx.skills) {
    const pluginInstalls = (ctx.skills.pluginNames ?? [])
      .map((pluginName) => {
        const ref = `${pluginName}@${ctx.skills?.marketplaceName}`;
        return `copilot plugin install ${psq(ref)}
if ($LASTEXITCODE -ne 0) { Warn ${psq(`Could not install plugin — run 'copilot plugin install ${ref}'.`)} }`;
      })
      .join("\n");
    sections.push(`Say ${psq(`Registering the "${ctx.skills.marketplaceName}" marketplace`)}
copilot plugin marketplace add ${psq(ctx.skills.cloneUrl)}
if ($LASTEXITCODE -ne 0) { Warn "Marketplace may already be registered — run 'copilot plugin marketplace browse' to inspect." }
${pluginInstalls}`);
  }

  return [
    ...(ctx.proxy
      ? [
          `if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required to save Copilot provider settings. Install Node.js and re-run setup.'
}`,
        ]
      : []),
    ...withStartupGuardPowerShell(ctx, COPILOT_GUARD_CLIENT, sections),
  ];
}

function copilotEnding(ctx: SetupScriptContext): AgentEnding {
  const notes: string[] = [];
  const proxyDetail = ctx.proxy
    ? "Provider settings saved in providers.json"
    : undefined;
  if (ctx.skills && describeMarketplaceContents(ctx.skills).hasSkills) {
    notes.push(
      `To add the shared skills, run: copilot plugin marketplace browse ${ctx.skills.marketplaceName}`,
    );
  }
  return {
    proxyDetail,
    ...(ctx.proxy
      ? { optionalInstructions: COPILOT_PROVIDER_INSTRUCTIONS_NODE }
      : {}),
    parts:
      ctx.mcp || ctx.proxy || ctx.skills
        ? [{ name: "Launch check", detail: "Runs each time you start copilot" }]
        : [],
    signIn: ctx.mcp
      ? {
          command: null,
          howTo:
            "Copilot opens your browser to sign in the first time it uses these tools.",
        }
      : null,
    launch: ["copilot", "-i", starterPrompt(ctx)],
    notes,
  };
}
