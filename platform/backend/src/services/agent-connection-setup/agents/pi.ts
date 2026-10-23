import { PI_GUARD_CLIENT } from "../guard/clients/pi";
import {
  buildStartupGuardContext,
  renderStartupGuardScript,
} from "../guard/startup-guard";
import { renderStartupGuardPowerShell } from "../guard/startup-guard.windows";
import { MARKETPLACE_SKILLS_SYNC } from "../payloads/marketplace-skills-sync";
import { PI_EXTENSION } from "../payloads/pi-extension";
import { PI_COMMAND_RESOLVER, PI_LAUNCHER } from "../payloads/pi-launcher";
import {
  PI_INSTALLATION,
  PI_LIFECYCLE,
  PI_WINDOWS_PATH,
} from "../payloads/pi-lifecycle";
import { nodeScriptRenderers } from "../steps/node-script";
import type { SetupScriptContext, ShellAgentSetup } from "../types";

export const piSetup: ShellAgentSetup = {
  label: "Pi",
  binary: "pi",
  ...nodeScriptRenderers(renderPiSetup),
  ending: (ctx) => ({
    proxyDetail:
      "Connected providers use the model router with native tool and result checks",
    signIn: ctx.mcp
      ? {
          command: ["arcpi", "--reconnect"],
          howTo:
            "Run arcpi --reconnect to keep your current gateway login or sign in again in your browser.",
        }
      : null,
    launch: ["arcpi"],
    notes: [
      "If you use your own OpenAI key, set OPENAI_API_KEY before launching Pi. The personal platform key attributes requests to your account.",
      "Open a new terminal and run arcpi. Use /model to switch among connected providers and models. The launcher always loads the guardrails extension.",
      "Start a new session after setup. Resume and forks retain the policy binding; histories created before setup are refused.",
      "Compaction and tree summaries check tool results through the connected proxy before summarizing.",
      "Requires Node.js 22.19 or newer and @earendil-works/pi-coding-agent 1.4 or later. Install it with pnpm add -g @earendil-works/pi-coding-agent.",
      "Use direct tools. Nested and codemode calls are blocked because they do not appear in provider history.",
      "Providers outside the connection catalog are blocked while the extension is loaded.",
      "Run arcpi --disconnect to restore the saved pre-connection configuration. If you edited managed files, resolve those edits first. Run arcpi --reconnect to sign in again.",
      "Shared skills refresh from the authorized marketplace when arcpi starts. Local skills are preserved. Third-party plugins are not installed.",
    ],
  }),
};

