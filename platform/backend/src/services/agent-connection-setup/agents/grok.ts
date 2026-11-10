import {
  REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
} from "@archestra/shared/archestra-mcp-server";
import { PROVIDER_MODEL_TIERS } from "@archestra/shared/model-constants";
import { stringify } from "smol-toml";
import { grokToolName } from "@/routes/mcp-gateway/grok-tool-names";
import { GROK_GUARD_CLIENT } from "../guard/clients/grok";
import {
  buildStartupGuardContext,
  renderStartupGuardScript,
} from "../guard/startup-guard";
import { renderStartupGuardPowerShell } from "../guard/startup-guard.windows";
import { GROK_CONFIG } from "../payloads/grok-config";
import { GROK_CONFIG_TRANSACTION } from "../payloads/grok-config-transaction";
import { GROK_LOOPBACK_PROXY } from "../payloads/grok-loopback-proxy";
import { GROK_MCP_SIGN_IN } from "../payloads/grok-mcp-sign-in";
import { GROK_MODEL_DISCOVERY } from "../payloads/grok-model-discovery";
import { GROK_NATIVE_TRANSPORT } from "../payloads/grok-native-transport";
import { GROK_SHELL } from "../payloads/grok-shell";
import { GROK_SKILLS } from "../payloads/grok-skills";
import { GROK_STARTUP } from "../payloads/grok-startup";
import { starterPrompt } from "../steps/ending";
import { nodeScriptRenderers } from "../steps/node-script";
import type { SetupScriptContext, ShellAgentSetup } from "../types";

export const grokSetup: ShellAgentSetup = {
  label: "Grok",
  ...nodeScriptRenderers(renderGrokSetup),
  ending: (ctx) => ({
    proxyDetail:
      ctx.proxy?.authMode === "native-session"
        ? "Native Grok subscription models through the protected LLM proxy"
        : "Grok custom model with native LLM-proxy checks",
    signIn: ctx.mcp
      ? {
          command: [
            "node",
            "-e",
            "require(require('node:os').homedir() + '/.archestra/grok/sign-in.cjs')",
          ],
          howTo:
            "Run node ~/.archestra/grok/sign-in.cjs to freshly authorize in your browser and verify the gateway without starting Grok. Existing credentials are kept until the new grant is verified and saved.",
        }
      : null,
    ...(ctx.proxy?.authMode === "native-session"
      ? {
          providerSignIn: {
            label: "your native SuperGrok account",
            command: ["node", "~/.archestra/grok/login.cjs"],
            howTo:
              "Existing native login is reused. To renew it, run node ~/.archestra/grok/login.cjs (PowerShell: node $HOME/.archestra/grok/login.cjs), or /login inside Grok. Append --device-auth to sign in on another computer. Grok reads and refreshes the original auth file directly; credentials are never copied.",
          },
        }
      : {}),
    launch: [
      "node",
      "-e",
      "require(require('node:os').homedir() + '/.archestra/grok/launch.cjs')",
      "--",
      starterPrompt(ctx),
    ],
    notes: [
      "The authorization step opens browser consent, waits for OAuth, and verifies MCP tools before returning to this installer. Grok starts only at the separate optional start prompt. Native session headers retain policy attribution across turn summaries.",
      "This installer configures the Grok Build CLI. Grok Bot desktop uses a separate service protocol; its desktop model routing has not been configured or verified by this installer.",
      "Native subagents use protected child trajectories and checked returns. Direct parent-to-child and eligible sibling messages pass through the Guardrails peer-message boundary. Workflows, monitors and scheduled execution remain blocked. Unknown native tools are refused.",
      "Headless Grok cannot answer approval questions. Use an interactive session for approval; unanswered or unavailable reviews never approve a call.",
      "Guardrail helper tool calls are pre-approved in Grok. Required policy reviews still ask for your decision.",
      "Open a new terminal and run grok. The managed shell function checks the connection and syncs native skills before starting Grok. In the current terminal, use node ~/.archestra/grok/launch.cjs (PowerShell: node $HOME/.archestra/grok/launch.cjs). LLM proxy admission stays pending until the server replies; its first governed reply shows the server-issued protected session receipt. Headless launches check connectivity in the background. Plain output includes one status line; JSON and NDJSON retain native reply fields and add _meta.archestraStartup. Protocol service modes preserve their native streams.",
      "Only native SKILL.md packages are delivered. The dedicated profile suppresses ambient plugin and compatibility hooks using Grok's managed-hook restriction. Organization-enforced hooks are preserved. HOME, the working directory, and other clients' plugins remain unchanged.",
      `Native SuperGrok reuses your ordinary login, including refresh and /login. The native catalog retains model names, selection and reasoning options; ${ctx.appName} protection is shown separately by the server receipt. MCP authorization is separate. API-key passthrough and personal virtual keys remain explicit alternatives.`,
      "Native subscription selection uses authenticated native settings and catalog through the proxy; no API key or organization catalog is required. Use /model or -m to select a native model. API-key Automatic uses the official coding recommendation and account availability.",
      `Disconnect with node ${ctx.platform === "windows" ? '"$HOME/.archestra/grok/disconnect.cjs"' : "~/.archestra/grok/disconnect.cjs"}. Native TOML formatting changes are accepted. Conflicting managed values require explicit local confirmation and a private backup; interrupted updates recover on the next run.`,
    ],
  }),
};

