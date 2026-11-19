/** Local checks only: no model requests, package installs, or permission changes. */
export const CODEX_SANDBOX_PREFLIGHT = String.raw`
// Desktop caches its Linux executable separately from any Codex on WSL's PATH.
// After an upgrade several cache entries may remain. Its spawn log identifies
// the executable actually used; never guess from a cache directory's age.
function desktopWslCodex(home) {
  if (process.env.ARCHESTRA_CODEX_WSL_EXECUTABLE) return '';
  const fs = require('node:fs');
  const root = path.join(home, 'bin', 'wsl');
  let candidates = [];
  try {
    candidates = fs.readdirSync(root).filter(name => /^[a-f0-9]{8,64}$/i.test(name))
      .map(name => path.join(root, name, 'codex')).filter(existsSync);
  } catch {}
  {
    const local = process.env.LOCALAPPDATA;
    const roots = local ? [path.join(local, 'Codex', 'Logs')] : [];
    if (local) {
      try {
        const packages = path.join(local, 'Packages');
        for (const name of fs.readdirSync(packages)) {
          if (/^OpenAI\.(?:Codex|ChatGPT)_/i.test(name)) roots.push(path.join(packages, name, 'LocalCache', 'Local', 'Codex', 'Logs'));
        }
      } catch {}
    }
    const logs = [];
    function collect(dir, depth) {
      if (depth > 4) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) collect(file, depth + 1);
          else if (entry.isFile() && entry.name.endsWith('.log')) {
            const stat = fs.statSync(file);
            if (stat.size <= 8 * 1024 * 1024) logs.push({ file, modified: stat.mtimeMs });
          }
        }
      } catch {}
    }
    for (const dir of roots) collect(dir, 0);
    const normalize = value => value.replace(/\\/g, '/').toLowerCase();
    let selected;
    for (const log of logs.sort((a, b) => b.modified - a.modified).slice(0, 32)) {
      let text;
      try { text = fs.readFileSync(log.file, 'utf8'); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes('stdio_transport_spawned') || !/\bspawnCommand=wsl\.exe(?:\s|$)/.test(line)) continue;
        const executable = /\bexecutablePath=(.+?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/.exec(line)?.[1];
        const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.exec(line)?.[0];
        const normalized = executable && normalize(executable);
        const cachePrefix = normalize(root) + '/';
        if (!normalized || !normalized.startsWith(cachePrefix) || !/^[a-f0-9]{8,64}\/codex$/i.test(normalized.slice(cachePrefix.length))) continue;
        const candidate = candidates.find(file => normalize(file) === normalized);
        if (timestamp && (!selected || timestamp > selected.timestamp)) selected = { candidate, timestamp };
      }
    }
    if (selected?.candidate) return selected.candidate;
    if (selected) throw new Error('The ChatGPT desktop app\'s last selected Linux Codex executable is missing. Open a local Work or Codex conversation to repair the desktop installation, then rerun setup. No client configuration was changed.');
  }
  if (candidates.length === 1) return candidates[0];
  throw new Error('Could not identify the ChatGPT desktop app\'s Linux Codex executable. Open a local Work or Codex conversation once, then rerun setup. If several desktop versions remain, set ARCHESTRA_CODEX_WSL_EXECUTABLE to the Linux path of the desktop executable before retrying. No client configuration was changed.');
}
function assertSandboxReady(executable) {
  const options = { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 };
  let command;
  let args;
  let environment;
  if (process.platform === 'win32') {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const file = path.join(home, 'config.toml');
    if (!existsSync(file) || !runsCodexInWsl(readFileSync(file, 'utf8'))) return;
    const distribution = process.env.ARCHESTRA_CODEX_WSL_DISTRIBUTION;
    environment = distribution ? 'The WSL sandbox in ' + distribution : "WSL's default-distribution sandbox";
    const prefix = [...(distribution ? ['--distribution', distribution] : []), '--exec'];
    const desktop = desktopWslCodex(home);
    // Positional arguments keep Windows homes, spaces and overrides out of shell code.
    const locate = 'home=$(wslpath -u "$1") || exit; if [ -n "$3" ]; then executable=$3; else executable=$(wslpath -u "$2") || exit; fi; case "$executable" in /*) ;; *) echo "The desktop Codex executable must be an absolute Linux path" >&2; exit 1;; esac; [ -x "$executable" ] || { echo "The desktop Linux Codex executable is unavailable" >&2; exit 127; }; printf "%s\\n%s\\n" "$home" "$executable"';
    const resolved = spawnSync('wsl.exe', [...prefix, '/bin/sh', '-c', locate, 'archestra-wsl-codex', home, desktop, process.env.ARCHESTRA_CODEX_WSL_EXECUTABLE || ''], options);
    const lines = (resolved.stdout || '').trim().split(/\r?\n/);
    if (resolved.error || resolved.status !== 0 || lines.length !== 2 || !lines.every(line => line.startsWith('/'))) {
      throw new Error('Could not locate the ChatGPT desktop app\'s Codex executable in WSL. Check ARCHESTRA_CODEX_WSL_DISTRIBUTION and ARCHESTRA_CODEX_WSL_EXECUTABLE, then rerun setup. No client configuration was changed.' + codexErrorDetail(resolved, '', ''));
    }
    command = 'wsl.exe';
    args = [...prefix, 'env', 'CODEX_HOME=' + lines[0], lines[1]];
  } else if (process.platform === 'linux' && executable) {
    environment = "Codex's Linux sandbox";
    ({ command, args } = codexEntry(executable));
  } else {
    return;
  }
  // Older CLIs spell this "sandbox linux"; newer ones use "sandbox".
  const help = spawnSync(command, [...args, 'help', 'sandbox'], options);
  if (help.error || help.status !== 0) {
    throw new Error('Could not check the Codex sandbox. Update the Codex CLI and rerun setup.' + codexErrorDetail(help, '', ''));
  }
  const legacy = /^\s+linux\s/m.test(help.stdout || '') ? ['linux'] : [];
  // Exercise that CLI's own sandbox, including its bundled bwrap fallback.
  // A harmless read-only command needs neither a model nor gateway access.
  const result = spawnSync(command, [...args, 'sandbox', ...legacy, '-c', 'sandbox_mode="read-only"', '--', '/bin/true'], options);
  if (!result.error && result.status === 0) return;
  const where = process.platform === 'win32' ? 'In the checked WSL distribution' : 'On this Linux computer';
  throw new Error(environment + ' could not run a harmless command. '
    + where + ', install bubblewrap (Ubuntu/Debian: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap), then rerun setup. '
    + 'If bubblewrap is already installed, check its user-namespace support: https://learn.chatgpt.com/docs/sandboxing#prerequisites. '
    + 'Keep the sandbox enabled.' + codexErrorDetail(result, '', ''));
}
`;
