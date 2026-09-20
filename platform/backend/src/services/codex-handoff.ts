/** Local helper installed beside the guard. Reads native config without starting a session. */
export const CODEX_HANDOFF_HELPER = String.raw`
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const args = process.argv.slice(3);
const base64Output = args[0] === '--output-base64';
if (base64Output) args.shift();
// Model selection does not change instruction layering. Other overrides belong
// to the caller; do not resolve a different profile, directory, or remote.
let overridden = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--') break;
  if (arg === '-c' || arg === '--config' || arg.startsWith('--config=') || /^-c.+/.test(arg)) {
    const value = arg === '-c' || arg === '--config' ? args[++i] : arg.startsWith('--config=') ? arg.slice(9) : arg.slice(2);
    if (!/^(model|model_provider|model_reasoning_effort)\s*=/.test(value || '')) overridden = true;
  } else if (/^(?:-C|-p|--cd|--profile|--remote|--ignore-user-config)(?:=|$)/.test(arg) || /^-[Cp].+/.test(arg)) overridden = true;
}
if (overridden) {
  process.stderr.write('Runtime handoff instructions skipped: explicit Codex configuration takes precedence.\n');
  process.exit(0);
}
let prompt;
try { prompt = readFileSync(process.argv[2], 'utf8'); }
catch { process.exit(0); }
// Windows npm installs expose codex.cmd. Only this fixed command enters the shell.
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: process.platform === 'win32' });
let finished = false;
const timer = setTimeout(() => finish(), 3000);
function finish(value) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (value !== undefined) {
    const output = 'developer_instructions=' + JSON.stringify(value);
    process.stdout.write(base64Output ? Buffer.from(output, 'utf8').toString('base64') : output);
  }
  else process.stderr.write('Runtime handoff instructions skipped: could not read Codex configuration.\n');
  child.stdin.destroy();
  child.stdout.destroy();
  child.kill();
  child.unref();
}
function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
child.on('error', () => finish());
child.on('exit', () => finish());
child.stdin.on('error', () => finish());
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  try {
    const reply = JSON.parse(line);
    if (reply.id === 1) {
      if (reply.error) return finish();
      send({ method: 'initialized' });
      send({ id: 2, method: 'config/read', params: { includeLayers: false, cwd: process.cwd() } });
    } else if (reply.id === 2) {
      const config = reply.result?.config;
      if (reply.error || !config || typeof config !== 'object') return finish();
      const existing = config.developer_instructions;
      if (existing != null && typeof existing !== 'string') return finish();
      finish(existing ? existing + '\n\n' + prompt : prompt);
    }
  } catch { finish(); }
});
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'archestra_connection', version: '1.0.0' } } });
`;
