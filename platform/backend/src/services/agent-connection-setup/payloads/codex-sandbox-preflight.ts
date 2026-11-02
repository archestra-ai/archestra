/** Local checks only: no model requests, package installs, or permission changes. */
export const CODEX_SANDBOX_PREFLIGHT = String.raw`
function assertSandboxReady(executable) {
  const options = { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 };
  let result;
  let environment;
  if (process.platform === 'win32') {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const file = path.join(home, 'config.toml');
    if (!existsSync(file) || !runsCodexInWsl(readFileSync(file, 'utf8'))) return;
    const distribution = process.env.ARCHESTRA_CODEX_WSL_DISTRIBUTION;
    environment = distribution ? 'The WSL sandbox in ' + distribution : "WSL's default-distribution sandbox";
    // Check WSL rather than accepting a successful Windows CLI command.
    // Local setup can target a non-default distribution explicitly.
    const probe = 'command -v bwrap >/dev/null 2>&1 || { echo "bubblewrap (bwrap) is missing in WSL" >&2; exit 127; }; exec bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user --unshare-pid --unshare-net -- /bin/true';
    result = spawnSync('wsl.exe', [...(distribution ? ['--distribution', distribution] : []), '--exec', '/bin/sh', '-c', probe], options);
  } else if (process.platform === 'linux' && executable) {
    environment = "Codex's Linux sandbox";
    const { command, args } = codexEntry(executable);
    // Older CLIs spell this "sandbox linux"; newer ones use "sandbox".
    const help = spawnSync(command, [...args, 'help', 'sandbox'], options);
    if (help.error || help.status !== 0) {
      throw new Error('Could not check the Codex sandbox. Update the Codex CLI and rerun setup.' + codexErrorDetail(help, '', ''));
    }
    const legacy = /^\s+linux\s/m.test(help.stdout || '') ? ['linux'] : [];
    // Exercise the CLI's own sandbox, including its bundled bwrap fallback.
    // A harmless read-only command needs neither a model nor gateway access.
    result = spawnSync(command, [...args, 'sandbox', ...legacy, '-c', 'sandbox_mode="read-only"', '--', '/bin/true'], options);
  } else {
    return;
  }
  if (!result.error && result.status === 0) return;
  const where = process.platform === 'win32' ? 'In the checked WSL distribution' : 'On this Linux computer';
  throw new Error(environment + ' could not run a harmless command. '
    + where + ', install bubblewrap (Ubuntu/Debian: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap), then rerun setup. '
    + 'If bubblewrap is already installed, check its user-namespace support: https://learn.chatgpt.com/docs/sandboxing#prerequisites. '
    + 'Keep the sandbox enabled.' + codexErrorDetail(result, '', ''));
}
`;
