import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { ConnectionSetupPlatform } from "@/types";
import { CLIENT_CONNECTION_INSTALLER } from "./client-connection-installer";

export async function buildDesktopInstallerBundle(params: {
  origin: string;
  rawToken: string;
  platform: ConnectionSetupPlatform;
}): Promise<Buffer> {
  const zip = new JSZip();
  const deploymentId = createHash("sha256")
    .update(params.origin)
    .digest("hex")
    .slice(0, 12);
  zip.file(
    "manifest.json",
    JSON.stringify({
      manifest_version: "0.3",
      name: `desktop-setup-${deploymentId}`,
      display_name: "Connect Claude Desktop",
      version: `0.0.${Date.now()}`,
      description: `Installing this helper runs the setup you reviewed at ${params.origin}. It reuses your Claude subscription token or opens sign-in, verifies inference, and restarts Desktop.`,
      author: { name: "Connection Setup" },
      server: {
        type: "node",
        entry_point: "server.cjs",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB substitutes the installation directory.
        mcp_config: { command: "node", args: ["${__dirname}/server.cjs"] },
      },
      tools: [
        {
          name: "setup_status",
          description: "Show the status of this one-time Desktop setup.",
        },
      ],
    }),
  );
  zip.file("setup.json", JSON.stringify(params));
  zip.file("connect.cjs", CLIENT_CONNECTION_INSTALLER);
  zip.file("server.cjs", DESKTOP_SETUP_SERVER);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// Installation is initiated by the user's native Install confirmation, not an agent tool.
// Only the expiring render ticket is bundled; provider credentials are never packaged.
const DESKTOP_SETUP_SERVER = String.raw`const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const setup = require('./setup.json');
let status = 'Starting the reviewed setup...';
const tools = [{name:'setup_status',description:'Show this one-time Desktop installation status. This tool does not run or retry installation.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}}];
readline.createInterface({input:process.stdin}).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'desktop-connection-setup',version:'1.0.0'}};
  else if (message.method === 'ping') result = {};
  else if (message.method === 'tools/list') result = {tools};
  else if (message.method === 'tools/call' && message.params?.name === 'setup_status') result = {content:[{type:'text',text:status}]};
  else { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unknown method'}}) + '\n'); return; }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result}) + '\n');
});
setTimeout(() => {
  const platform = {darwin:'macos',win32:'windows',linux:'linux'}[process.platform];
  if (!platform || ((platform === 'windows') !== (setup.platform === 'windows'))) { status = 'This installer is for another operating system. Choose your OS on Connect and download again.'; return; }
  const id = crypto.createHash('sha256').update(setup.rawToken).digest('hex');
  // Desktop starts multiple MCP processes. Atomic creation permits only one terminal.
  const lock = path.join(os.tmpdir(), 'desktop-setup-' + id);
  try { fs.mkdirSync(lock, {mode:0o700}); }
  catch (error) { status = error.code === 'EEXIST' ? 'Setup was already started. Check its Terminal window, or generate a new installer on Connect.' : 'Could not prepare setup. Run the terminal command from Connect.'; return; }
  execFile('node', [path.join(__dirname,'connect.cjs'),'--url',setup.origin,'--client','claude-desktop','--setup-token',setup.rawToken], {timeout:15000}, (error) => {
    status = error ? 'Could not open setup. Install Node.js 18+, then generate a new installer or use the terminal command on Connect.' : 'Setup opened in Terminal. Finish any sign-in there. Desktop restarts after inference is verified. You can uninstall this setup helper afterward.';
    fs.writeFileSync(path.join(lock,'status.txt'),status,{mode:0o600});
  });
}, 1000);
`;
