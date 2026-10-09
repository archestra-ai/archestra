import { STARTUP_GUARD_INSTALL } from "@archestra/shared/consts";
import { CODEX_HANDOFF_HELPER } from "./codex-handoff";

/** Runs before any native registration; recovery belongs to this attempt, not the first install. */
export const CODEX_SETUP_PREFLIGHT = String.raw`
const setupOffset = process.argv[1] === '-' ? 1 : 0;
const setupExecutable = process.argv[1 + setupOffset];
const setupProxy = process.argv[2 + setupOffset] === 'proxy';
// The handoff helper normally runs from a file; normalize argv for node -e.
process.argv = [process.execPath, 'handoff.cjs', setupProxy ? '--preflight' : '--setup-only', setupExecutable];
${CODEX_HANDOFF_HELPER}
if (!process.exitCode) {
  const { copyFileSync } = require('node:fs');
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const guard = ${JSON.stringify(STARTUP_GUARD_INSTALL.codex)};
  const userHome = os.homedir();
  const guardPath = path.join(userHome, process.platform === 'win32' ? guard.psScriptRelpath : guard.scriptRelpath);
  const files = [path.join(home, 'config.toml'), path.join(home, 'archestra-direct-model-catalog.json'),
    guardPath, guardPath + '.handoff.cjs', guardPath + '.prompt.md', guardPath + '.verify.ps1', path.join(userHome, guard.skipRelpath)];
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Environment]::GetFolderPath("MyDocuments"); $PROFILE.CurrentUserAllHosts'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (result.status !== 0) throw new Error('Could not locate PowerShell profiles for setup recovery.');
    const [documents, fallback] = result.stdout.trim().split(/\r?\n/);
    for (const edition of ['WindowsPowerShell', 'PowerShell']) if (documents) files.push(path.join(documents, edition, 'profile.ps1'));
    if (fallback) files.push(fallback);
  } else {
    for (const profile of ['.bashrc', '.zshrc', '.bash_profile', '.bash_login', '.profile']) files.push(path.join(userHome, profile));
  }
  mkdirSync(home, { recursive: true });
  const backup = mkdtempSync(path.join(home, 'archestra-setup-'));
  chmodSync(backup, 0o700);
  try {
    const manifest = [...new Set(files)].map((file, index) => {
      const present = existsSync(file);
      const mode = present ? statSync(file).mode & 0o777 : null;
      if (present) { copyFileSync(file, path.join(backup, String(index))); chmodSync(path.join(backup, String(index)), 0o600); }
      return { file, present, mode, index };
    });
    writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    writeFileSync(path.join(backup, 'recover.cjs'), ${JSON.stringify(`
const fs = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
for (const { file, present, mode, index } of manifest) {
  if (present) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(__dirname, String(index)), file);
    fs.chmodSync(file, mode);
  } else fs.rmSync(file, { force: true });
}
console.log('Restored the client configuration and launch checks from before this setup attempt. Open a new terminal.');
console.log('OAuth grants, credentials, downloaded plugins and server-side connection records were not rolled back. Review the connection in Archestra; sign in again if setup replaced your login.');
`)}, { mode: 0o600 });
    process.stdout.write(backup);
  } catch (error) { rmSync(backup, { recursive: true, force: true }); throw error; }
}
`;
