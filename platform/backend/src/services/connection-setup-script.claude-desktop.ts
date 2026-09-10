import type { SetupScriptContext } from "./connection-setup-script";

/** Runs locally; subscription credentials never enter setup storage. */
export function renderClaudeDesktopSetupScript(
  ctx: SetupScriptContext,
): string {
  const payload = Buffer.from(JSON.stringify(ctx)).toString("base64");
  const python = `import base64
import json
SETUP = json.loads(base64.b64decode('${payload}'))
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


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise RuntimeError('Refusing to replace a symbolic link: ' + str(path))
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        if sys.platform == 'win32':
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


def probe(token, headers, model):
    request = urllib.request.Request(
        SETUP['proxy']['url'].rstrip('/') + '/v1/messages',
        headers={**headers, 'Authorization': 'Bearer ' + token,
                 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'},
        data=json.dumps({'model': model, 'max_tokens': 8,
                         'messages': [{'role': 'user', 'content': 'Reply with exactly OK.'}]}).encode())
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
            if data.get('type') != 'message' or not data.get('content'):
                raise RuntimeError('Gateway returned no completion; Desktop configuration was not changed.')
        return True
    except urllib.error.HTTPError as error:
        if error.code == 401:
            return False
        raise RuntimeError('Gateway inference check returned HTTP ' + str(error.code) +
                           '. Check model access, quota, and proxy routing. Desktop configuration was not changed.') from None


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
            launch = ['explorer.exe', 'shell:AppsFolder\\' + package]
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


def main():
    if sys.version_info < (3, 9):
        raise RuntimeError('Install Python 3.9 or newer, then retry setup.')
    directory, launch = desktop_location()
    library = directory / 'configLibrary'
    target = SETUP.get('proxy') or SETUP.get('mcp') or SETUP['skills']
    profile_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'archestra-desktop:' + (target.get('url') or target['cloneUrl'])))
    profile_path = library / (profile_id + '.json')
    meta_path = library / '_meta.json'
    app_path = directory / 'claude_desktop_config.json'
    previous = read_json(profile_path, {})
    metadata = read_json(meta_path, {'entries': []})
    if not isinstance(metadata.get('entries'), list):
        raise RuntimeError('Desktop profile library has an unexpected format; no files were changed.')
    proxy = SETUP['proxy']
    subscription = bool(proxy and proxy['authMode'] == 'provider-key')
    profile = previous.copy()
    if proxy:
        headers = {'X-Archestra-Agent-Id': 'anthropic_claude_desktop'}
        if proxy.get('passthroughVirtualKey'):
            headers['X-Archestra-Virtual-Key'] = proxy['passthroughVirtualKey']
        if subscription:
            headers['anthropic-beta'] = 'oauth-2025-04-20'
        model = proxy.get('model') or 'claude-haiku-4-5-20251001'
        token = previous.get('inferenceGatewayApiKey', '') if subscription else proxy['virtualKey']
        verified = subscription and token.startswith('sk-ant-oat') and probe(token, headers, model)
        if subscription and not verified:
            token = subscription_token()
        if not verified and (not token or not probe(token, headers, model)):
            raise RuntimeError('Gateway rejected the credential. Desktop configuration was not changed.')
        profile.update({
            'inferenceProvider': 'gateway', 'inferenceCredentialKind': 'static',
            'inferenceGatewayBaseUrl': proxy['url'], 'inferenceGatewayApiKey': token,
            'inferenceGatewayAuthScheme': 'bearer', 'inferenceCustomHeaders': headers,
            'inferenceModels': [{'name': model}],
        })
    if SETUP.get('mcp'):
        mcp = SETUP['mcp']
        profile['managedMcpServers'] = [{'name': mcp['serverName'], 'transport': 'http',
                                       'url': mcp['url'], 'oauth': {'mode': 'dcr'}, 'source': 'user'}]
    if SETUP.get('skills'):
        skills = SETUP['skills']
        profile['allowedPluginMarketplaces'] = [{'source': 'git', 'url': skills['cloneUrl'],
                                                 'expectedName': skills['marketplaceName']}]
    print('Applying Desktop setup. Finish any active tasks before continuing.', flush=True)
    stop_desktop(launch)
    # Preserve other profiles and application preferences. Keep the first backup
    # so a repeat installation cannot replace the original restore point.
    app_config = read_json(app_path, {})
    for path in (profile_path, meta_path, app_path):
        backup = path.with_name(path.name + '.before-archestra')
        if path.exists() and not backup.exists():
            write_json(backup, read_json(path, {}))
    entries = [entry for entry in metadata['entries'] if entry.get('id') != profile_id]
    entries.append({'id': profile_id, 'name': SETUP['appName'] + ' Desktop'})
    metadata.update({'appliedId': profile_id, 'entries': entries})
    if proxy:
        app_config['deploymentMode'] = '3p'
    write_json(profile_path, profile)
    write_json(meta_path, metadata)
    write_json(app_path, app_config)
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
        print('In Desktop Settings > Plugins, install your shared marketplace.')
    if subscription:
        print('The subscription token lasts up to one year. Rerun setup after expiration or revocation.')
    print('To revert, select your previous profile in Configure Third-Party Inference and restart Desktop.')


try:
    main()
except Exception as error:
    print('Desktop setup failed: ' + str(error), file=sys.stderr)
    sys.exit(1)
`;
