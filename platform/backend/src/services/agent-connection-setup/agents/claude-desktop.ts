import {
  REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared/archestra-mcp-server";
import type { SetupScriptContext } from "../types";
import { CLAUDE_APPA_PERMISSIONS_SKIPPED_WARNING } from "./claude-code";

const APPA_TOOLS = [
  TOOL_RUN_TOOL_SHORT_NAME,
  ...REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
];

/** Runs locally; subscription credentials never enter setup storage. */
export function renderClaudeDesktopSetupScript(
  ctx: SetupScriptContext,
): string {
  const payload = Buffer.from(JSON.stringify(ctx)).toString("base64");
  const python = `import base64
import json
SETUP = json.loads(base64.b64decode('${payload}'))
APPA_TOOLS = ${JSON.stringify(APPA_TOOLS)}
APPA_SKIPPED_WARNING = ${JSON.stringify(CLAUDE_APPA_PERMISSIONS_SKIPPED_WARNING)}
${INSTALLER}`;
  if (ctx.platform === "windows") {
    return `# Run in PowerShell
$ErrorActionPreference = 'Stop'
$python = $null
foreach ($name in @('py', 'python', 'python3')) {
  $candidate = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue
  if ($candidate) {
    try {
      & $candidate.Source -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" 2>$null
      if ($LASTEXITCODE -eq 0) { $python = $candidate.Source; break }
    } catch { continue }
  }
}
if (-not $python) { throw 'Install Python 3.9 or newer, then run setup again.' }
$installer = @'
${python}
'@
$installer | & $python -
if ($LASTEXITCODE -ne 0) { throw 'Claude Desktop setup did not complete.' }
`;
  }
  return `#!/usr/bin/env bash
set -euo pipefail
command -v python3 >/dev/null || { echo 'Install Python 3, then run setup again.' >&2; exit 1; }
python3 <<'ARCHESTRA_DESKTOP_PY'
${python}
ARCHESTRA_DESKTOP_PY
`;
}

const INSTALLER = String.raw`
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def write_json(path, value, protect_acl=True):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise RuntimeError('Refusing to replace a symbolic link: ' + str(path))
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        if protect_acl and sys.platform == 'win32':
            # chmod cannot protect a credential on Windows; remove inherited ACLs.
            sid = subprocess.check_output(['powershell.exe', '-NoProfile', '-Command',
                '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], text=True).strip()
            subprocess.run(['icacls.exe', temporary, '/inheritance:r', '/grant:r', '*' + sid + ':F'],
                           check=True, capture_output=True)
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(value, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, default):
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else default


def probe(token, headers, model, cached=False):
    request = urllib.request.Request(
        SETUP['proxy']['url'].rstrip('/') + '/v1/messages',
        headers={**headers, 'Authorization': 'Bearer ' + token,
                 'X-Claude-Code-Session-Id': str(uuid.uuid4()),
                 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'},
        data=json.dumps({'model': model, 'max_tokens': 8,
                         'messages': [{'role': 'user', 'content': 'Reply with exactly OK.'}]}).encode())
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
            if data.get('type') != 'message' or not data.get('content'):
                if cached:
                    return False
                raise RuntimeError('Gateway returned no completion; Desktop configuration was not changed.')
        return True
    except urllib.error.HTTPError as error:
        if error.code == 401 or cached:
            return False
        raise RuntimeError('Gateway inference check returned HTTP ' + str(error.code) +
                           '. Check model access, quota, and proxy routing. Desktop configuration was not changed.') from None


def pinned_revision(clone_url):
    # Desktop auto-installs a marketplace only when it is pinned to a commit.
    url = clone_url.rstrip('/') + '/info/refs?service=git-upload-pack'
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            refs = response.read().decode('utf-8', 'replace')
    except (urllib.error.URLError, OSError):
        raise RuntimeError('Could not reach the shared marketplace. Check your network connection, then run setup again. '
                           'Desktop configuration was not changed.') from None
    head = re.search(r'[0-9a-f]{4}([0-9a-f]{40}) HEAD(?:\x00|\n)', refs)
    if not head:
        raise RuntimeError('The shared marketplace did not provide a valid Git revision. Desktop configuration was not changed.')
    return head.group(1)


def subscription_token():
    cli = shutil.which('claude')
    if sys.platform == 'win32' and cli and not cli.lower().endswith('.exe'):
        raise RuntimeError('Install the native Claude Code CLI for Windows, then retry setup.')
    if not cli:
        raise RuntimeError('Install the official Claude Code CLI, then run this setup command again.')
    print('Complete Claude subscription sign-in in the browser. Your token stays on this computer.', flush=True)
    env = os.environ.copy()
    for key in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'):
        env.pop(key, None)
    # setup-token owns the terminal input. stdout is captured so the credential
    # cannot appear in setup output, shell history, or a process argument.
    with open('CONIN$' if sys.platform == 'win32' else '/dev/tty') as terminal:
        result = subprocess.run([cli, 'setup-token'], stdin=terminal,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, env=env)
    match = re.search(r'sk-ant-oat[\w-]+', result.stdout)
    if result.returncode != 0 or not match:
        raise RuntimeError('Claude sign-in did not finish. Run claude auth login, then retry setup.')
    return match.group(0)


def desktop_location():
    if sys.platform == 'darwin':
        if not any((root / 'Claude.app').exists() for root in (Path('/Applications'), Path.home() / 'Applications')):
            raise RuntimeError('Install Claude Desktop before running this setup command.')
        return Path.home() / 'Library/Application Support/Claude-3p', ['open', '-a', 'Claude']
    if sys.platform == 'win32':
        local = Path(os.environ['LOCALAPPDATA'])
        # Current MSIX releases and the older per-user installer are both supported.
        package = subprocess.check_output(['powershell.exe', '-NoProfile', '-Command',
            "$p = Get-AppxPackage | Where-Object { $_.Name -in @('Claude', 'AnthropicPBC.Claude') } | Select-Object -First 1; if ($p) { $m = Get-AppxPackageManifest -Package $p.PackageFullName; $a = $m.Package.Applications.Application | Where-Object { $_.Executable -match 'Claude[.]exe$' } | Select-Object -First 1; if ($a) { $p.PackageFamilyName + '!' + $a.Id } }"], text=True).strip()
        executable = local / 'AnthropicClaude/Claude.exe'
        if package:
            launch = ['powershell.exe', '-NoProfile', '-Command', 'Start-Process', 'shell:AppsFolder\\' + package]
        elif executable.is_file():
            launch = [str(executable)]
        else:
            raise RuntimeError('Install Claude Desktop before running this setup command.')
        return local / 'Claude-3p', launch
    if sys.platform.startswith('linux'):
        executable = shutil.which('claude-desktop')
        if not executable:
            raise RuntimeError('Install Claude Desktop for Linux before running this setup command.')
        return Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'Claude-3p', [executable]
    raise RuntimeError('Claude Desktop setup supports macOS, Windows, and Linux.')


def stop_desktop(launch):
    if sys.platform == 'darwin':
        result = subprocess.run(['osascript', '-e', 'tell application "Claude" to quit'], capture_output=True)
        if result.returncode != 0:
            print('Quit Claude Desktop from its app menu to finish setup. Waiting up to two minutes...', flush=True)
        for _ in range(240):
            if subprocess.run(['pgrep', '-f', '/Claude.app/Contents/MacOS/Claude'], capture_output=True).returncode != 0:
                return
            time.sleep(0.5)
    elif sys.platform == 'win32':
        # Close windows gracefully. Never force-stop a session with unsaved work.
        subprocess.run(['powershell.exe', '-NoProfile', '-Command',
            "$p = Get-Process Claude -ErrorAction SilentlyContinue; $p | ForEach-Object { [void]$_.CloseMainWindow() }; $p | Wait-Process -Timeout 10 -ErrorAction Stop"],
            check=True, capture_output=True)
        return
    else:
        executable = Path(launch[0]).resolve()
        processes = []
        for proc in Path('/proc').iterdir():
            try:
                if proc.name.isdigit() and proc.stat().st_uid == os.getuid() and (proc / 'exe').resolve() == executable:
                    processes.append(proc)
                    os.kill(int(proc.name), signal.SIGTERM)
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue
        for _ in range(20):
            if not any((proc / 'exe').exists() for proc in processes):
                return
            time.sleep(0.5)
    raise RuntimeError('Claude Desktop is still running. Finish active tasks, quit Desktop, then rerun setup.')


def prepare_appa_permissions(mcp, old_servers):
    home = Path.home()
    config_dir = Path(os.environ.get('CLAUDE_CONFIG_DIR') or (home / '.claude'))
    settings_path = config_dir / 'settings.json'
    state_root = Path(os.environ['CLAUDE_CONFIG_DIR']) if os.environ.get('CLAUDE_CONFIG_DIR') else home
    state_path = state_root / '.archestra' / 'claude-appa-permissions.json'
    if not mcp:
        if not old_servers or not state_path.exists():
            return None
        server = None
        desired = []
        names = list(old_servers)
    else:
        server = mcp.get('serverName') or ''
        prefix = mcp.get('toolPrefix') or 'archestra__'
        if not re.match(r'^[a-zA-Z0-9_.-]+$', server) or not re.match(r'^[a-zA-Z0-9_]+__$', prefix):
            print(APPA_SKIPPED_WARNING, flush=True)
            return None
        desired = [f'mcp__{server}__{prefix}{tool}' for tool in APPA_TOOLS]
        legacy = [n for n in (mcp.get('legacyServerNames') or []) if isinstance(n, str)]
        names = [server, *legacy, *old_servers]
    settings_raw = settings_path.read_text(encoding='utf-8-sig') if settings_path.exists() else ''
    settings = json.loads(settings_raw) if settings_raw.strip() else {}
    state = json.loads(state_path.read_text(encoding='utf-8-sig')) if state_path.exists() else {}
    if not isinstance(settings, dict) or not isinstance(state, dict):
        raise ValueError('Claude settings and APPA permission state must be JSON objects')
    permissions = settings.setdefault('permissions', {})
    if not isinstance(permissions, dict):
        raise ValueError(f'Claude permissions must be a JSON object in {settings_path}')
    allowed = permissions.get('allow', [])
    if not isinstance(allowed, list) or not all(isinstance(rule, str) for rule in allowed):
        raise ValueError(f'Claude permissions.allow must be an array of strings in {settings_path}')
    for owned in state.values():
        if not isinstance(owned, list) or not all(isinstance(rule, str) for rule in owned):
            raise ValueError('Invalid APPA permission ownership state')
    if not mcp and not any(name in state for name in names):
        return None
    previously_owned = {rule for name in names for rule in state.pop(name, [])}
    allowed = [rule for rule in allowed if rule not in previously_owned or rule in desired]
    owned = [rule for rule in desired if rule in previously_owned or rule not in allowed]
    for rule in desired:
        if rule not in allowed:
            allowed.append(rule)
    permissions['allow'] = allowed
    if server and owned:
        state[server] = owned
    return settings_path, settings, state_path, state


def apply_appa_permissions(appa_plan):
    if not appa_plan:
        return
    settings_path, settings, state_path, state = appa_plan
    backup = settings_path.with_name(settings_path.name + '.archestra-backup')
    if settings_path.exists() and not backup.exists():
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(settings_path, backup)
    # Record ownership first so a failed settings write remains recoverable.
    write_json(state_path, state, protect_acl=False)
    write_json(settings_path, settings, protect_acl=False)


COWORK_MARKETPLACE = 'local-desktop-app-uploads'
COWORK_PLUGIN = 'archestra-appa-permissions'
COWORK_PLUGIN_ID = COWORK_PLUGIN + '@' + COWORK_MARKETPLACE
COWORK_ORG_ID = '00000000-0000-4000-8000-000000000001'


def cowork_scope_dirs(directory, create_primary):
    sessions_root = directory / 'local-agent-mode-sessions'
    scopes = []
    if create_primary or (directory / 'ant-did').exists():
        ant_did_path = directory / 'ant-did'
        if ant_did_path.is_symlink():
            raise RuntimeError('Refusing to replace a symbolic link: ' + str(ant_did_path))
        account_id = ''
        if ant_did_path.exists():
            try:
                decoded = base64.b64decode(ant_did_path.read_text(encoding='utf-8').strip()).decode('utf-8').strip()
                if re.match(r'^[0-9a-fA-F-]{8,}$', decoded):
                    account_id = decoded
            except Exception:
                pass
        if not account_id and create_primary:
            account_id = str(uuid.uuid4())
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            ant_did_path.write_text(base64.b64encode(account_id.encode('utf-8')).decode('ascii'), encoding='utf-8')
        if account_id:
            full_scope = sessions_root / account_id / COWORK_ORG_ID
            short_scope = sessions_root / account_id[:8] / COWORK_ORG_ID[:8]
            primary = full_scope if (full_scope.is_dir() and not short_scope.is_dir()) else short_scope
            if create_primary or primary.is_dir():
                scopes.append(primary)
    if sessions_root.is_dir() and not sessions_root.is_symlink():
        for acct in sorted(sessions_root.iterdir()):
            if not acct.is_dir() or acct.is_symlink() or acct.name.startswith('.') or acct.name == 'skills-plugin':
                continue
            for org in sorted(acct.iterdir()):
                if not org.is_dir() or org.is_symlink() or org.name.startswith('.'):
                    continue
                if (org / 'cowork_settings.json').exists() or (org / 'cowork_plugins').is_dir():
                    if org not in scopes:
                        scopes.append(org)
    return scopes


def apply_cowork_appa_permissions(directory, mcp):
    if mcp:
        server = mcp.get('serverName') or ''
        prefix = mcp.get('toolPrefix') or 'archestra__'
        if not re.match(r'^[a-zA-Z0-9_.-]+$', server) or not re.match(r'^[a-zA-Z0-9_]+__$', prefix):
            return
        now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        tools_pattern = '|'.join(re.escape(tool) for tool in APPA_TOOLS)
        matcher = f'^mcp__{re.escape(server)}__{re.escape(prefix)}({tools_pattern})$'
        allow_output = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
        for scope_dir in cowork_scope_dirs(directory, True):
            plugins_dir = scope_dir / 'cowork_plugins'
            marketplace_dir = plugins_dir / 'marketplaces' / COWORK_MARKETPLACE
            plugin_dir = marketplace_dir / COWORK_PLUGIN
            if plugin_dir.is_symlink():
                raise RuntimeError('Refusing to replace a symbolic link: ' + str(plugin_dir))
            write_json(plugin_dir / '.claude-plugin' / 'plugin.json', {
                'name': COWORK_PLUGIN,
                'version': '1.0.0',
                'description': 'Auto-allow internal OpenAPPA guardrails tools',
                'author': {'name': SETUP['appName']},
                'license': 'MIT',
            }, protect_acl=False)
            write_json(plugin_dir / 'hooks' / 'hooks.json', {
                'hooks': {
                    'PreToolUse': [{
                        'matcher': matcher,
                        'hooks': [{
                            'type': 'command',
                            'command': f"echo '{allow_output}'",
                        }],
                    }],
                },
            }, protect_acl=False)
            mkt_manifest_path = marketplace_dir / '.claude-plugin' / 'marketplace.json'
            mkt_manifest = read_json(mkt_manifest_path, {
                'name': COWORK_MARKETPLACE,
                'version': '1.0.0',
                'description': 'Locally uploaded plugins via Claude Desktop app',
                'owner': {'name': 'Local User'},
                'plugins': [],
            })
            if not isinstance(mkt_manifest, dict):
                mkt_manifest = {'name': COWORK_MARKETPLACE, 'version': '1.0.0', 'plugins': []}
            mkt_plugins = mkt_manifest.get('plugins')
            if not isinstance(mkt_plugins, list):
                mkt_plugins = []
            mkt_plugins = [p for p in mkt_plugins if not (isinstance(p, dict) and p.get('name') == COWORK_PLUGIN)]
            mkt_plugins.append({'name': COWORK_PLUGIN, 'version': '1.0.0', 'source': f'./{COWORK_PLUGIN}'})
            mkt_manifest['plugins'] = mkt_plugins
            write_json(mkt_manifest_path, mkt_manifest, protect_acl=False)
            known_path = plugins_dir / 'known_marketplaces.json'
            known = read_json(known_path, {})
            if not isinstance(known, dict):
                known = {}
            mkt_posix = marketplace_dir.resolve().as_posix()
            known[COWORK_MARKETPLACE] = {
                'source': {'source': 'directory', 'path': mkt_posix},
                'installLocation': mkt_posix,
                'lastUpdated': now_iso,
            }
            write_json(known_path, known, protect_acl=False)
            installed_path = plugins_dir / 'installed_plugins.json'
            installed = read_json(installed_path, {'version': 2, 'plugins': {}})
            if not isinstance(installed, dict):
                installed = {'version': 2, 'plugins': {}}
            installed['version'] = 2
            plugins_map = installed.get('plugins')
            if not isinstance(plugins_map, dict):
                plugins_map = {}
                installed['plugins'] = plugins_map
            existing_entries = plugins_map.get(COWORK_PLUGIN_ID)
            installed_at = now_iso
            if isinstance(existing_entries, list):
                for item in existing_entries:
                    if isinstance(item, dict) and isinstance(item.get('installedAt'), str):
                        installed_at = item['installedAt']
                        break
            plugins_map[COWORK_PLUGIN_ID] = [{
                'scope': 'user',
                'installPath': plugin_dir.resolve().as_posix(),
                'version': '1.0.0',
                'installedAt': installed_at,
                'lastUpdated': now_iso,
            }]
            write_json(installed_path, installed, protect_acl=False)
            cowork_settings_path = scope_dir / 'cowork_settings.json'
            cowork_settings = read_json(cowork_settings_path, {})
            if not isinstance(cowork_settings, dict):
                cowork_settings = {}
            enabled_plugins = cowork_settings.get('enabledPlugins')
            if not isinstance(enabled_plugins, dict):
                enabled_plugins = {}
                cowork_settings['enabledPlugins'] = enabled_plugins
            enabled_plugins[COWORK_PLUGIN_ID] = True
            write_json(cowork_settings_path, cowork_settings, protect_acl=False)
        return
    for scope_dir in cowork_scope_dirs(directory, False):
        plugins_dir = scope_dir / 'cowork_plugins'
        marketplace_dir = plugins_dir / 'marketplaces' / COWORK_MARKETPLACE
        plugin_dir = marketplace_dir / COWORK_PLUGIN
        if plugin_dir.is_dir() and not plugin_dir.is_symlink():
            shutil.rmtree(plugin_dir, ignore_errors=True)
        mkt_manifest_path = marketplace_dir / '.claude-plugin' / 'marketplace.json'
        if mkt_manifest_path.exists():
            mkt_manifest = read_json(mkt_manifest_path, {})
            if isinstance(mkt_manifest, dict) and isinstance(mkt_manifest.get('plugins'), list):
                mkt_manifest['plugins'] = [p for p in mkt_manifest['plugins'] if not (isinstance(p, dict) and p.get('name') == COWORK_PLUGIN)]
                write_json(mkt_manifest_path, mkt_manifest, protect_acl=False)
        installed_path = plugins_dir / 'installed_plugins.json'
        if installed_path.exists():
            installed = read_json(installed_path, {})
            if isinstance(installed, dict) and isinstance(installed.get('plugins'), dict) and COWORK_PLUGIN_ID in installed['plugins']:
                installed['plugins'].pop(COWORK_PLUGIN_ID, None)
                write_json(installed_path, installed, protect_acl=False)
        cowork_settings_path = scope_dir / 'cowork_settings.json'
        if cowork_settings_path.exists():
            cowork_settings = read_json(cowork_settings_path, {})
            if isinstance(cowork_settings, dict) and isinstance(cowork_settings.get('enabledPlugins'), dict) and COWORK_PLUGIN_ID in cowork_settings['enabledPlugins']:
                cowork_settings['enabledPlugins'].pop(COWORK_PLUGIN_ID, None)
                write_json(cowork_settings_path, cowork_settings, protect_acl=False)


def main():
    if sys.version_info < (3, 9):
        raise RuntimeError('Install Python 3.9 or newer, then retry setup.')
    directory, launch = desktop_location()
    library = directory / 'configLibrary'
    profile_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'archestra-desktop:managed'))
    profile_path = library / (profile_id + '.json')
    meta_path = library / '_meta.json'
    app_path = directory / 'claude_desktop_config.json'
    previous = read_json(profile_path, {})
    metadata = read_json(meta_path, {'entries': []})
    if not isinstance(metadata.get('entries'), list):
        raise RuntimeError('Desktop profile library has an unexpected format; no files were changed.')
    managed = {}
    for entry in metadata['entries']:
        entry_id = entry.get('id', '')
        try:
            uuid.UUID(entry_id)
        except (ValueError, TypeError, AttributeError):
            continue
        candidate = read_json(library / (entry_id + '.json'), {})
        if not isinstance(candidate, dict):
            continue
        urls = [candidate.get('inferenceGatewayBaseUrl')]
        urls += [server.get('url') for server in (candidate.get('managedMcpServers') or []) if isinstance(server, dict)]
        urls += [marketplace.get('url') for marketplace in (candidate.get('allowedPluginMarketplaces') or []) if isinstance(marketplace, dict)]
        legacy_ids = {str(uuid.uuid5(uuid.NAMESPACE_URL, 'archestra-desktop:' + url)) for url in urls if isinstance(url, str)}
        if entry_id == profile_id or entry_id in legacy_ids:
            managed[entry_id] = candidate
    previous = managed.get(metadata.get('appliedId'), previous)
    if not isinstance(previous, dict):
        previous = {}
    proxy = SETUP['proxy']
    subscription = bool(proxy and proxy['authMode'] == 'provider-key')
    # Rebuild the managed connection so omitted resources cannot remain active.
    profile = {}
    if proxy:
        headers = {'X-Archestra-Agent-Id': 'anthropic_claude_desktop'}
        if proxy.get('passthroughVirtualKey'):
            headers['X-Archestra-Virtual-Key'] = proxy['passthroughVirtualKey']
        if subscription:
            headers['anthropic-beta'] = 'oauth-2025-04-20'
        model = proxy.get('model') or 'claude-haiku-4-5-20251001'
        token = (previous.get('inferenceGatewayApiKey') or '') if subscription else proxy['virtualKey']
        verified = subscription and isinstance(token, str) and token.startswith('sk-ant-oat') and probe(token, headers, model, cached=True)
        if subscription and not verified:
            token = subscription_token()
        if not verified and (not token or not probe(token, headers, model)):
            raise RuntimeError('Gateway rejected the credential. Desktop configuration was not changed.')
        profile.update({
            'inferenceProvider': 'gateway', 'inferenceCredentialKind': 'static',
            'inferenceGatewayBaseUrl': proxy['url'], 'inferenceGatewayApiKey': token,
            'inferenceGatewayAuthScheme': 'bearer', 'inferenceCustomHeaders': headers,
            # An explicit inferenceModels list overrides discovery and would
            # restrict the picker to the model used for the connection check.
            'modelDiscoveryEnabled': True,
            'coworkEgressAllowedHosts': ['*'],
            # Third-party mode keeps its own history; enable Settings > Import
            # so users can copy their Claude.ai conversations into it.
            'claudeAiImport': {'enabled': True, 'bannerBehavior': 'show'},
        })
    if SETUP.get('mcp'):
        mcp = SETUP['mcp']
        profile['managedMcpServers'] = [{'name': mcp['serverName'], 'transport': 'http',
                                       'url': mcp['url'], 'oauth': {'mode': 'dcr'}}]
        instructions = SETUP.get('runtimeHandoffInstructions')
        if instructions:
            if len(instructions) > 3000:
                raise RuntimeError('Claude Desktop handoff instructions must be at most 3,000 characters. Shorten them in Connection settings and retry setup.')
            profile['organizationInstructions'] = instructions
    if SETUP.get('skills'):
        skills = SETUP['skills']
        marketplace = {'source': 'git', 'url': skills['cloneUrl'],
                       'expectedName': skills['marketplaceName']}
        if skills['cloneUrl'].startswith('https://'):
            marketplace.update({'ref': pinned_revision(skills['cloneUrl']),
                                'installationPreference': 'auto_install'})
        profile['allowedPluginMarketplaces'] = [marketplace]
    old_servers = [
        server.get('name')
        for candidate in [previous, *managed.values()]
        for server in (candidate.get('managedMcpServers') if isinstance(candidate.get('managedMcpServers'), list) else [])
        if isinstance(server, dict) and isinstance(server.get('name'), str)
    ]
    appa_plan = prepare_appa_permissions(SETUP.get('mcp'), old_servers)
    print('Applying Desktop setup. Finish any active tasks before continuing.', flush=True)
    stop_desktop(launch)
    # Preserve other profiles and application preferences. Keep the first backup
    # so a repeat installation cannot replace the original restore point.
    app_config = read_json(app_path, {})
    old_paths = [library / (entry_id + '.json') for entry_id in managed if entry_id != profile_id]
    for path in (profile_path, meta_path, app_path, *old_paths):
        backup = path.with_name(path.name + '.before-archestra')
        if path.exists() and not backup.exists():
            write_json(backup, read_json(path, {}))
    entries = [entry for entry in metadata['entries'] if entry.get('id') != profile_id and entry.get('id') not in managed]
    entries.append({'id': profile_id, 'name': SETUP['appName'] + ' Desktop'})
    metadata.update({'appliedId': profile_id, 'entries': entries})
    app_config['deploymentMode'] = '3p' if proxy else '1p'
    apply_appa_permissions(appa_plan)
    apply_cowork_appa_permissions(directory, SETUP.get('mcp'))
    write_json(profile_path, profile)
    write_json(meta_path, metadata)
    write_json(app_path, app_config)
    for path in old_paths:
        path.unlink(missing_ok=True)
    started = subprocess.Popen(launch, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        if started.wait(timeout=2) != 0:
            raise RuntimeError('Configuration saved, but Desktop could not start. Open it from your applications menu to see the startup error.')
    except subprocess.TimeoutExpired:
        pass
    print('Desktop is configured. Send a message and check LLM Proxy Logs.')
    if SETUP.get('mcp'):
        print('In Desktop Settings > Connectors, connect the gateway and finish its browser sign-in.')
    if SETUP.get('skills'):
        if SETUP['skills']['cloneUrl'].startswith('https://'):
            print('Your shared skills and plugins install automatically after Desktop restarts.')
        else:
            print('In Desktop Settings > Plugins, install your shared marketplace.')
    if proxy:
        print('In Desktop Settings > Import, bring over your Claude.ai conversations. Rerun the import later to add newer conversations.')
    if subscription:
        print('The subscription token lasts up to one year. Rerun setup after expiration or revocation.')
    print('To switch back, rerun the previous deployment installer or select a manually created inference profile.')


try:
    main()
except Exception as error:
    print('Desktop setup failed: ' + str(error), file=sys.stderr)
    sys.exit(1)
`;
