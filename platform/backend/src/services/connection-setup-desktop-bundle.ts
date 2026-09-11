import { createHash } from "node:crypto";
import JSZip from "jszip";
import sharp from "sharp";
import type { ConnectionSetupPlatform } from "@/types";
import { DESKTOP_CONNECTION_INSTALLER } from "./connection-desktop-installer";

export async function buildDesktopInstallerBundle(params: {
  origin: string;
  rawToken: string;
  platform: ConnectionSetupPlatform;
  appName: string;
  iconLogo: string | null;
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
      display_name: `Connect ${params.appName}`,
      icon: "icon.png",
      version: `0.0.${Date.now()}`,
      description: `Connect Claude Desktop to ${params.appName} (${params.origin}) using the setup you reviewed. The installer reuses your Claude subscription token or opens sign-in, verifies inference through ${params.appName}, and restarts Desktop.`,
      author: { name: params.appName },
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
  const logo = params.iconLogo
    ? Buffer.from(
        params.iconLogo.slice(params.iconLogo.indexOf(",") + 1),
        "base64",
      )
    : Buffer.from(DEFAULT_ICON_BASE64, "base64");
  zip.file(
    "icon.png",
    await sharp(logo, { limitInputPixels: 16_777_216 })
      .resize(128, 128, { fit: "contain", background: "#00000000" })
      .png()
      .toBuffer(),
  );
  zip.file(
    "setup.json",
    JSON.stringify({
      origin: params.origin,
      rawToken: params.rawToken,
      platform: params.platform,
    }),
  );
  zip.file("connect.cjs", DESKTOP_CONNECTION_INSTALLER);
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
const DesktopInstaller = require('./connect.cjs');
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
  // Desktop starts multiple MCP processes. Atomic creation permits only one setup browser.
  const lock = path.join(os.tmpdir(), 'desktop-setup-' + id);
  try { fs.mkdirSync(lock, {mode:0o700}); }
  catch (error) { status = error.code === 'EEXIST' ? 'Setup was already started. Check its browser tab, or generate a new installer on Connect.' : 'Could not prepare setup. Download a new installer from Connect.'; return; }
  // Electron utility processes cannot be relaunched as standalone Node. Keep
  // setup inside the runtime Desktop already provided to this extension.
  new DesktopInstaller(setup).start().catch(() => {
    status = 'Could not open setup. Download a new installer from Connect and try again.';
  });
  status = 'Setup opened in your browser. Complete sign-in and restart Desktop there.';
  fs.writeFileSync(path.join(lock,'status.txt'),status,{mode:0o600});
}, 1000);
`;

// Embedded from frontend/public/icons/archestra.png so packaged backends need no frontend filesystem.
const DEFAULT_ICON_BASE64 =
  "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";
