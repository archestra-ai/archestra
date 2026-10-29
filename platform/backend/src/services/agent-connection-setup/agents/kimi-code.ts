import {
  EXTERNAL_AGENT_ID_HEADER,
  KIMI_CODE_CLIENT_ID,
  REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { KIMI_CODE_GUARD_CLIENT } from "../guard/clients";
import {
  KIMI_CODE_CONNECTION,
  KIMI_CODE_LIFECYCLE,
} from "../payloads/kimi-code-connection";
import { MARKETPLACE_SKILLS_SYNC } from "../payloads/marketplace-skills-sync";
import { legacyServerNames } from "../steps/mcp";
import { nodeScriptRenderers } from "../steps/node-script";
import {
  withStartupGuardBash,
  withStartupGuardPowerShell,
} from "../steps/startup-guard";
import type { SetupScriptContext, ShellAgentSetup } from "../types";

/** The oldest Kimi Code this setup was checked against. */
const MIN_KIMI_CODE_VERSION = "2.3.3";
/** Kimi Code refuses a model without a context size; 128K tokens is safe. */
const DEFAULT_CONTEXT_SIZE = 131072;
/** Environment variable that holds the person's own key, per provider. */
const OWN_KEY_ENV: Record<string, string> = {
  "kimi-code": "KIMI_API_KEY",
  kimi: "MOONSHOT_API_KEY",
};

const nodeSetup = nodeScriptRenderers(renderKimiCodeSetup);

export const kimiCodeSetup: ShellAgentSetup = {
  label: "Kimi Code",
  binary: "kimi",
  // Kimi Code has no flag that adds system instructions, so the setup writes
  // them into its AGENTS.md block; the guard must not add a flag for them.
  bash: {
    sections: (ctx) =>
      withStartupGuardBash(
        withoutLaunchInstructions(ctx),
        KIMI_CODE_GUARD_CLIENT,
        nodeSetup.bash.sections(ctx),
      ),
  },
  powerShell: {
    sections: (ctx) =>
      withStartupGuardPowerShell(
        withoutLaunchInstructions(ctx),
        KIMI_CODE_GUARD_CLIENT,
        nodeSetup.powerShell.sections(ctx),
      ),
  },
  ending: (ctx) => {
    const ownKeyEnv = ctx.proxy ? ownKeyVariable(ctx) : null;
    return {
      parts:
        ctx.mcp || ctx.proxy || ctx.skills
          ? [{ name: "Launch check", detail: "Runs each time you start kimi" }]
          : [],
      proxyDetail: ctx.proxy
        ? `Kimi Code's "archestra" model (${ctx.proxy.model ?? "default"}) goes through the LLM proxy`
        : undefined,
      // Kimi Code has no MCP login command: its helper asks Kimi Code to run
      // the gateway's authenticate tool and opens the browser for it.
      signIn: ctx.mcp
        ? {
            command: ["node", `~/${HELPER_PATH}`, "sign-in"],
            howTo: `Start kimi and run /mcp-config login ${ctx.mcp.serverName}, then sign in in your browser.`,
          }
        : null,
      // Kimi Code cannot open its terminal UI with a first message, so it
      // starts without the starter prompt.
      launch: ["kimi"],
      notes: [
        ...(ctx.proxy?.provider === "kimi-code" && !ctx.proxy.virtualKey
          ? [
              "The archestra model uses your Kimi Code sign-in, or KIMI_API_KEY when you are not signed in.",
            ]
          : ownKeyEnv
            ? [
                `Set ${ownKeyEnv} to your own ${ctx.proxy?.providerLabel ?? "Kimi"} API key before you start kimi. Kimi Code reads it from the environment on every request.`,
              ]
            : []),
        "New sessions use the archestra model. Models from your other Kimi Code providers do not go through the LLM proxy and its guardrails.",
        "Kimi Code starts in Ask When Needed mode, so it runs gateway calls, the guardrail helpers included, without asking. It still asks before dangerous commands and still shows questions and reviews. Disconnecting restores your previous mode.",
        "Guardrails allow foreground subagents only. A background, resumed or swarm subagent is refused; ask Kimi Code to start a new foreground subagent instead.",
        `Requires Kimi Code ${MIN_KIMI_CODE_VERSION} or newer.`,
        `To disconnect, run: ${helperText(ctx, "disconnect")}`,
      ],
    };
  },
};

function withoutLaunchInstructions(
  ctx: SetupScriptContext,
): SetupScriptContext {
  return {
    ...ctx,
    runtimeHandoffInstructions: null,
    managedInstructionsSource: null,
    managedRuntimeSource: null,
  };
}

/** The connection's lifecycle helper, relative to the home directory. */
const HELPER_PATH = ".archestra/kimi-code/lifecycle.cjs";

/** A helper command as the person types it; Windows PowerShell does not expand ~. */
function helperText(ctx: SetupScriptContext, action: string): string {
  return ctx.platform === "windows"
    ? `node "$HOME\\${HELPER_PATH.replaceAll("/", "\\")}" ${action}`
    : `node ~/${HELPER_PATH} ${action}`;
}

function ownKeyVariable(ctx: SetupScriptContext): string | null {
  if (!ctx.proxy || ctx.proxy.virtualKey) return null;
  return OWN_KEY_ENV[ctx.proxy.provider] ?? "KIMI_API_KEY";
}

function renderKimiCodeSetup(ctx: SetupScriptContext): string {
  if (!ctx.proxy && !ctx.mcp && !ctx.skills) {
    throw new Error(
      "Kimi Code setup needs a gateway, model routing or skills.",
    );
  }
  if (ctx.proxy && !ctx.proxy.model) {
    throw new Error(
      "Choose a model served by your Kimi provider before connecting Kimi Code.",
    );
  }
  const proxy = ctx.proxy
    ? {
        url: ctx.proxy.url,
        model: ctx.proxy.model,
        contextSize: DEFAULT_CONTEXT_SIZE,
        apiKey: ctx.proxy.virtualKey,
        apiKeyEnv: ownKeyVariable(ctx),
        // A Kimi Code sign-in is a Kimi Code membership token, which only the
        // Kimi Code endpoint accepts.
        useLogin: ctx.proxy.provider === "kimi-code" && !ctx.proxy.virtualKey,
        headers: {
          [EXTERNAL_AGENT_ID_HEADER]: KIMI_CODE_CLIENT_ID,
          ...(ctx.proxy.passthroughVirtualKey
            ? { [VIRTUAL_KEY_HEADER]: ctx.proxy.passthroughVirtualKey }
            : {}),
        },
      }
    : null;
  const connection = {
    appName: ctx.appName,
    server: ctx.mcp?.serverName ?? null,
    gateway: ctx.mcp?.url ?? null,
    legacyServers: ctx.mcp ? legacyServerNames(ctx.mcp) : [],
    // Allow rules for the gateway's tool runner, the guardrail helpers and
    // ask_user, as Claude Code gets. Kimi Code 2.3.3 validates these rules
    // but does not apply them yet, so setup also sets its default mode. The
    // gateway checks access and guardrails either way.
    approvedTools: ctx.mcp
      ? [
          TOOL_RUN_TOOL_SHORT_NAME,
          ...REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
          TOOL_ASK_USER_SHORT_NAME,
        ].map((name) => `${ctx.mcp?.toolPrefix ?? ""}${name}`)
      : [],
    proxy,
    // The gateway sign-in sends it, so the proxy lets that conversation finish
    // the setup without Guardrails.
    setupReference: ctx.mcp ? (ctx.proxy?.setupReference ?? null) : null,
    skills: ctx.skills,
    instructions: ctx.mcp ? (ctx.runtimeHandoffInstructions ?? null) : null,
  };
  return String.raw`const path = require("node:path");
${KIMI_CODE_CONNECTION}
${MARKETPLACE_SKILLS_SYNC}
const c = KimiCodeConnection;
const connection = ${JSON.stringify(connection)};
const lifecycle = ${JSON.stringify(KIMI_CODE_LIFECYCLE)};
const minimum = ${JSON.stringify(MIN_KIMI_CODE_VERSION)}.split(".").map(Number);
const kimi = c.command();
// The npm package runs on this Node.js; the native build needs none.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (kimi.npm && (!Number.isInteger(nodeMajor) || !Number.isInteger(nodeMinor) || nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19))) throw new Error("Kimi Code's npm package requires Node.js 22.19.0 or later. Run setup with a supported Node.js version.");
const version = (kimi.version || /(\d+\.\d+\.\d+)/.exec(c.run(kimi, ["--version"]))?.[1] || "").split(".").map(Number);
if (version.length !== 3 || version.some(part => !Number.isInteger(part)) || version[0] * 1e6 + version[1] * 1e3 + version[2] < minimum[0] * 1e6 + minimum[1] * 1e3 + minimum[2]) throw new Error("Update Kimi Code to " + minimum.join(".") + " or later with kimi upgrade, then rerun setup.");
const root = c.kimiHome();
c.safe(root);
const paths = c.filesOf(root);
const rulePatterns = connection.server ? connection.approvedTools.map(tool => c.qualifiedToolName(connection.server, tool)) : [];
c.lock();
try {
  const previous = c.readState();
  if (previous && previous.kimiHome !== root) throw new Error("Kimi Code is already connected for " + previous.kimiHome + ". Disconnect it first with: " + c.helperCommand("disconnect"));
  const before = c.readFiles(paths);
  // The archestra model sends the person's own credential: an issued virtual
  // key, their Kimi Code sign-in (kimi login), or a key in the environment.
  const proxy = connection.proxy;
  const login = proxy?.useLogin ? c.loginOAuth(before.config ?? "") : null;
  const credential = !proxy ? null : proxy.apiKey ? "key" : login ? "login" : process.env[proxy.apiKeyEnv] ? "env" : null;
  if (proxy && !credential) throw new Error(proxy.useLogin ? "Sign in to Kimi Code first with kimi login, or set " + proxy.apiKeyEnv + " to a Kimi Code API key, then rerun setup." : "Set " + proxy.apiKeyEnv + " to your API key, then rerun setup.");
  // Start from the files without an earlier connection, so a rerun replaces it.
  const base = previous ? c.removeConnection(previous, before) : before;
  let config = base.config ?? "";
  if (!previous) {
    const taken = c.foreignTables(config);
    if (taken.length > 0) throw new Error("config.toml already defines " + taken.join(" and ") + ". Rename them, then rerun setup.");
  }
  config = c.withoutOwnedTables(config, rulePatterns);
  // skills keeps the marketplace source, so the launch check can refresh it.
  const state = { format: 1, kimiHome: root, server: connection.server, gateway: connection.gateway, setupReference: connection.setupReference, previousDefaultModel: null, skillDir: null, skills: connection.skills ? { cloneUrl: connection.skills.cloneUrl, marketplaceName: connection.skills.marketplaceName } : null, rulePatterns };
  if (connection.proxy) {
    state.previousDefaultModel = c.topLevelLine(config, "default_model");
    config = c.setTopLevel(config, "default_model", c.tomlString(c.MODEL)).text;
  }
  // Kimi Code 2.3.3 never applies the allow rules, and Ask When Needed is the
  // only mode that runs the guardrail helpers without asking while it still
  // shows reviews. Disconnect puts the person's own line back.
  if (connection.server) {
    state.previousPermissionMode = c.topLevelLine(config, "default_permission_mode");
    config = c.setTopLevel(config, "default_permission_mode", c.tomlString("yolo")).text;
  }
  if (connection.skills) {
    c.pruneSkills(connection.skills.marketplaceName, new URL(connection.skills.cloneUrl).origin);
    const dir = syncMarketplaceSkills({ source: connection.skills, install: true, root: c.skillsRoot });
    if (dir) {
      const next = c.withSkillDir(config, dir, true);
      if (next) { config = next.text; state.skillDir = dir; }
      else console.warn("Skills were downloaded, but extra_skill_dirs in config.toml is not a one-line list of folders. Add " + dir + " to it yourself.");
    }
  }
  const block = [];
  if (proxy) {
    block.push("[providers." + c.PROVIDER + "]", 'type = "kimi"', "base_url = " + c.tomlString(proxy.url),
      ...(credential === "key" ? ["api_key = " + c.tomlString(proxy.apiKey)] : credential === "env" ? ["api_key_env = " + c.tomlString(proxy.apiKeyEnv)] : []), "",
      "[providers." + c.PROVIDER + ".custom_headers]", ...Object.entries(proxy.headers).map(([name, value]) => c.tomlString(name) + " = " + c.tomlString(value)), "",
      ...(credential === "login" ? ["[providers." + c.PROVIDER + ".oauth]", ...Object.entries(login).map(([name, value]) => name + " = " + c.tomlString(value)), ""] : []),
      "[models." + c.MODEL + "]", "provider = " + c.tomlString(c.PROVIDER), "model = " + c.tomlString(proxy.model),
      "max_context_size = " + proxy.contextSize, "capabilities = " + JSON.stringify(c.capabilities(proxy.model)));
  }
  for (const pattern of rulePatterns) block.push("", "[[permission.rules]]", 'decision = "allow"', "pattern = " + c.tomlString(pattern));
  if (block.length > 0) {
    if (block[0] === "") block.shift();
    config = config.replace(/\s+$/, "");
    config = (config ? config + "\n\n" : "") + [c.BLOCK_START, "# Added by " + connection.appName + " connection setup. Remove it with: " + c.helperCommand("disconnect"), ...block, c.BLOCK_END].join("\n") + "\n";
  }
  let mcp = base.mcp;
  if (connection.server) {
    const parsed = mcp === null || mcp.trim() === "" ? {} : JSON.parse(mcp);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Kimi Code mcp.json must contain a JSON object.");
    parsed.mcpServers ??= {};
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) throw new Error("mcpServers in Kimi Code mcp.json must be an object.");
    for (const name of connection.legacyServers) if (parsed.mcpServers[name]?.url === connection.gateway) delete parsed.mcpServers[name];
    const existing = parsed.mcpServers[connection.server];
    if (existing && existing.url !== connection.gateway) throw new Error("A different MCP server already uses the name " + connection.server + " in mcp.json. Rename it, then rerun setup.");
    // A gateway call can wait for a person's review for several minutes.
    parsed.mcpServers[connection.server] = { ...(existing || {}), url: connection.gateway, toolTimeoutMs: 600000 };
    mcp = JSON.stringify(parsed, null, 2) + "\n";
  }
  const next = { config: config || null, mcp, agents: c.withAgentsBlock(base.agents, connection.instructions) };
  for (const file of Object.values(paths)) c.backup(file);
  // Record the connection before changing a file, so disconnect can undo a
  // setup that stops halfway.
  c.writeState(state);
  c.write(path.join(c.stateRoot, "lifecycle.cjs"), lifecycle);
  c.writeFiles(paths, next, before);
  try {
    c.run(kimi, ["doctor"]);
  } catch (error) {
    c.writeFiles(paths, before, next);
    if (previous) c.writeState(previous);
    else { c.write(c.stateFile, null); c.write(path.join(c.stateRoot, "lifecycle.cjs"), null); try { c.removeSkills(); } catch {} }
    const detail = String(error?.stdout || error?.message || "").split("\n").find(line => line.includes("ERROR") || line.includes("Invalid")) || "";
    throw new Error("Kimi Code rejected the updated configuration, so setup restored your files. " + detail.trim());
  }
  // Nothing points at an earlier checkout any more; a locked one can wait.
  if (!state.skillDir) try { c.removeSkills(); } catch {}
  if (credential === "login") console.log("The archestra model uses your Kimi Code sign-in.");
  else if (credential === "env") console.log("The archestra model reads your key from " + proxy.apiKeyEnv + ".");
  console.log("Kimi Code connection installed in " + root + ".");
} finally {
  c.unlock();
  // Only empty when setup stopped before it recorded a connection.
  try { require("node:fs").rmdirSync(c.stateRoot); } catch {}
}
`;
}
