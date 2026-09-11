/** Executed by Claude Desktop's bundled extension runtime, never on the server. */
export const DESKTOP_CONNECTION_INSTALLER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const {execFile,spawn} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);

class DesktopInstaller {
  constructor(ticket) {
    this.ticket = ticket;
    this.secret = crypto.randomBytes(32).toString('hex');
    this.state = {phase:'preparing',message:'Preparing your connection…'};
    this.server = http.createServer((req,res) => this.request(req,res));
  }
  async start() {
    await new Promise(resolve => this.server.listen(0,'127.0.0.1',resolve));
    this.origin = 'http://localhost:' + this.server.address().port;
    this.page = this.origin + '/' + this.secret;
    this.timeout = setTimeout(() => this.close(), 15 * 60 * 1000);
    await this.open(this.page);
    try {
      const origin = new URL(this.ticket.origin);
      if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) throw new Error('The connection must use HTTPS.');
      const response = await fetch(origin.origin + '/api/connection-setups/script/' + encodeURIComponent(this.ticket.rawToken), {
        headers:{Accept:'application/vnd.archestra.desktop-setup+json'},redirect:'error',signal:AbortSignal.timeout(60000)
      });
      if (!response.ok) throw new Error(response.status === 410 ? 'This installer has expired or was already used. Download a new installer from Connect.' : 'Could not retrieve your setup (HTTP ' + response.status + '). Return to Connect and try again.');
      this.setup = await response.json();
      if (this.setup.clientId !== 'claude-desktop') throw new Error('This setup is not for Claude Desktop.');
      await this.prepare();
    } catch (error) { this.fail(error); }
  }
  async prepare() {
    const base = process.platform === 'darwin' ? path.join(os.homedir(),'Library','Application Support') : process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config');
    if (!base) throw new Error('Could not locate your Desktop settings.');
    this.directory = path.join(base,'Claude-3p');
    this.library = path.join(this.directory,'configLibrary');
    this.profileId = uuid('archestra-desktop:managed');
    this.profilePath = path.join(this.library,this.profileId + '.json');
    this.metaPath = path.join(this.library,'_meta.json');
    this.appPath = path.join(this.directory,'claude_desktop_config.json');
    this.metadata = read(this.metaPath,{entries:[]});
    if (!Array.isArray(this.metadata.entries)) throw new Error('Desktop has an unexpected profile format. No settings were changed.');
    this.managed = new Map();
    for (const entry of this.metadata.entries) {
      if (!/^[0-9a-f-]{36}$/i.test(entry.id || '')) continue;
      const profile = read(path.join(this.library,entry.id + '.json'),{});
      const urls = [profile.inferenceGatewayBaseUrl,...(profile.managedMcpServers || []).map(s => s.url),...(profile.allowedPluginMarketplaces || []).map(s => s.url)];
      if (entry.id === this.profileId || urls.some(url => typeof url === 'string' && entry.id === uuid('archestra-desktop:' + url))) this.managed.set(entry.id,profile);
    }
    const previous = this.managed.get(this.metadata.appliedId) || this.managed.get(this.profileId) || {};
    this.profile = {};
    const proxy = this.setup.proxy;
    if (proxy) {
      this.headers = {'X-Archestra-Agent-Id':'anthropic_claude_desktop'};
      if (proxy.passthroughVirtualKey) this.headers['X-Archestra-Virtual-Key'] = proxy.passthroughVirtualKey;
      if (proxy.authMode === 'provider-key') {
        this.headers['anthropic-beta'] = 'oauth-2025-04-20';
        const token = previous.inferenceGatewayApiKey;
        if (typeof token === 'string' && token.startsWith('sk-ant-oat') && await this.probe(token)) this.credential = token;
        else { this.state = {phase:'signin',message:'Sign in with your Claude subscription to connect Desktop.'}; return; }
      } else {
        if (!proxy.virtualKey || !await this.probe(proxy.virtualKey)) throw new Error('The gateway rejected this API key. Return to Connect to choose another key.');
        this.credential = proxy.virtualKey;
      }
    }
    this.ready();
  }
  ready() {
    const {proxy,mcp,skills} = this.setup;
    if (proxy) Object.assign(this.profile,{
      inferenceProvider:'gateway',inferenceCredentialKind:'static',
      inferenceGatewayBaseUrl:proxy.url,inferenceGatewayApiKey:this.credential,
      inferenceGatewayAuthScheme:'bearer',inferenceCustomHeaders:this.headers,modelDiscoveryEnabled:true
    });
    if (mcp) this.profile.managedMcpServers = [{name:mcp.serverName,transport:'http',url:mcp.url,oauth:{mode:'dcr'}}];
    if (skills) this.profile.allowedPluginMarketplaces = [{source:'git',url:skills.cloneUrl,expectedName:skills.marketplaceName}];
    this.state = {phase:'ready',message:'Your connection is ready. Finish any active Desktop tasks, then restart to apply it.',subscription:proxy?.authMode === 'provider-key'};
  }
  async probe(token) {
    this.state = {phase:'checking',message:'Checking your connection…'};
    const response = await fetch(this.setup.proxy.url.replace(/\/$/,'') + '/v1/messages',{
      method:'POST',headers:{...this.headers,Authorization:'Bearer ' + token,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      body:JSON.stringify({model:this.setup.proxy.model || 'claude-haiku-4-5-20251001',max_tokens:8,messages:[{role:'user',content:'Reply with exactly OK.'}]}),
      redirect:'error',signal:AbortSignal.timeout(60000)
    });
    if (response.status === 401) return false;
    if (!response.ok) throw new Error('The gateway connection check failed (HTTP ' + response.status + '). Check model access and quota. Desktop settings have not changed.');
    const data = await response.json();
    if (data.type !== 'message' || !data.content?.length) throw new Error('The gateway did not return a completion. Desktop settings have not changed.');
    return true;
  }
  async signIn() {
    this.verifier = crypto.randomBytes(32).toString('base64url');
    this.oauthState = crypto.randomBytes(32).toString('base64url');
    const url = new URL('https://claude.ai/oauth/authorize');
    url.search = new URLSearchParams({code:'true',client_id:OAUTH_CLIENT_ID,response_type:'code',redirect_uri:this.origin + '/callback',scope:'user:inference',code_challenge:crypto.createHash('sha256').update(this.verifier).digest('base64url'),code_challenge_method:'S256',state:this.oauthState}).toString();
    this.state = {phase:'authorizing',message:'Complete Claude sign-in in the other browser tab. Claude’s consent screen names this subscription connection “Claude Code”; you do not need to install the CLI. Keep this page open.'};
    await this.open(url.toString());
  }
  async callback(url,res) {
    if (!this.oauthState || url.searchParams.get('state') !== this.oauthState || this.state.phase !== 'authorizing') {res.writeHead(400);res.end('Invalid sign-in callback.');return;}
    const state = this.oauthState;
    this.oauthState = null;
    res.writeHead(303,{Location:this.page});res.end();
    try {
      if (url.searchParams.has('error') || !url.searchParams.get('code')) throw new Error('Claude sign-in was cancelled. Download a new installer to try again.');
      const response = await fetch('https://platform.claude.com/v1/oauth/token',{
        method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(60000),
        body:JSON.stringify({grant_type:'authorization_code',client_id:OAUTH_CLIENT_ID,code:url.searchParams.get('code'),state,redirect_uri:this.origin + '/callback',code_verifier:this.verifier,expires_in:31536000})
      });
      this.verifier = null;
      if (!response.ok) throw new Error('Claude sign-in could not finish (HTTP ' + response.status + '). Download a new installer to try again.');
      const data = await response.json();
      if (typeof data.access_token !== 'string' || !data.access_token.startsWith('sk-ant-oat')) throw new Error('Claude did not return a subscription credential.');
      if (!await this.probe(data.access_token)) throw new Error('The gateway rejected the subscription credential. Desktop settings have not changed.');
      this.credential = data.access_token;
      this.ready();
    } catch(error) {this.fail(error);}
  }
  async apply() {
    this.state = {phase:'applying',message:'Restarting Claude Desktop…'};
    try {
      // Read preferences immediately before applying, preserving unrelated settings.
      const app = read(this.appPath,{});
      const oldPaths = [...this.managed.keys()].filter(id => id !== this.profileId).map(id => path.join(this.library,id + '.json'));
      for (const file of [this.profilePath,this.metaPath,this.appPath,...oldPaths]) {
        if (fs.existsSync(file) && !fs.existsSync(file + '.before-archestra')) await write(file + '.before-archestra',read(file,{}));
      }
      const metadata = read(this.metaPath,{entries:[]});
      metadata.entries = metadata.entries.filter(entry => entry.id !== this.profileId && !this.managed.has(entry.id));
      metadata.entries.push({id:this.profileId,name:this.setup.appName + ' Desktop'});
      metadata.appliedId = this.profileId;
      app.deploymentMode = this.setup.proxy ? '3p' : '1p';
      await write(this.profilePath,this.profile);
      await write(this.metaPath,metadata);
      await write(this.appPath,app);
      for (const file of oldPaths) fs.unlinkSync(file);
      await this.restartDesktop();
      this.state = {phase:'restarting',message:'Desktop is restarting. A confirmation will open when it finishes.'};
      this.credential = null;
      this.profile = null;
    } catch(error) {this.fail(error);}
  }
  async restartDesktop() {
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(),'desktop-connection-result-'));
    fs.chmodSync(resultDir,0o700);
    const success = path.join(resultDir,'connected.html');
    const failure = path.join(resultDir,'restart-needed.html');
    fs.writeFileSync(success,completionPage(this.setup,true),{mode:0o600});
    fs.writeFileSync(failure,completionPage(this.setup,false),{mode:0o600});
    let child;
    if (process.platform === 'darwin') {
      child = spawn('/bin/sh',['-c',RESTART_MAC,'desktop-restart',success,failure],{detached:true,stdio:'ignore'});
    } else if (process.platform === 'win32') {
      const script = path.join(resultDir,'restart.ps1');
      fs.writeFileSync(script,RESTART_WINDOWS,{mode:0o600});
      child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-SuccessPage',success,'-FailurePage',failure],{detached:true,stdio:'ignore',windowsHide:true});
    } else {
      child = spawn('/bin/sh',['-c',RESTART_LINUX,'desktop-restart',success,failure],{detached:true,stdio:'ignore'});
    }
    await new Promise((resolve,reject) => {child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
  }
  async open(url) {
    if (process.platform === 'darwin') await run('/usr/bin/open',[url]);
    else if (process.platform === 'win32') await run('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true});
    else await run('xdg-open',[url]);
  }
  request(req,res) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    if (req.headers.host !== new URL(this.origin).host) {res.writeHead(403);res.end();return;}
    const url = new URL(req.url,this.origin);
    if (req.method === 'GET' && url.pathname === '/callback') {void this.callback(url,res);return;}
    const base = '/' + this.secret;
    if (req.method === 'GET' && url.pathname === base) {
      const nonce = crypto.randomBytes(16).toString('base64');
      res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-" + nonce + "'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(page(nonce));return;
    }
    if (req.method === 'GET' && url.pathname === base + '/status') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(this.state));return;}
    if (req.method === 'POST' && req.headers.origin === this.origin && url.pathname === base + '/signin' && this.state.phase === 'ready' && this.state.subscription) {
      res.writeHead(204);res.end();void this.signIn().catch(error => this.fail(error));return;
    }
    if (req.method === 'POST' && req.headers.origin === this.origin && url.pathname === base + '/continue') {
      const phase = this.state.phase;
      if (!['signin','ready'].includes(phase)) {res.writeHead(409);res.end();return;}
      void (phase === 'signin' ? this.signIn() : this.apply()).catch(error => this.fail(error)).finally(() => {res.writeHead(204);res.end();});return;
    }
    res.writeHead(404);res.end();
  }
  fail(error) {
    // Network/native errors can embed command arguments or credentials. Only
    // deliberate installer messages may be displayed in the local browser.
    const message = error instanceof Error && error.constructor === Error && !error.code ? error.message : 'Setup could not finish. Desktop may need to be closed. Download a new installer from Connect to retry.';
    this.state = {phase:'error',message};
  }
  close() {clearTimeout(this.timeout);this.server.closeAllConnections();this.server.close();}
}

