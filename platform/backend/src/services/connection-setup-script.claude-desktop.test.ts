import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  renderSetupScript,
  type SetupScriptContext,
} from "./connection-setup-script";

const exec = promisify(execFile);

// Real generated Python and real files; only the native CLI and network are faked.
test.each([
  { os: "darwin", auth: "provider-key", quotaFailure: false },
  { os: "darwin", auth: "virtual-key", quotaFailure: false },
  { os: "linux", auth: "provider-key", quotaFailure: false },
  { os: "linux", auth: "virtual-key", quotaFailure: false },
  { os: "win32", auth: "provider-key", quotaFailure: false },
  { os: "win32", auth: "virtual-key", quotaFailure: false },
  { os: "darwin", auth: "provider-key", quotaFailure: true },
  { os: "linux", auth: "none", quotaFailure: false },
] as const)("Desktop $os $auth installation (quota failure=$quotaFailure)", async ({
  os,
  auth,
  quotaFailure,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-installer-"));
  const context: SetupScriptContext = {
    clientId: "claude-desktop",
    platform: os === "win32" ? "windows" : os === "linux" ? "linux" : "macos",
    appName: "Test Platform",
    proxy:
      auth === "none"
        ? null
        : {
            authMode: auth,
            provider: "anthropic",
            providerLabel: "Anthropic",
            url: "https://proxy.example/v1/anthropic",
            proxyName: "default",
            virtualKey: auth === "virtual-key" ? "archestra-test-key" : null,
            virtualKeyName: null,
            passthroughVirtualKey:
              auth === "provider-key" ? "archestra-test-user" : null,
            model: null,
          },
    mcp: {
      serverName: "test-gateway",
      url: "https://proxy.example/v1/mcp/test",
    },
    skills: null,
  };
  const rendered = renderSetupScript(context);
  const script =
    os === "win32"
      ? rendered.split("$installer = @'\n")[1].split("\n'@")[0]
      : rendered
          .split("python3 <<'ARCHESTRA_DESKTOP_PY'\n")[1]
          .split("\nARCHESTRA_DESKTOP_PY")[0];
  try {
    await writeFile(path.join(directory, "installer.py"), script);
    await writeFile(
      path.join(directory, "test.py"),
      `
import io, json, os, pathlib, runpy, subprocess, sys, urllib.error
from unittest.mock import patch
root = pathlib.Path(__file__).parent
home = root / 'home'
(home / 'Applications/Claude.app').mkdir(parents=True)
target_os = '${os}'
base = home / ('LocalAppData' if target_os == 'win32' else 'xdg' if target_os == 'linux' else 'Library/Application Support')
library = base / 'Claude-3p/configLibrary'
library.mkdir(parents=True)
original = {'appliedId': 'previous', 'entries': [{'id': 'previous', 'name': 'Existing profile'}]}
(library / '_meta.json').write_text(json.dumps(original))
token = '${auth === "virtual-key" ? "archestra-test-key" : "sk-ant-oat01-test-subscription"}'
calls = []
def native(args, **kwargs):
    calls.append(args)
    # Desktop may reject the Apple event while the user quits through its menu.
    status = (0 if sum(call[0] == 'pgrep' for call in calls) == 1 else 1) if args[0] == 'pgrep' else 1 if args[0] == 'osascript' else 0
    return subprocess.CompletedProcess(args, status,
        stdout=('Token: ' + token) if 'setup-token' in args else '')
def upstream(request, **kwargs):
    assert request.get_header('Authorization') == 'Bearer ' + token
    assert request.get_header('X-archestra-virtual-key') == ${auth === "provider-key" ? "'archestra-test-user'" : "None"}
    assert request.get_header('Anthropic-beta') == ${auth === "provider-key" ? "'oauth-2025-04-20'" : "None"}
    if ${quotaFailure ? "True" : "False"}:
        raise urllib.error.HTTPError(request.full_url, 429, 'quota', {}, None)
    return io.StringIO(json.dumps({'type':'message','content':[{'type':'text','text':'OK'}]}))
real_open = open
def terminal(file, *args, **kwargs):
    return io.StringIO() if str(file) in ('/dev/tty', 'CONIN$') else real_open(file, *args, **kwargs)
with patch('sys.platform', target_os), patch.dict(os.environ, {'LOCALAPPDATA': str(base), 'XDG_CONFIG_HOME': str(base)}), patch('subprocess.Popen') as desktop_process, patch('pathlib.Path.iterdir', return_value=iter([])) if target_os == 'linux' else patch('time.sleep'), patch('subprocess.check_output', return_value='Claude_test!App'), patch('pathlib.Path.home', return_value=home), patch('shutil.which', return_value='/bin/claude.exe'), patch('subprocess.run', side_effect=native), patch('urllib.request.urlopen', side_effect=upstream), patch('builtins.open', side_effect=terminal):
    desktop_process.return_value.wait.return_value = 0
    if ${quotaFailure ? "True" : "False"}:
        try:
            runpy.run_path(str(root / 'installer.py'))
            raise AssertionError('Expected quota rejection')
        except SystemExit as error:
            assert error.code == 1
        assert json.loads((library / '_meta.json').read_text()) == original
        assert sorted(os.listdir(library)) == ['_meta.json']
        assert not any(args[0] == 'osascript' for args in calls)
    else:
        runpy.run_path(str(root / 'installer.py'))
        runpy.run_path(str(root / 'installer.py'))
        metadata = json.loads((library / '_meta.json').read_text())
        assert len(metadata['entries']) == 2
        assert metadata['entries'][0] == original['entries'][0]
        profile_path = library / (metadata['appliedId'] + '.json')
        profile = json.loads(profile_path.read_text())
        if ${auth === "none" ? "False" : "True"}:
            assert profile['inferenceGatewayApiKey'] == token
            assert profile['inferenceCustomHeaders'].get('X-Archestra-Virtual-Key') == ${auth === "provider-key" ? "'archestra-test-user'" : "None"}
        else:
            assert 'inferenceProvider' not in profile
        assert profile['managedMcpServers'][0]['url'] == 'https://proxy.example/v1/mcp/test'
        assert profile_path.stat().st_mode & 0o777 == 0o600
        assert json.loads((library / '_meta.json.before-archestra').read_text()) == original
        assert sum('setup-token' in args for args in calls) == ${auth === "provider-key" ? 1 : 0}
        assert json.loads((library.parent / 'claude_desktop_config.json').read_text()).get('deploymentMode') == ${auth === "none" ? "None" : "'3p'"}
        desktop_process.return_value.wait.return_value = 1
        try:
            runpy.run_path(str(root / 'installer.py'))
            raise AssertionError('Expected failed Desktop launch to fail setup')
        except SystemExit as error:
            assert error.code == 1
        assert json.loads(profile_path.read_text()) == profile
`,
    );
    const result = await exec("python3", [path.join(directory, "test.py")]);
    expect(result.stdout).not.toContain("sk-ant-oat01-test-subscription");
    if (quotaFailure) expect(result.stderr).toContain("HTTP 429");
    else {
      expect(result.stdout).toContain("Desktop is configured");
      if (os === "darwin") {
        expect(result.stdout).toContain(
          "Quit Claude Desktop from its app menu",
        );
      }
      expect(result.stderr).toContain("Desktop could not start");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