function renderGrokSetup(ctx: SetupScriptContext): string {
  if (ctx.skills?.pluginNames?.length)
    throw new Error(
      "Grok connections deliver native skills only, not plugins.",
    );
  const nativeSession = ctx.proxy?.authMode === "native-session";
  const mcp = ctx.mcp;
  const guardrailToolAllowRules = mcp
    ? [...REQUIRED_OPENAPPA_TOOL_SHORT_NAMES, TOOL_ASK_USER_SHORT_NAME].map(
        (name) =>
          `${mcp.serverName}__${grokToolName(`${mcp.toolPrefix}${name}`)}`,
      )
    : [];
  const automatic =
    ctx.proxy?.provider === "xai" && !ctx.proxy.model && !nativeSession;
  const tables: Record<string, unknown> = {};
  if (ctx.mcp) {
    tables.mcp_servers = {
      [ctx.mcp.serverName]: {
        url: ctx.mcp.url,
        headers: {
          "x-appa-session-id": "{{session_id}}",
          "X-Archestra-Agent-Id": "grok-build",
        },
      },
    };
  }
  if (ctx.proxy && !nativeSession) {
    const proxy = ctx.proxy;
    const headers: Record<string, string> = {
      "X-Archestra-Agent-Id": "grok-build",
    };
    if (proxy.passthroughVirtualKey)
      headers["X-Archestra-Virtual-Key"] = proxy.passthroughVirtualKey;
    tables.model = {
      archestra: {
        name: ctx.appName,
        model:
          proxy.model ??
          proxy.primaryProviders?.flatMap((provider) => provider.models)[0]
            ?.id ??
          PROVIDER_MODEL_TIERS[proxy.provider].normal,
        base_url: proxy.url,
        api_backend:
          proxy.provider === "anthropic" ? "messages" : "chat_completions",
        ...(proxy.virtualKey
          ? { api_key: proxy.virtualKey }
          : {
              env_key:
                proxy.provider === "anthropic"
                  ? "ANTHROPIC_API_KEY"
                  : proxy.provider === "xai"
                    ? "XAI_API_KEY"
                    : "OPENAI_API_KEY",
            }),
        extra_headers: headers,
        supports_backend_search: false,
      },
    };
  }
  const modelTemplate = automatic
    ? stringify({ model: tables.model }).replace(/^model = .*\n/m, "")
    : null;
  if (automatic) delete tables.model;
  const block = `\n# BEGIN ARCHESTRA GROK CONNECTION\n${stringify(tables)}# END ARCHESTRA GROK CONNECTION\n`;
  const ownedTables = [
    ...(ctx.proxy && !nativeSession ? ["model.archestra"] : []),
    ...(ctx.mcp ? [`mcp_servers.${ctx.mcp.serverName}`] : []),
  ];
  const guardContext = buildStartupGuardContext(ctx);
  const guardBash = renderStartupGuardScript(guardContext, GROK_GUARD_CLIENT);
  const guardWindows =
    "\uFEFF" +
    renderStartupGuardPowerShell(guardContext, GROK_GUARD_CLIENT).replace(
      /\r?\n/g,
      "\r\n",
    );
  return `const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const home = path.resolve(process.env.GROK_HOME || path.join(os.homedir(), ".grok"));
const config = path.join(home, "config.toml");
const privateRoot = path.join(os.homedir(), ".archestra/grok");
const snapshot = path.join(privateRoot, "connection.json");
${GROK_ATOMIC_WRITE}
${GROK_MANAGED_CONFIG}
${GROK_CONFIG_TRANSACTION}
${GROK_SHELL}
for (const target of [home, config, path.dirname(privateRoot), privateRoot, snapshot, path.join(privateRoot, "disconnect.cjs")]) {
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Grok setup will not replace symbolic links: " + target);
}
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
grokPrivateDirectory(privateRoot);
const releaseLock = acquireGrokLock(privateRoot);
recoverGrokTransaction(privateRoot, home);
let block = ${JSON.stringify(block)};
const nativeSession = ${nativeSession ? JSON.stringify({ url: ctx.proxy?.url, headers: { ...(ctx.proxy?.passthroughVirtualKey ? { "x-archestra-virtual-key": ctx.proxy.passthroughVirtualKey } : {}) }, model: ctx.proxy?.model ?? null }) : "null"};
if (nativeSession) nativeSession.authPath = path.resolve(process.env.GROK_AUTH_PATH || path.join(home, "auth.json"));
const automatic = ${automatic ? JSON.stringify({ template: modelTemplate, modelsUrl: `${ctx.proxy?.url.replace(/\/$/, "")}/models`, apiKey: ctx.proxy?.virtualKey, headers: { "X-Archestra-Agent-Id": "grok-build", ...(ctx.proxy?.passthroughVirtualKey ? { "X-Archestra-Virtual-Key": ctx.proxy.passthroughVirtualKey } : {}) } }) : "null"};
${GROK_AUTOMATIC_MODEL}
let modelResolved = false;
if (automatic && (automatic.apiKey || process.env.XAI_API_KEY)) {
  const selection = resolveAutomaticModel(automatic);
  block = withAutomaticModel(block, automatic, selection.model);
  modelResolved = true;
  console.log("Automatic xAI model verified: " + selection.model);
} else if (automatic) console.log("Automatic xAI model will be verified locally when XAI_API_KEY is available. MCP authorization and skills setup can finish now.");
const current = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "";
let original = current;
let previousState;
if (fs.existsSync(snapshot)) {
  const previous = readGrokSnapshot(snapshot);
  previousState = previous;
  validateGrokState(previous, home);
  original = previous.activeConfig ? current : withoutManagedConfig(current, previous);
} else if (current.includes("# BEGIN ARCHESTRA GROK CONNECTION")) throw new Error("Grok connection has no restoration snapshot. Preserve the config and reconcile it manually.");
assertGrokAvailable(original, { block, ownedTables: ${JSON.stringify(ownedTables)} }, previousState);
${GROK_SKILLS}
syncGrokSkills({ source: ${JSON.stringify(ctx.skills)}, home, privateRoot, install: true });
const beforeCommit = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : null;
original = beforeCommit || "";
if (fs.existsSync(snapshot)) {
  const previous = readGrokSnapshot(snapshot);
  original = previous.activeConfig ? original : withoutManagedConfig(original, previous);
}
assertGrokAvailable(original, { block, ownedTables: ${JSON.stringify(ownedTables)} }, previousState);
const routingReady = ${Boolean(ctx.proxy)} && (!automatic || modelResolved) && !grokMissingCredential({ proxy: ${Boolean(ctx.proxy)}, automatic, block, nativeSession });
const modelRouting = null;
const nativeHome = path.join(privateRoot, "native"), nativeConfig = path.join(nativeHome, "config.toml");
grokPrivateDirectory(nativeHome);
const nativeBefore = grokFile(nativeConfig)?.toString() ?? null;
const nativeOriginal = previousState && nativeBefore !== null ? withoutManagedConfig(nativeBefore, previousState) : nativeBefore || "";
assertGrokAvailable(nativeOriginal, { block, ownedTables: ${JSON.stringify(ownedTables)} }, previousState);
const policyFile = path.join(nativeHome, "managed_config.toml"), policyBefore = grokFile(policyFile);
const policyOriginal = previousState?.nativePolicy ? (previousState.nativePolicy.before === null ? null : Buffer.from(previousState.nativePolicy.before, "base64")) : policyBefore;
const policy = grokToml.stringify({ ...readGrokToml(policyBefore?.toString() || ""), allow_managed_hooks_only: true });
const shell = grokShellChanges(previousState, true);
const guardName = process.platform === "win32" ? "startup.ps1" : "startup.sh";
const guardFile = path.join(privateRoot, guardName), guardBefore = grokFile(guardFile);
const guardSource = process.platform === "win32" ? ${JSON.stringify(guardWindows)} : ${JSON.stringify(guardBash)};
if (previousState?.startupGuard) {
  if (previousState.startupGuard.file !== guardName || grokDigest(guardBefore) !== previousState.startupGuard.sha256) throw new Error("The Grok startup screen changed. Preserve your edits before reconnecting.");
} else if (guardBefore !== null) throw new Error("An unmanaged Grok startup screen exists. Preserve it before reconnecting.");
const startupGuard = { healthUrl: ${JSON.stringify(buildStartupGuardContext(ctx).healthUrl)}, file: guardName, sha256: grokDigest(Buffer.from(guardSource)), before: previousState?.startupGuard ? previousState.startupGuard.before : guardBefore?.toString("base64") ?? null };
commitGrokTransaction({ root: privateRoot, home, changes: [
  { file: config, expected: beforeCommit, content: beforeCommit === null && !original ? null : original },
  { file: nativeConfig, expected: nativeBefore, content: assembleGrokConfig(nativeOriginal, { modelRouting, block }) },
  { file: policyFile, expected: policyBefore, content: policy },
  ...shell.changes,
  { file: guardFile, expected: guardBefore, content: guardSource },
  { file: snapshot, content: JSON.stringify({ format: 2, config, activeConfig: nativeConfig, block, home, ownedTables: ${JSON.stringify(ownedTables)}, proxy: ${Boolean(ctx.proxy)}, nativeSession, automatic, modelResolved, modelRouting, oauthIssuer: ${JSON.stringify(ctx.mcp?.oauthIssuer ?? (ctx.mcp ? new URL(ctx.mcp.url).origin : null))}, nativePolicy: { before: policyOriginal?.toString("base64") ?? null, after: policy }, shellProfiles: shell.profiles, startupGuard, guardrailToolAllowRules: ${JSON.stringify(guardrailToolAllowRules)} }) },
  { file: path.join(privateRoot, "skills.cjs"), content: ${JSON.stringify(`${GROK_SKILLS}\nmodule.exports = syncGrokSkills;`)} },
  { file: path.join(privateRoot, "launch.cjs"), content: ${JSON.stringify(`const grokAppName = ${JSON.stringify(ctx.appName)};\n${GROK_LAUNCHER}`)} },
  { file: path.join(privateRoot, "sign-in.cjs"), content: ${ctx.mcp ? JSON.stringify(`${GROK_MCP_SIGN_IN}\nnew GrokMcpSignIn({ ...${JSON.stringify({ serverName: ctx.mcp.serverName, url: ctx.mcp.url, issuer: ctx.mcp.oauthIssuer ?? new URL(ctx.mcp.url).origin })}, home: require('node:path').join(__dirname, 'native') }).run({ force: true }).catch(error => { console.error(error.message); process.exitCode = 1; });`) : "null"} },
  { file: path.join(privateRoot, "login.cjs"), content: ${JSON.stringify(`const fs = require("node:fs"), path = require("node:path");\n${GROK_CONFIG_TRANSACTION}\ngrokPrivateDirectory(path.join(__dirname, "native"));\nconst state = readGrokSnapshot(path.join(__dirname, "connection.json"));\nconst args = process.argv.slice(2);\nconst mode = args.some(arg => ["--oauth", "--no-oauth", "--device-auth"].includes(arg)) ? [] : ["--oauth"];\nconst env = { ...process.env, GROK_HOME: path.join(__dirname, "native"), ...(state.nativeSession ? { GROK_AUTH_PATH: state.nativeSession.authPath } : {}) };\nfor (const name of ["GROK_CLI_CHAT_PROXY_BASE_URL", "GROK_MODELS_BASE_URL", "GROK_MODELS_LIST_URL", "GROK_CONFIG", "GROK_CONFIG_PATH", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]) delete env[name];\nconst result = require("node:child_process").spawnSync("grok", ["login", ...mode, ...args], { env, stdio: "inherit", shell: false }); process.exitCode = result.status ?? 1;`)} },
  { file: path.join(privateRoot, "disconnect.cjs"), content: ${JSON.stringify(GROK_DISCONNECT)} }
] });
releaseLock();
console.log(${Boolean(ctx.proxy)} && !routingReady ? "MCP and skills settings saved. Native model preferences were preserved. Set " + grokMissingCredential({ proxy: true, automatic, block }) + " in this terminal or choose a provider-backed personal virtual key before managed launch. MCP authorization does not supply an LLM API key." : ${JSON.stringify(ctx.proxy ? "Grok proxy routing saved for every model role. Use the managed launcher; MCP authorization is a separate installer step." : "Grok gateway settings saved. MCP authorization is a separate installer step; LLM proxy routing was not enabled.")});`;
}

