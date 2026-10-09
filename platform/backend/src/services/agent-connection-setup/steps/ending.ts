import type {
  AgentEnding,
  SetupEnding,
  SetupEndingPart,
  SetupScriptContext,
} from "../types";
import { describeMarketplaceContents } from "./marketplace-copy";
import { psq, sh } from "./quoting";

/**
 * Environment variable the Node installer sets when it runs a setup script. The
 * script then leaves the ending to the installer, which prints it once and
 * offers to run the sign-in and launch commands.
 */
export const INSTALLER_ENV = "ARCHESTRA_CONNECT_INSTALLER";

/** Comment line that carries the ending inside a script, for the installer. */
const ENDING_MARKER = "# archestra-ending: ";

/** The first prompt the launch command starts an agent with. */
export function starterPrompt(ctx: SetupScriptContext): string {
  return ctx.mcp
    ? `What can you do with my ${ctx.appName} tools?`
    : `What did ${ctx.appName} set up for you?`;
}

/** The shared ending, filled in with what the agent adds. */
export function buildEnding(
  ctx: SetupScriptContext,
  label: string,
  agent: AgentEnding,
): SetupEnding {
  const parts: SetupEndingPart[] = [];
  if (ctx.mcp) {
    parts.push({ name: "Tools", detail: `Added as "${ctx.mcp.serverName}"` });
  }
  if (ctx.proxy) {
    parts.push({
      name: "LLM proxy",
      detail: agent.proxyDetail ?? defaultProxyDetail(ctx, label),
    });
  }
  if (ctx.skills) {
    const { hasSkills, hasPlugins } = describeMarketplaceContents(ctx.skills);
    parts.push({
      name:
        hasSkills && hasPlugins
          ? "Skills, plugins"
          : hasPlugins
            ? "Plugins"
            : "Skills",
      detail: `Installed from "${ctx.skills.marketplaceName}"`,
    });
  }
  parts.push(...(agent.parts ?? []));

  const quote = (command: string[]) => quoteCommand(ctx, command);
  const signIn =
    ctx.mcp && agent.signIn
      ? {
          command: agent.signIn.command,
          text: agent.signIn.command
            ? quote(agent.signIn.command)
            : agent.signIn.howTo,
          howTo: agent.signIn.howTo,
        }
      : null;
  return {
    label,
    appName: ctx.appName,
    parts,
    signIn,
    launch: agent.launch
      ? { command: agent.launch, text: quote(agent.launch) }
      : null,
    notes: agent.notes ?? [],
    disconnect: disconnectLine(ctx),
  };
}

function defaultProxyDetail(ctx: SetupScriptContext, label: string): string {
  const base = `${label} now uses the ${ctx.appName} LLM proxy`;
  if (!ctx.proxy) return base;
  if (ctx.proxy.virtualKey) return `${base} with a virtual key made for you`;
  return `${base}; your ${ctx.proxy.providerLabel} sign-in is unchanged`;
}

function disconnectLine(ctx: SetupScriptContext): string | null {
  if (ctx.connectPageUrl) {
    const url = new URL(ctx.connectPageUrl);
    url.searchParams.set("clientId", ctx.clientId);
    url.searchParams.set("disconnect", "1");
    return `Disconnect anytime: ${url.toString()}`;
  }
  const revocation: string[] = [];
  if (ctx.proxy?.virtualKeyName) {
    revocation.push(
      `delete the "${ctx.proxy.virtualKeyName}" key on the Virtual API Keys page`,
    );
  }
  if (ctx.skills) {
    revocation.push(
      `revoke the "${ctx.skills.marketplaceName}" marketplace share link`,
    );
  }
  return revocation.length > 0
    ? `To disconnect later in ${ctx.appName}: ${revocation.join("; ")}.`
    : null;
}

/** A command as the person would type it in their shell. */
function quoteCommand(ctx: SetupScriptContext, command: string[]): string {
  const quote = ctx.platform === "windows" ? psq : sh;
  return command
    .map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : quote(arg)))
    .join(" ");
}

/**
 * The ending as plain text, for a script run on its own. The Node installer
 * prints the same sections, and asks before running the sign-in.
 */
export function renderEndingText(ending: SetupEnding): string {
  const lines = [`${ending.label} is connected to ${ending.appName}.`];
  if (ending.parts.length > 0) {
    const width = Math.max(...ending.parts.map((part) => part.name.length));
    lines.push(
      "",
      ...ending.parts.map(
        (part) => `  ${part.name.padEnd(width)}   ${part.detail}`,
      ),
    );
  }
  if (ending.signIn) {
    lines.push(
      "",
      `Sign in to ${ending.appName} tools:`,
      `  ${ending.signIn.text}`,
    );
  }
  if (ending.notes.length > 0) {
    lines.push(
      "",
      "Good to know:",
      ...ending.notes.map((note) => `  - ${note}`),
    );
  }
  lines.push(
    "",
    ending.launch
      ? `You're all set. Open a new terminal and start ${ending.label} with a first question for it:\n  ${ending.launch.text}`
      : `You're all set. Open ${ending.label} to start using ${ending.appName}.`,
  );
  if (ending.disconnect) lines.push("", ending.disconnect);
  return lines.join("\n");
}

/** The marker line the installer reads the ending from. */
export function endingMarker(ending: SetupEnding): string {
  return `${ENDING_MARKER}${Buffer.from(JSON.stringify(ending)).toString("base64")}`;
}
