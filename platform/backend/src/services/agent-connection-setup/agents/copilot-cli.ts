import {
  COPILOT_CLI_CLIENT_ID,
  COPILOT_PROVIDER_ENV_KEYS,
  DEFAULT_MODELS,
  EXTERNAL_AGENT_ID_HEADER,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { COPILOT_GUARD_CLIENT } from "../guard/clients";
import { describeMarketplaceContents } from "../steps/marketplace-copy";
import { legacyServerNames } from "../steps/mcp";
import { psq, sh } from "../steps/quoting";
import {
  withStartupGuardBash,
  withStartupGuardPowerShell,
} from "../steps/startup-guard";
import type {
  SetupScriptContext,
  SetupScriptProxySection,
  ShellAgentSetup,
} from "../types";

// Copilot CLI setup. Shared helpers first, then the GitHub Copilot device-flow
// link step for bash and PowerShell, the section lists and next steps side by
// side, then the agent module the dispatcher in ../index.ts uses.

/**
 * Value of the COPILOT_PROVIDER_HEADERS env var, shared by the bash and
 * PowerShell renderers: attribution headers the Copilot CLI sends only to its
 * BYOK provider endpoint (the LLM proxy), never to GitHub's own services.
 * Entries are joined with a literal `\n` — the CLI's documented separator —
 * so the value stays a single line in shell profiles and the Windows
 * registry. Always carries the client id; in passthrough mode also the
 * personal passthrough key that attributes the request to the user (the
 * Copilot analog of Claude Code's ANTHROPIC_CUSTOM_HEADERS injection).
 */
function copilotAttributionHeadersValue(
  proxy: SetupScriptProxySection,
): string {
  const lines = [`${EXTERNAL_AGENT_ID_HEADER}: ${COPILOT_CLI_CLIENT_ID}`];
  if (proxy.passthroughVirtualKey) {
    lines.push(`${VIRTUAL_KEY_HEADER}: ${proxy.passthroughVirtualKey}`);
  }
  return lines.join("\\n");
}

/**
 * GitHub Copilot in passthrough mode: there is no static API key — the proxy
 * expects the user's long-lived GitHub OAuth token as the bearer. The script
 * obtains one locally and prints it in the export lines, so the token never
 * leaves the machine:
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
as COPILOT_PROVIDER_API_KEY below.
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

say 'Copilot provider settings (GitHub Copilot via OpenAI-compatible protocol)'
echo
echo 'Add these lines to your shell profile (e.g. ~/.zshrc); adjust ${COPILOT_PROVIDER_ENV_KEYS.model} if you use a different model:'
printf '  export ${COPILOT_PROVIDER_ENV_KEYS.type}="openai"\\n'
printf '  export ${COPILOT_PROVIDER_ENV_KEYS.baseUrl}="%s"\\n' ${sh(proxy.url)}
if [ -n "$ARCHESTRA_GHCP_TOKEN" ]; then
  printf '  export ${COPILOT_PROVIDER_ENV_KEYS.apiKey}="%s"\\n' "$ARCHESTRA_GHCP_TOKEN"
else
  printf '  export ${COPILOT_PROVIDER_ENV_KEYS.apiKey}="%s"\\n' '<your-github-oauth-token>'
fi
printf '  export ${COPILOT_PROVIDER_ENV_KEYS.model}="${proxy.model ?? DEFAULT_MODELS["github-copilot"]}"\\n'
printf '  export ${COPILOT_PROVIDER_ENV_KEYS.headers}="%s"\\n' ${sh(copilotAttributionHeadersValue(proxy))}`;
}

/**
 * PowerShell lines applying one env var to the current session AND persisting
 * it at User scope. `irm | iex` runs in the caller's session, so the `$env:`
 * assignment survives the script (unlike bash, where a piped script cannot
 * export into the caller's shell). [Environment]::SetEnvironmentVariable is
 * an in-process call, so unlike setx the value never appears in an argv and
 * is not subject to setx's 1024-character truncation.
 */
function psApplyUserEnv(name: string, psValueExpr: string): string {
  return `$env:${name} = ${psValueExpr}
[Environment]::SetEnvironmentVariable('${name}', ${psValueExpr}, 'User')`;
}

/** Shared success line of both Copilot provider sections. */
const PS_COPILOT_APPLIED_OK = `Ok 'Copilot provider settings applied: current session + saved to your User environment.'`;

/**
 * COPILOT_MODEL companion to the provider apply: with a BYOK provider
 * configured, the Copilot CLI refuses to launch without an explicit model
 * ("BYOK providers require an explicit model"). A model chosen in the
 * wizard's review step is the user's reviewed decision and is applied
 * outright; without one, an unset COPILOT_MODEL gets the provider's default
 * (session + User scope) and an existing value is never overwritten.
 */
function psCopilotModelApply(params: {
  chosenModel: string | null;
  defaultModel: string;
}): string {
  if (params.chosenModel) {
    return `${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.model, psq(params.chosenModel))}
Ok ${psq(`set ${COPILOT_PROVIDER_ENV_KEYS.model} = ${params.chosenModel} (your selection on the connection page).`)}
Write-Host 'Restart any open Copilot CLI sessions to pick this up.'`;
  }
  return `if ([string]::IsNullOrEmpty($env:${COPILOT_PROVIDER_ENV_KEYS.model})) {
  ${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.model, psq(params.defaultModel))}
  Ok ${psq(`set ${COPILOT_PROVIDER_ENV_KEYS.model} = ${params.defaultModel} — change it anytime ($env:${COPILOT_PROVIDER_ENV_KEYS.model}).`)}
} else {
  Write-Host ('Keeping your existing ${COPILOT_PROVIDER_ENV_KEYS.model} = ' + $env:${COPILOT_PROVIDER_ENV_KEYS.model})
}
Write-Host 'Restart any open Copilot CLI sessions to pick this up.'`;
}

/**
 * GitHub Copilot in passthrough mode: there is no static API key — the proxy
 * expects the user's long-lived GitHub OAuth token as the bearer. Mirrors the
 * bash device flow: reuse a token the Copilot CLI / VS Code already stored (only
 * if Copilot's token exchange accepts it), otherwise run the GitHub device flow
 * (RFC 8628). The token stays in a PowerShell variable and is passed via
 * Invoke-RestMethod headers / request bodies, never as argv to an external
 * command; it ends up applied as the COPILOT_* provider env vars (session +
 * User scope) without ever being echoed to the console.
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

Say 'Applying Copilot provider settings (GitHub Copilot via OpenAI-compatible protocol)'
${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.type, psq("openai"))}
${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.baseUrl, psq(proxy.url))}
${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.headers, psq(copilotAttributionHeadersValue(proxy)))}
if (-not [string]::IsNullOrEmpty($ArchGhcpToken)) {
  ${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.apiKey, "$ArchGhcpToken")}
  ${PS_COPILOT_APPLIED_OK}
} else {
  Write-Host 'No GitHub token was linked — set your own key the same way: $env:${COPILOT_PROVIDER_ENV_KEYS.apiKey} = "<your-github-oauth-token>"'
}
${psCopilotModelApply({
  chosenModel: proxy.model,
  defaultModel: DEFAULT_MODELS["github-copilot"],
})}`;
}

function copilotBashSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    const stale = legacyServerNames(ctx.mcp)
      .map(
        (name) => `cli copilot mcp remove ${sh(name)} >/dev/null 2>&1 || true`,
      )
      .join("\n");
    sections.push(`say ${sh(`Registering MCP gateway "${ctx.mcp.serverName}" (OAuth)`)}
cli copilot mcp remove ${sh(ctx.mcp.serverName)} >/dev/null 2>&1 || true${stale ? `\n${stale}` : ""}
cli copilot mcp add --transport http ${sh(ctx.mcp.serverName)} ${sh(ctx.mcp.url)}
cli copilot mcp get ${sh(ctx.mcp.serverName)}`);
  }

  if (ctx.proxy) {
    if (ctx.proxy.provider === "github-copilot" && !ctx.proxy.virtualKey) {
      sections.push(copilotGithubLinkBash(ctx.proxy));
    } else {
      // A piped script cannot export into the caller's shell; print the lines.
      sections.push(`say ${sh(`Copilot provider settings (${ctx.proxy.providerLabel} via OpenAI-compatible protocol)`)}
cat <<'ARCHESTRA_COPILOT'

Add these lines to your shell profile (e.g. ~/.zshrc); adjust ${COPILOT_PROVIDER_ENV_KEYS.model} if you use a different model:
  export ${COPILOT_PROVIDER_ENV_KEYS.type}="openai"
  export ${COPILOT_PROVIDER_ENV_KEYS.baseUrl}=${sh(ctx.proxy.url)}
  export ${COPILOT_PROVIDER_ENV_KEYS.apiKey}=${
    ctx.proxy.virtualKey
      ? sh(ctx.proxy.virtualKey)
      : `"<your-${ctx.proxy.provider}-api-key>"`
  }
  export ${COPILOT_PROVIDER_ENV_KEYS.model}="${ctx.proxy.model ?? DEFAULT_MODELS[ctx.proxy.provider]}"
  export ${COPILOT_PROVIDER_ENV_KEYS.headers}="${copilotAttributionHeadersValue(ctx.proxy)}"
ARCHESTRA_COPILOT`);
    }
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

  return withStartupGuardBash(ctx, COPILOT_GUARD_CLIENT, sections);
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
    sections.push(`Say ${psq(`Registering MCP gateway "${ctx.mcp.serverName}" (OAuth)`)}
try { copilot mcp remove ${psq(ctx.mcp.serverName)} 2>$null | Out-Null } catch { }${stale ? `\n${stale}` : ""}
copilot mcp add --transport http ${psq(ctx.mcp.serverName)} ${psq(ctx.mcp.url)}
if ($LASTEXITCODE -ne 0) { throw 'Could not register the MCP gateway. Fix the error above and re-run setup.' }
copilot mcp get ${psq(ctx.mcp.serverName)}`);
  }

  if (ctx.proxy) {
    if (ctx.proxy.provider === "github-copilot" && !ctx.proxy.virtualKey) {
      sections.push(copilotGithubLinkPowerShell(ctx.proxy));
    } else {
      const apply = [
        psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.type, psq("openai")),
        psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.baseUrl, psq(ctx.proxy.url)),
        psApplyUserEnv(
          COPILOT_PROVIDER_ENV_KEYS.headers,
          psq(copilotAttributionHeadersValue(ctx.proxy)),
        ),
      ];
      if (ctx.proxy.virtualKey) {
        apply.push(
          psApplyUserEnv(
            COPILOT_PROVIDER_ENV_KEYS.apiKey,
            psq(ctx.proxy.virtualKey),
          ),
        );
      }
      sections.push(`Say ${psq(`Applying Copilot provider settings (${ctx.proxy.providerLabel} via OpenAI-compatible protocol)`)}
${apply.join("\n")}
${PS_COPILOT_APPLIED_OK}${
  ctx.proxy.virtualKey
    ? ""
    : `\nWrite-Host 'Set your own key the same way: $env:${COPILOT_PROVIDER_ENV_KEYS.apiKey} = "<your-${ctx.proxy.provider}-api-key>"'`
}
${psCopilotModelApply({
  chosenModel: ctx.proxy.model,
  defaultModel: DEFAULT_MODELS[ctx.proxy.provider],
})}`);
    }
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

  return withStartupGuardPowerShell(ctx, COPILOT_GUARD_CLIENT, sections);
}

function copilotBashNextSteps(ctx: SetupScriptContext): string[] {
  const steps: string[] = [];
  if (ctx.mcp) {
    steps.push(
      "Copilot opens your browser to complete OAuth when the gateway asks for it.",
    );
  }
  if (ctx.proxy) {
    steps.push(
      'Paste the export lines printed above into your shell profile, set COPILOT_MODEL, then verify with: copilot -p "Reply with exactly: archestra-copilot-cli-ok"',
    );
  }
  if (ctx.skills?.hasSkills ?? !!ctx.skills) {
    steps.push(
      `Browse and install the shared skills: copilot plugin marketplace browse ${ctx.skills.marketplaceName}`,
    );
  }
  if (ctx.skills?.pluginNames?.length) {
    steps.push("The plugins are installed and enabled.");
  }
  return steps;
}

function copilotPowerShellNextSteps(ctx: SetupScriptContext): string[] {
  const steps: string[] = [];
  if (ctx.mcp) {
    steps.push(
      "Copilot opens your browser to complete OAuth when the gateway asks for it.",
    );
  }
  if (ctx.proxy) {
    // The key is applied automatically when the script knows it: a minted
    // virtual key, or the GitHub token the Copilot link section obtains.
    const keyApplied =
      Boolean(ctx.proxy.virtualKey) || ctx.proxy.provider === "github-copilot";
    steps.push(
      keyApplied
        ? 'The COPILOT_* provider variables (including a default COPILOT_MODEL) were applied for you — verify with: copilot -p "Reply with exactly: archestra-copilot-cli-ok"'
        : `Set ${COPILOT_PROVIDER_ENV_KEYS.apiKey} to your own key (the other COPILOT_* variables were applied for you), then verify with: copilot -p "Reply with exactly: archestra-copilot-cli-ok"`,
    );
  }
  if (ctx.skills && describeMarketplaceContents(ctx.skills).hasSkills) {
    steps.push(
      `Browse and install the shared skills: copilot plugin marketplace browse ${ctx.skills.marketplaceName}`,
    );
  }
  if (ctx.skills?.pluginNames?.length) {
    steps.push("The plugins are installed and enabled.");
  }
  return steps;
}

export const copilotCliSetup: ShellAgentSetup = {
  label: "Copilot CLI",
  binary: "copilot",
  bash: { sections: copilotBashSections, nextSteps: copilotBashNextSteps },
  powerShell: {
    sections: copilotPowerShellSections,
    nextSteps: copilotPowerShellNextSteps,
  },
};