function read(file,fallback) {return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')) : fallback;}
async function write(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Desktop settings contain a symbolic link. No settings were replaced.');
  const temporary = path.join(path.dirname(file),'.setup-' + crypto.randomBytes(16).toString('hex'));
  const fd = fs.openSync(temporary,'wx',0o600);
  try {
    if (process.platform === 'win32') {
      const {stdout} = await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{windowsHide:true});
      await run('icacls.exe',[temporary,'/inheritance:r','/grant:r','*' + stdout.trim() + ':F'],{windowsHide:true});
    }
    fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);
  } finally {fs.closeSync(fd);}
  try {fs.renameSync(temporary,file);} finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
}
function uuid(value) {
  const hash = crypto.createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex')).update(value).digest();
  hash[6] = (hash[6] & 15) | 80;hash[8] = (hash[8] & 63) | 128;
  const hex = hash.subarray(0,16).toString('hex');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
function page(nonce) {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Claude Desktop</title><style>body{margin:0;background:#faf9f6;color:#292824;font:16px/1.6 system-ui,sans-serif}main{max-width:520px;margin:12vh auto;padding:32px}h1{font-size:28px;line-height:1.2;font-weight:600}p{color:#605e56}button{font:inherit;background:#292824;color:white;padding:12px 20px;border:0;border-radius:8px;cursor:pointer}button:focus-visible{outline:3px solid #8b5cf6;outline-offset:3px}button:disabled{opacity:.6}#signin{display:block;background:transparent;color:#605e56;padding:12px 0;text-decoration:underline}#signin[hidden]{display:none}small{display:block;margin-top:32px;color:#737168}li{margin-bottom:12px}</style><main><h1>Connect Claude Desktop</h1><p id="status" role="status">Preparing your connection…</p><button id="continue" hidden>Continue</button><button id="signin" hidden>Use another Claude account</button><ul id="next" hidden></ul><small>Your Claude sign-in stays on this computer. You can close this page after setup finishes.</small></main><script nonce="' + nonce + '">const signin=document.getElementById("signin"),button=document.getElementById("continue"),status=document.getElementById("status"),next=document.getElementById("next");async function refresh(){try{const r=await fetch(location.pathname+"/status"),s=await r.json();status.textContent=s.message;button.hidden=!["signin","ready"].includes(s.phase);button.textContent=s.phase==="signin"?"Sign in with Claude":"Restart and connect";button.disabled=false;signin.hidden=!(s.phase==="ready"&&s.subscription);if(s.phase==="done"){next.replaceChildren();for(const text of [s.mcp&&"In Desktop Settings → Connectors, connect your gateway and approve access in the browser.",s.skills&&"In Desktop Settings → Plugins, install your shared marketplace.","You can remove the setup helper from Desktop Extensions."]){if(text){const li=document.createElement("li");li.textContent=text;next.append(li);}}next.hidden=false;return;}if(!["error","restarting"].includes(s.phase))setTimeout(refresh,1000);}catch{status.textContent="Setup has closed. If Desktop is not connected, download a new installer from Connect.";button.hidden=true;}}signin.onclick=async()=>{signin.hidden=true;await fetch(location.pathname+"/signin",{method:"POST"});};button.onclick=async()=>{button.disabled=true;await fetch(location.pathname+"/continue",{method:"POST"});await refresh();};refresh();</script></html>';
}
// The public subscription client used by the official setup-token flow. PKCE
// binds the code to this local process; only inference scope is requested.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
function completionPage(setup,success) {
  const title = success ? 'Claude Desktop restarted' : 'Restart Claude Desktop to finish';
  const instructions = success ? 'Your connection settings are saved. Send a message in Desktop and check LLM Proxy Logs to verify it.' : 'Your connection settings are saved, but Desktop could not restart automatically. Finish active tasks, quit Desktop from its app menu, and open it again.';
  const steps = [setup.mcp && 'In Desktop Settings → Connectors, connect your gateway and approve access in the browser.',setup.skills && 'In Desktop Settings → Plugins, install your shared marketplace.','You can remove the setup helper from Desktop Extensions.'].filter(Boolean);
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>body{margin:0;background:#faf9f6;color:#292824;font:16px/1.6 system-ui,sans-serif}main{max-width:520px;margin:12vh auto;padding:32px}h1{font-size:28px;line-height:1.2;font-weight:600}p,li{color:#605e56}li{margin-bottom:12px}</style><main><h1>' + title + '</h1><p>' + instructions + '</p><ul>' + steps.map(text => '<li>' + text + '</li>').join('') + '</ul></main></html>';
}
const RESTART_MAC = [
  'sleep 1',
  '/usr/bin/osascript -e \'tell application "Claude" to quit\' >/dev/null 2>&1 || true',
  'remaining=120',
  'while /usr/bin/pgrep -f \'/[C]laude.app/Contents/MacOS/Claude\' >/dev/null; do',
  '  remaining=$((remaining - 1))',
  '  if [ "$remaining" -le 0 ]; then /usr/bin/open "$2"; exit 1; fi',
  '  sleep 1',
  'done',
  'sleep 1',
  'if /usr/bin/open -n -a Claude; then',
  '  sleep 2',
  '  if /usr/bin/pgrep -f \'/[C]laude.app/Contents/MacOS/Claude\' >/dev/null; then /usr/bin/open "$1"; else /usr/bin/open "$2"; fi',
  'else /usr/bin/open "$2"; fi'
].join('\n');
const RESTART_WINDOWS = [
  'param([string]$SuccessPage,[string]$FailurePage)',
  '$ErrorActionPreference = "Stop"',
  'Start-Sleep -Seconds 1',
  'try {',
  '  $processes = Get-Process Claude -ErrorAction SilentlyContinue',
  '  $processes | ForEach-Object { [void]$_.CloseMainWindow() }',
  '  $processes | Wait-Process -Timeout 120 -ErrorAction Stop',
  '  $p = Get-AppxPackage | Where-Object { $_.Name -in @( "Claude", "AnthropicPBC.Claude" ) } | Select-Object -First 1',
  '  if ($p) {',
  '    $m = Get-AppxPackageManifest -Package $p.PackageFullName',
  '    $a = $m.Package.Applications.Application | Where-Object { $_.Executable -match "Claude[.]exe$" } | Select-Object -First 1',
  '    if (-not $a) { throw "Desktop application not found" }',
  '    Start-Process ("shell:AppsFolder\\" + $p.PackageFamilyName + "!" + $a.Id)',
  '  } else { Start-Process (Join-Path $env:LOCALAPPDATA "AnthropicClaude/Claude.exe") }',
  '  Start-Process $SuccessPage',
  '} catch { Start-Process $FailurePage; exit 1 }'
].join('\n');
const RESTART_LINUX = [
  'sleep 1',
  'pkill -TERM -u "$(id -u)" -x claude-desktop || true',
  'remaining=120',
  'while pgrep -u "$(id -u)" -x claude-desktop >/dev/null; do',
  '  remaining=$((remaining - 1))',
  '  if [ "$remaining" -le 0 ]; then xdg-open "$2"; exit 1; fi',
  '  sleep 1',
  'done',
  'claude-desktop >/dev/null 2>&1 &',
  'xdg-open "$1"'
].join('\n');
module.exports = DesktopInstaller;
if (require.main === module) new DesktopInstaller(require('./setup.json')).start().catch(() => process.exitCode = 1);
`;