const GROK_ATOMIC_WRITE = `function writeAtomic(file, content, expectedDigest) {
  const temporary = file + "." + require("node:crypto").randomUUID() + ".tmp";
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (expectedDigest !== undefined && grokDigest(grokFile(file)) !== expectedDigest) throw new Error("Concurrent Grok write detected before replacement; unknown content was preserved.");
    fs.renameSync(temporary, file);
    let directory;
    try { directory = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(directory); }
    catch (error) { if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF", "EACCES"].includes(error.code)) throw error; }
    finally { if (directory !== undefined) fs.closeSync(directory); }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}`;

const GROK_AUTOMATIC_MODEL = `function resolveAutomaticModel(options) {
  const program = ${JSON.stringify(`${GROK_MODEL_DISCOVERY}\nconst fs = require("node:fs"); discoverGrokModel(JSON.parse(fs.readFileSync(0, "utf8"))).then(value => process.stdout.write(JSON.stringify(value))).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });`)};
  const result = require("node:child_process").spawnSync(process.execPath, ["-e", program], { input: JSON.stringify(options), encoding: "utf8", timeout: 75000, maxBuffer: 1048576, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || "Automatic xAI discovery timed out. No model was changed; retry online or choose an explicit model.");
  return JSON.parse(result.stdout);
}
function withAutomaticModel(block, automatic, model) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) throw new Error("Invalid discovered xAI model ID.");
  return block.replace("# END ARCHESTRA GROK CONNECTION\\n", automatic.template.replace("[model.archestra]\\n", "[model.archestra]\\nmodel = " + JSON.stringify(model) + "\\n") + "# END ARCHESTRA GROK CONNECTION\\n");
}`;