function renderPiSetup(ctx: SetupScriptContext): string {
  if (
    !ctx.proxy ||
    !ctx.mcp ||
    (!ctx.proxy.primaryProviders && ctx.proxy.provider !== "openai")
  ) {
    throw new Error(
      "Pi native guardrails require a routed model catalog or OpenAI proxy, and an MCP gateway. Include both when connecting.",
    );
  }
  if (!ctx.proxy.virtualKey && !ctx.proxy.passthroughVirtualKey)
    throw new Error(
      "Pi requires a personal platform key for native guardrails.",
    );
  const connection = {
    appName: ctx.appName,
    skills: ctx.skills,
    url: ctx.proxy.url,
    apiKey: ctx.proxy.virtualKey,
    attributionKey: ctx.proxy.passthroughVirtualKey,
    model: requireModel(ctx),
    provider: ctx.proxy.provider,
    modelRouter: Boolean(ctx.proxy.primaryProviders),
    providers: ctx.proxy.primaryProviders ?? [
      {
        provider: ctx.proxy.provider,
        name: ctx.proxy.providerLabel,
        models: [
          {
            id: requireModel(ctx),
            name: requireModel(ctx),
            context: null,
            output: null,
          },
        ],
      },
    ],
  };
  const guardContext = buildStartupGuardContext(ctx);
  // Native health probes report all three resources, including router catalogs.
  guardContext.healthUrl = `${new URL(ctx.mcp.url).origin}/v1/health`;
  if (guardContext.proxy) guardContext.proxy.ref ||= "connected";
  const guardBash =
    "# Managed Pi launcher startup check\n" +
    renderStartupGuardScript(guardContext, PI_GUARD_CLIENT);
  const guardWindows = powerShellFile(
    "# Managed Pi launcher startup check\n" +
      renderStartupGuardPowerShell(guardContext, PI_GUARD_CLIENT),
  );
  return String.raw`const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFileSync } = require("node:child_process");
${PI_COMMAND_RESOLVER}
${MARKETPLACE_SKILLS_SYNC}
${PI_INSTALLATION}
const version = execFileSync(piCommand[0], [...piCommand.slice(1), "--version"], { encoding: "utf8", shell: false }).trim();
const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)/.exec(version);
if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 4)) throw new Error("Install @earendil-works/pi-coding-agent 1.4 or later, then rerun setup.");
if (process.env.PI_CODING_AGENT_DIR) throw new Error("This setup uses ~/.pi/agent. Unset PI_CODING_AGENT_DIR before connecting.");
const root = path.join(os.homedir(), ".pi/agent");
const privateRoot = path.join(os.homedir(), ".archestra/pi");
const extension = path.join(root, "extensions/archestra-pi.js");
const gatewayFile = path.join(root, "mcp.json");
const modelsFile = path.join(root, "models.json");
const connection = ${JSON.stringify(connection)};
const server = ${JSON.stringify(ctx.mcp.serverName)};
const gateway = ${JSON.stringify({ url: ctx.mcp.url, exposure: "direct" })};
const source = ${JSON.stringify(PI_EXTENSION)};
const launcher = ${JSON.stringify(PI_LAUNCHER)};
const installation = new PiInstallation();
const safe = file => installation.safe(file);
const write = (file, bytes) => installation.write(file, bytes);
for (const file of [extension, gatewayFile, path.join(privateRoot, "connection.json")]) { safe(file); safe(file + ".archestra-backup"); }
safe(modelsFile);
if (fs.existsSync(modelsFile) && Object.keys(JSON.parse(fs.readFileSync(modelsFile, "utf8"))?.providers || {}).some(name => name === "archestra" || name.startsWith("archestra-"))) throw new Error("An existing models.json provider uses a reserved archestra name. Rename it before connecting so a missing extension cannot select it.");
if (!/^[A-Za-z0-9_.-]{1,64}$/.test(server) || ["__proto__", "constructor", "prototype"].includes(server)) throw new Error("Invalid MCP server name.");
if (fs.existsSync(extension) && !fs.readFileSync(extension, "utf8").startsWith("// Managed Pi connection.")) throw new Error("The Pi extension path already contains an unmanaged file.");
const mcp = fs.existsSync(gatewayFile) ? JSON.parse(fs.readFileSync(gatewayFile, "utf8")) : {};
if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) throw new Error("Pi mcp.json must contain an object.");
mcp.mcpServers ??= {};
if (!mcp.mcpServers || typeof mcp.mcpServers !== "object" || Array.isArray(mcp.mcpServers)) throw new Error("Pi mcpServers must contain an object.");
if (Object.hasOwn(mcp.mcpServers, server) && mcp.mcpServers[server]?.url !== gateway.url) throw new Error("A different MCP server already uses this name. Rename it before connecting.");
mcp.mcpServers[server] = gateway;
const lifecycleFiles = [["lifecycle.cjs", ${JSON.stringify(PI_LIFECYCLE)}], ["startup.sh", ${JSON.stringify(guardBash)}], ["startup.ps1", ${JSON.stringify(guardWindows)}]];
for (const [name] of lifecycleFiles) {
  const file = path.join(privateRoot, name); safe(file);
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes("Managed Pi launcher")) throw new Error("A Pi lifecycle path contains an unmanaged file. Preserve it before reconnecting.");
}
installation.lock();
try {
installation.begin({ server, gateway: gateway.url, providers: connection.providers.map(entry => "archestra-" + entry.provider) });
connection.lifecycleVersion = 1;
connection.lifecycleSha256 = require("node:crypto").createHash("sha256").update(${JSON.stringify(PI_LIFECYCLE)}).digest("hex");
connection.guardSha256 = require("node:crypto").createHash("sha256").update(process.platform === "win32" ? ${JSON.stringify(guardWindows)} : ${JSON.stringify(guardBash)}).digest("hex");
connection.piCommand = piCommand;
connection.extensionSha256 = require("node:crypto").createHash("sha256").update(source).digest("hex");
const bin = path.join(os.homedir(), ".local/bin");
const sh = value => "'" + value.replace(/'/g, "'\\''") + "'";
const launcherFile = path.join(privateRoot, "launch.cjs");
const launcherPath = path.join(bin, process.platform === "win32" ? "arcpi.cmd" : "arcpi");
const pathScript = path.join(privateRoot, "path.ps1");
for (const file of [launcherFile, launcherPath, ...(process.platform === "win32" ? [pathScript] : [])]) {
  safe(file);
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes("Managed Pi launcher")) throw new Error("An unmanaged arcpi launcher already exists. Rename it before connecting.");
}
write(launcherFile, launcher);
if (process.platform === "win32") {
  write(launcherPath, '@rem Managed Pi launcher\r\n@"' + process.execPath.replace(/%/g, "%%") + '" "%USERPROFILE%\\.archestra\\pi\\launch.cjs" %*\r\n');
  const ps = ${JSON.stringify(powerShellFile(PI_WINDOWS_PATH))};
  // The script and path travel in a file, not a quoted -Command argument.
  write(pathScript, ps);
  installation.windowsPath(pathScript);
} else {
  write(launcherPath, "#!/bin/sh\n# Managed Pi launcher\nexec " + sh(process.execPath) + " " + sh(launcherFile) + ' "$@"\n');
  fs.chmodSync(launcherPath, 0o700);
  for (const name of [".profile", ".bashrc", ".zshrc"]) installation.profile(path.join(os.homedir(), name));
}
for (const [name, bytes] of lifecycleFiles) write(path.join(privateRoot, name), bytes);
syncMarketplaceSkills({ source: connection.skills, install: true });
write(path.join(privateRoot, "connection.json"), JSON.stringify(connection, null, 2) + "\n");
write(extension, source);
installation.gateway(gateway);
console.log("Pi connection installed. Sign in to the gateway, then start Pi with the connected provider.");
} finally { installation.unlock(); }
`;
}

function requireModel(ctx: SetupScriptContext): string {
  if (!ctx.proxy?.model)
    throw new Error(
      "Choose a model served by your connected provider before connecting Pi.",
    );
  return ctx.proxy.model;
}

function powerShellFile(source: string): string {
  // Windows PowerShell 5.1 decodes BOM-less files as ANSI before executing them.
  // Include the BOM in both the written bytes and the launcher's integrity hash.
  return `\uFEFF${source.replace(/^\uFEFF+/, "")}`;
}