const GROK_MANAGED_CONFIG = GROK_CONFIG;

const GROK_DISCONNECT = `const fs = require("node:fs"), path = require("node:path");
${GROK_ATOMIC_WRITE}
${GROK_MANAGED_CONFIG}
${GROK_CONFIG_TRANSACTION}
${GROK_SHELL}
const home = path.resolve(process.env.GROK_HOME || path.join(require("node:os").homedir(), ".grok"));
const releaseLock = acquireGrokLock(__dirname);
recoverGrokTransaction(__dirname, home);
const snapshot = path.join(__dirname, "connection.json");
if (!fs.existsSync(snapshot)) { console.log("Grok is already disconnected."); process.exit(0); }
const state = readGrokSnapshot(snapshot);
validateGrokState(state, home);
for (const target of [snapshot, state.config, path.dirname(state.config)]) {
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Grok disconnect will not replace symbolic links.");
}
const current = grokFile(state.config)?.toString() ?? "";
if (!state.activeConfig) withoutManagedConfig(current, state);
const skills = path.join(__dirname, "skills.cjs");
if (fs.existsSync(skills)) require(skills)({ source: null, home: state.home || path.dirname(state.config), privateRoot: __dirname });
const afterSkills = grokFile(state.config)?.toString() ?? null;
const nativeConfig = path.join(__dirname, "native/config.toml");
const nativeCurrent = grokFile(nativeConfig)?.toString() ?? null;
const guardChanges = [];
if (state.startupGuard) {
  const guardName = process.platform === "win32" ? "startup.ps1" : "startup.sh";
  const guardFile = path.join(__dirname, guardName), before = grokFile(guardFile);
  if (state.startupGuard.file !== guardName || grokDigest(before) !== state.startupGuard.sha256) throw new Error("The Grok startup screen changed. Preserve your edits before disconnecting.");
  guardChanges.push({ file: guardFile, expected: before, content: state.startupGuard.before === null ? null : Buffer.from(state.startupGuard.before, "base64") });
}
const shell = grokShellChanges(state, false), policyFile = path.join(__dirname, "native/managed_config.toml"), policyBefore = grokFile(policyFile);
let restoredPolicy = policyBefore;
if (state.nativePolicy && policyBefore) {
  const document = readGrokToml(policyBefore.toString()), original = state.nativePolicy.before === null ? null : Buffer.from(state.nativePolicy.before, "base64"), beforeDocument = readGrokToml(original?.toString() || "");
  if (document.allow_managed_hooks_only === true) {
    if (Object.hasOwn(beforeDocument, "allow_managed_hooks_only")) document.allow_managed_hooks_only = beforeDocument.allow_managed_hooks_only;
    else delete document.allow_managed_hooks_only;
    restoredPolicy = equalGrokValue(document, beforeDocument) ? original : Buffer.from(grokToml.stringify(document));
  }
}
commitGrokTransaction({ root: __dirname, home, changes: [
  { file: state.config, expected: afterSkills, content: state.activeConfig ? afterSkills : withoutManagedConfig(afterSkills || "", state) },
  ...(nativeCurrent === null ? [] : [{ file: nativeConfig, expected: nativeCurrent, content: withoutManagedConfig(nativeCurrent, state) }]),
  ...(state.nativePolicy ? [{ file: policyFile, expected: policyBefore, content: restoredPolicy }] : []),
  ...shell.changes,
  ...guardChanges,
  { file: snapshot, content: null }
] });
releaseLock();
console.log("Grok disconnected. Other model, gateway, login and session settings were preserved.");`;

const GROK_LAUNCHER = `const fs = require("node:fs"), path = require("node:path");
${GROK_ATOMIC_WRITE}
${GROK_MANAGED_CONFIG}
${GROK_CONFIG_TRANSACTION}
${GROK_SHELL}
${GROK_AUTOMATIC_MODEL}
${GROK_STARTUP}
${GROK_LOOPBACK_PROXY}
${GROK_NATIVE_TRANSPORT}
const args = process.argv.slice(require.main === module ? 2 : 1);
const worker = args.length === 1 && ["--archestra-prepare-skills", "--archestra-prepare-model", "--archestra-check-readiness"].includes(args[0]);
if (worker) for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { process.exitCode = signal === "SIGINT" ? 130 : 143; });
const startup = worker ? null : new GrokStartup(args, grokAppName);
(async () => {
startup?.phase("Connection state");
const home = path.resolve(process.env.GROK_HOME || path.join(require("node:os").homedir(), ".grok"));
const releaseLock = acquireGrokLock(__dirname);
recoverGrokTransaction(__dirname, home);
let state = readGrokSnapshot(path.join(__dirname, "connection.json"));
validateGrokState(state, home);
if (state.nativePolicy) {
  const policyFile = path.join(__dirname, "native/managed_config.toml"), before = grokFile(policyFile), document = readGrokToml(before?.toString() || "");
  // Native account settings refresh this file. Reassert only our tighten-only
  // hook pin and retain every setting the native client refreshed.
  if (document.allow_managed_hooks_only !== true) {
    const after = grokToml.stringify({ ...document, allow_managed_hooks_only: true });
    state = { ...state, nativePolicy: { ...state.nativePolicy, after } };
    commitGrokTransaction({ root: __dirname, home, changes: [
      { file: policyFile, expected: before, content: after },
      { file: path.join(__dirname, "connection.json"), content: JSON.stringify(state) }
    ] });
  }
}
if (home !== state.home || fs.lstatSync(state.config, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Grok connection changed. Reconnect before launching.");
const activeConfig = state.activeConfig || state.config;
withoutManagedConfig(fs.readFileSync(activeConfig, "utf8"), state);
const skillsFile = path.join(__dirname, "native-skills.json");
if (state.proxy && args.some(arg => (!state.nativeSession && ((arg.startsWith("-m") && !arg.startsWith("--")) || arg === "--model" || arg.startsWith("--model="))) || arg === "--agent" || arg.startsWith("--agent=") || arg === "--agents" || arg.startsWith("--agents="))) throw new Error("Managed Grok model routing and delegation cannot be overridden. Change the approved connection settings instead.");
if (args.some(arg => /^(?:--leader-socket)(?:=|$)/.test(arg))) throw new Error("The protected native session owns its transport process.");
if (state.proxy && args.some(arg => /^--(?:cli-chat-proxy-base-url|xai-api-base-url|models-base-url|models-list-url|grok-ws-url)(?:=|$)/.test(arg))) throw new Error("Managed native endpoints cannot be overridden. Reconnect to change the protected deployment.");
if (args.some(arg => /^(?:--cwd|--add-dir|--plugin-dir)(?:=|$)/.test(arg))) throw new Error("Managed activation roots cannot change after inspection. Change directory before starting the managed launcher.");
startup?.complete("ok", "managed configuration validated");
if (worker && args[0] === "--archestra-check-readiness") { requireGrokCredential(state); releaseLock(); return; }
if (worker && args[0] === "--archestra-prepare-skills" && fs.existsSync(skillsFile)) {
  const skills = JSON.parse(fs.readFileSync(skillsFile, "utf8"));
  require(path.join(__dirname, "skills.cjs"))({ source: skills.source, home, privateRoot: __dirname });
}
if (worker && args[0] === "--archestra-prepare-model" && state.proxy) {
  requireGrokCredential(state);
  const selection = state.automatic ? resolveAutomaticModel(state.automatic) : null;
  const current = fs.readFileSync(activeConfig, "utf8");
  const original = withoutManagedConfig(current, state);
  const previousState = { ...state };
  if (selection) {
    const base = state.block.replace(/\\[model\\.archestra\\][\\s\\S]*?(?=# END ARCHESTRA GROK CONNECTION)/, "");
    state.block = withAutomaticModel(base, state.automatic, selection.model);
  }
  state.modelResolved = true;
  state.modelRouting = null;
  state.format = 2;
  assertGrokAvailable(original, state, previousState);
  commitGrokTransaction({ root: __dirname, home, changes: [
    { file: activeConfig, expected: current, content: assembleGrokConfig(original, state) },
    { file: path.join(__dirname, "connection.json"), content: JSON.stringify(state) }
  ] });
}
releaseLock();
if (worker) return;
startup.checkConnectivity(state.startupGuard?.healthUrl);
if (startup.showBeforeLaunch && state.startupGuard && process.env.ARCHESTRA_GROK_GUARD !== "0") {
  const windows = process.platform === "win32", name = windows ? "startup.ps1" : "startup.sh";
  const guardFile = path.join(__dirname, name);
  if (state.startupGuard.file !== name || grokDigest(grokFile(guardFile)) !== state.startupGuard.sha256) throw new Error("The Grok startup screen changed. Preserve your edits and reconnect before launching.");
  const status = await startup.run(windows ? "powershell.exe" : "bash", windows ? ["-NoProfile", "-File", guardFile, ...args] : [guardFile, ...args], { preparing: false });
  if (status !== 0) throw new Error("The Grok startup screen could not finish. No native session was started.");
  if (!fs.existsSync(path.join(__dirname, "connection.json"))) { console.log("Grok disconnected. Open a fresh terminal to start ordinary Grok."); return; }
  state = readGrokSnapshot(path.join(__dirname, "connection.json"));
  validateGrokState(state, home);
}
startup.phase("Skills sync");
if (fs.existsSync(skillsFile)) await startup.prepare("--archestra-prepare-skills", 120000);
startup.complete("ok", fs.existsSync(skillsFile) ? "managed selection reconciled" : "no managed skills selected");
startup.phase("Model discovery");
if (state.proxy && !args.includes("--sync")) {
  requireGrokCredential(state);
  await startup.prepare("--archestra-prepare-model", 75000);
  state = readGrokSnapshot(path.join(__dirname, "connection.json"));
}
const nativeDefault = state.nativeSession || readGrokToml(state.block).model?.archestra?.model === "archestra-native-default";
startup.complete(nativeDefault || (state.automatic && args.includes("--sync")) ? "pending" : "ok", state.nativeSession ? "native login, model catalog and selection retained; authenticated discovery runs in Grok" : nativeDefault ? "authenticated native catalog resolves the default on the first protected request" : state.automatic ? (args.includes("--sync") ? "deferred until launch" : "current account availability verified") : "approved pinned selection unchanged");
startup.phase("Proxy readiness");
withoutManagedConfig(fs.readFileSync(activeConfig, "utf8"), state);
startup.complete(state.proxy ? "pending" : "off", state.proxy ? "routing validated; server policy/session admission awaits the first native reply" : "MCP-only; native LLM traffic is not protected by this connection");
if (!args.includes("--sync")) {
  const env = { ...process.env };
  env.GROK_HOME = path.join(__dirname, "native");
  grokPrivateDirectory(env.GROK_HOME);
  for (const client of ["CURSOR", "CLAUDE", "CODEX"]) for (const resource of ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS"]) env["GROK_" + client + "_" + resource + "_ENABLED"] = "0";
  for (const client of ["CURSOR", "CLAUDE", "CODEX"]) env["GROK_" + client + "_SESSIONS_ENABLED"] = "0";
  if (state.proxy) {
    env.GROK_ACTIVE_AGENT_MESSAGES = "1";
    delete env.GROK_CONFIG_PATH;
    if (!state.nativeSession) {
      env.GROK_CONFIG = JSON.stringify({ models: readGrokToml(configureGrokModelRouting("").after).models });
      env.GROK_DEFAULT_MODEL = "archestra"; env.GROK_WEB_SEARCH_MODEL = "archestra";
    }
    const model = readGrokToml(state.block).model?.archestra;
    if (model?.extra_headers?.["X-Archestra-Grok-Credential-Mode"] === "native-session") {
      delete env.XAI_API_KEY; delete env.GROK_CODE_XAI_API_KEY;
      env.GROK_CLI_CHAT_PROXY_BASE_URL = model.base_url;
    }
    for (const name of ["GROK_MODELS_BASE_URL", "GROK_MODELS_LIST_URL", "GROK_XAI_API_BASE_URL"]) delete env[name];
  }
  const loopback = await startGrokLoopbackProxy(state, env);
  let nativeTransport;
  try {
  if (state.nativeSession) {
    env.GROK_AUTH_PATH = state.nativeSession.authPath;
    env.GROK_DISABLE_API_KEY_AUTH = "1";
    delete env.XAI_API_KEY; delete env.GROK_CODE_XAI_API_KEY;
    // Keep soft native model preferences, never an inherited routing overlay.
    const preferences = { ...readGrokToml(grokFile(state.config)?.toString() || "").models, ...readGrokToml(fs.readFileSync(activeConfig, "utf8")).models };
    const roles = {};
    for (const key of ["default", "web_search", "session_summary", "image_description"]) {
      const value = preferences[key];
      if (typeof value === "string" && value !== "archestra") roles[key] = value;
    }
    if (Array.isArray(preferences.allowed_models)) {
      const allowed = preferences.allowed_models.filter(value => typeof value === "string" && value !== "archestra");
      if (allowed.length) roles.allowed_models = allowed;
    }
    if (state.nativeSession.model) { roles.default = state.nativeSession.model; env.GROK_DEFAULT_MODEL = state.nativeSession.model; }
    env.GROK_CONFIG = JSON.stringify({ models: roles });
    for (const name of ["GROK_DEFAULT_MODEL", "GROK_WEB_SEARCH_MODEL", "GROK_SESSION_SUMMARY_MODEL", "GROK_IMAGE_DESCRIPTION_MODEL"]) if (env[name] === "archestra") delete env[name];
    nativeTransport = await new GrokNativeTransport(state.nativeSession).start();
    env.GROK_CLI_CHAT_PROXY_BASE_URL = nativeTransport.base;
    // A preexisting blanket proxy bypass must also cover the child-local
    // transport without changing how the approved deployment is reached.
    env.NO_PROXY = env.no_proxy = [env.NO_PROXY || env.no_proxy, "127.0.0.1"].filter(Boolean).join(",");
  }
  startup.phase("Native activation");
  const inspection = require("node:child_process").spawnSync("grok", ["inspect", "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  let activation;
  try { activation = inspection.status === 0 ? JSON.parse(inspection.stdout) : null; } catch {}
  if (!activation || !Array.isArray(activation.hooks) || !Array.isArray(activation.plugins)) throw new Error("Grok activation could not be verified. No native session was started; inspect --json must be supported.");
  if (state.nativeSession) {
    if (!Array.isArray(activation.configSources?.layers)) throw new Error("Grok did not report native configuration sources. No native session was started.");
    assertGrokNativeRouting(readGrokToml(fs.readFileSync(activeConfig, "utf8")));
    for (const layer of activation.configSources.layers) {
      if (layer.role === "env_overlay") continue; // The child overlay above contains soft role preferences only.
      if (layer.note === "empty") continue;
      if (layer.note || typeof layer.path !== "string" || !fs.existsSync(layer.path)) throw new Error("A native configuration layer could not be verified. No native session was started.");
      assertGrokNativeRouting(readGrokToml(fs.readFileSync(layer.path, "utf8")));
    }
  }
  const policySource = value => { try { const resolved = fs.realpathSync(value); return process.platform === "win32" ? resolved.toLowerCase() : resolved; } catch { return null; } };
  const expectedPolicySource = policySource(path.join(env.GROK_HOME, "managed_config.toml"));
  const hookRestriction = expectedPolicySource && activation.permissions?.enforced?.some(entry => entry.setting === "nonManagedHooks" && entry.enabled === false && policySource(entry.source) === expectedPolicySource);
  if (state.nativePolicy && (!hookRestriction || readGrokToml(grokFile(path.join(env.GROK_HOME, "managed_config.toml"))?.toString() || "").allow_managed_hooks_only !== true)) throw new Error("Grok did not confirm managed-profile hook isolation. No native session was started.");
  if (!hookRestriction && (activation.hooks.length || activation.plugins.some(plugin => plugin.enabled !== false))) throw new Error("This managed Grok profile activates hooks without verified isolation. Reconnect with the updated installer before launching.");
  startup.complete("ok", hookRestriction ? "ambient hooks suppressed by the dedicated profile; organization policy preserved" : "dedicated native profile; no active plugins or hooks");
  const helperRules = state.guardrailToolAllowRules ?? [];
  if (!Array.isArray(helperRules) || helperRules.some(rule => typeof rule !== "string" || !/^[A-Za-z0-9_.-]+__grokx(?:[A-Za-z0-9-]|_[0-9a-f]{2})+$/.test(rule))) throw new Error("Managed Grok guardrail tool permissions are invalid. Reconnect before launching.");
  const modelArguments = state.proxy && !state.nativeSession && (!state.automatic || state.modelResolved) ? ["-m", "archestra"] : [];
  process.exitCode = await startup.launch([...modelArguments, ...helperRules.map(rule => "--allow=" + rule), ...args], env);
  } finally { await nativeTransport?.close(); await loopback?.close(); }
}
})().then(() => startup?.close()).catch(error => { if (worker) process.stderr.write(JSON.stringify({ archestraError: /^GROK_CREDENTIAL_(?:XAI|OPENAI|ANTHROPIC)_API_KEY$/.test(error.code || "") ? error.code : "GROK_PREPARATION_FAILED" })); else startup?.close(error); process.exitCode = startup?.cancelled || 1; });
`;
