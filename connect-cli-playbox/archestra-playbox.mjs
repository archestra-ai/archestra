#!/usr/bin/env node
/**
 * Archestra Unified Connect — CLI UX Playbox (DRY-RUN ONLY)
 *
 * Simulates:
 *   curl -LsSf https://frontend.archestra.dev/install.sh | sh
 *
 * Performs real read-only autodetection on this machine, then walks through an
 * interactive terminal flow that unifies `/connection` (agents) and
 * `/account/devices` (local MCP bridge). Each prompt collapses to one clean line.
 *
 * Installs nothing. Writes zero files. Makes zero network calls.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, hostname, arch, platform } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

const ARCHESTRA_URL = process.env.ARCHESTRA_URL || "https://frontend.archestra.dev";
const CLI_VERSION = "0.14.2";
const args = process.argv.slice(2);
const SUBCMD = args[0] && !args[0].startsWith("-") ? args[0] : "";

const USE_DEMO = args.includes("--demo");
const USE_EMPTY = args.includes("--empty");
const NO_BRIDGE_FLAG = args.includes("--no-bridge");
const STATUS_OFFLINE = args.includes("--offline");
const STATUS_DEGRADED = args.includes("--degraded");
const JSON_OUTPUT = args.includes("--json");
const AUTO_YES = args.includes("-y") || args.includes("--yes");
const IS_TTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);

// ANSI palette (edda/install.sh + Omnigent-inspired colored sections, zero emoji)
const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const c = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const cyan = (s) => c("36", s);
const blue = (s) => c("38;5;75", s);
const pink = (s) => c("38;5;212", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const red = (s) => c("31", s);

function printBanner(subtitle) {
  console.log("");
  console.log(`  ${pink("◆")}  ${pink("▄▀█ █▀█ █▀▀ █ █ █▀▀ █▀▀ ▀█▀ █▀█ ▄▀█")}`);
  console.log(`  ${dim("│")}  ${pink("█▀█ █▀▄ █   █▀█ █▀▀ ▀▀█  █  █▀▄ █▀█")}`);
  console.log(`  ${dim("◇")}  ${pink("▀ ▀ ▀ ▀ ▀▀▀ ▀ ▀ ▀▀▀ ▀▀▀  ▀  ▀ ▀ ▀ ▀")}`);
  if (subtitle) {
    console.log("");
    console.log(`  ${dim(subtitle)}`);
  }
}

function printHelp() {
  printBanner("All your agents, MCP servers, and local bridge — one CLI");
  console.log("");
  console.log(`  ${dim("Version     ")}${bold(CLI_VERSION)}`);
  console.log(`  ${dim("Get started ")}${bold("archestra connect")}`);
  console.log("");
  console.log(`  ${pink("Usage:")} archestra [OPTIONS] COMMAND [ARGS]...`);
  console.log("");
  console.log(`  ${pink("Agents:")}`);
  const agentCmds = [
    ["claude", "Launch Claude Code with Archestra gateway & skills."],
    ["cursor", "Launch Cursor with Archestra MCP & proxy wired."],
    ["codex", "Launch Codex CLI with Archestra gateway & skills."],
    ["opencode", "Launch OpenCode with Archestra gateway & proxy."],
    ["copilot", "Launch Copilot CLI with Archestra gateway."],
    ["pi", "Launch Pi with Archestra gateway & proxy."],
    ["kimi", "Launch Kimi Code with Archestra gateway."],
  ];
  for (const [cmd, desc] of agentCmds) {
    console.log(`    ${pink(cmd.padEnd(12))} ${desc}`);
  }
  console.log("");
  console.log(`  ${dim("Run `archestra connect` to autodetect & wire installed agents.")}`);
  console.log("");
  console.log(`  ${pink("Commands:")}`);
  const cmds = [
    ["connect", "Autodetect agents, link this device, and configure MCP/proxy."],
    ["status", "Show unified device, local MCP bridge, and agent status."],
    ["doctor", "Run read-only health checks on gateway, proxy, and bridge."],
    ["bridge", "Start, stop, or inspect the local MCP bridge daemon."],
    ["update", "Update the Archestra CLI to the latest version."],
    ["uninstall", "Unlink this device and remove local Archestra config."],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`    ${blue(cmd.padEnd(12))} ${desc}`);
  }
  console.log("");
  console.log(`  ${pink("Options:")}`);
  const opts = [
    ["--demo", "Simulate a Mac with 4 detected agents."],
    ["--empty", "Simulate a machine with no agents detected."],
    ["--no-bridge", "Default local MCP bridge to off."],
    ["--offline", "(status) Simulate stopped MCP bridge."],
    ["--degraded", "(status) Simulate a failing local MCP server."],
    ["--json", "(status) Emit machine-readable JSON."],
    ["-y, --yes", "Accept defaults non-interactively."],
    ["-h, --help", "Show this message and exit."],
  ];
  for (const [flag, desc] of opts) {
    console.log(`    ${green(flag.padEnd(12))} ${desc}`);
  }
  console.log("");
}

if (args.includes("-h") || args.includes("--help") || SUBCMD === "" || SUBCMD === "help") {
  printHelp();
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (s) => process.stdout.write(s);

const RAIL = dim("│");
const NODE = dim("├─");
const END = dim("└─");

const gap = () => console.log(RAIL);
const step = (label, value) => console.log(`${NODE} ${dim(label.padEnd(11))} ${value}`);
const ok = (label, value) => console.log(`${RAIL}  ${green("✓")} ${label.padEnd(10)} ${value}`);
const live = (label, value) => console.log(`${RAIL}  ${green("●")} ${label.padEnd(14)} ${value}`);
const skip = (label, value) => console.log(`${RAIL}  ${dim("◇")} ${dim(label.padEnd(10))} ${dim(value)}`);
const warn = (label, value) => console.log(`${RAIL}  ${yellow("▲")} ${label.padEnd(10)} ${dim(value)}`);

async function spin(message, durationMs = 420) {
  if (!IS_TTY) return;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const steps = Math.max(4, Math.floor(durationMs / 75));
  for (let i = 0; i < steps; i++) {
    write(`\r\x1b[2K${RAIL}  ${cyan(frames[i % frames.length])} ${message}`);
    await sleep(75);
  }
  write("\r\x1b[2K");
}

function hasCmd(name) {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}

function detectPlatform() {
  const p = platform();
  const a = arch();
  const osLabel = p === "darwin" ? "macos" : p === "win32" ? "windows" : "linux";
  const archLabel = a === "arm64" ? "arm64" : a === "x64" ? "x86_64" : a;
  return `${osLabel}-${archLabel}`;
}

const ALL_AGENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    launchCmd: "claude",
    caps: ["mcp", "skills", "plugins", "proxy"],
    detect: () => hasCmd("claude") || existsSync(join(homedir(), ".claude")),
  },
  {
    id: "cursor",
    name: "Cursor",
    launchCmd: "cursor .",
    caps: ["mcp", "skills", "proxy"],
    detect: () =>
      hasCmd("cursor") ||
      existsSync("/Applications/Cursor.app") ||
      existsSync(join(homedir(), ".cursor")),
  },
  {
    id: "codex",
    name: "Codex CLI",
    launchCmd: "codex",
    caps: ["mcp", "skills"],
    detect: () => hasCmd("codex") || existsSync(join(homedir(), ".codex")),
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    launchCmd: "open -a Claude",
    caps: ["mcp"],
    detect: () =>
      existsSync("/Applications/Claude.app") ||
      existsSync(join(homedir(), "Library/Application Support/Claude")),
  },
  {
    id: "opencode",
    name: "OpenCode",
    launchCmd: "opencode",
    caps: ["mcp", "skills", "proxy"],
    detect: () =>
      hasCmd("opencode") || existsSync(join(homedir(), ".config/opencode")),
  },
  {
    id: "copilot",
    name: "Copilot CLI",
    launchCmd: "copilot",
    caps: ["mcp", "skills"],
    detect: () => hasCmd("copilot") || existsSync(join(homedir(), ".copilot")),
  },
  {
    id: "kilo",
    name: "Kilo Code",
    launchCmd: "kilo",
    caps: ["mcp", "skills"],
    detect: () => hasCmd("kilo") || existsSync(join(homedir(), ".kilo")),
  },
  {
    id: "pi",
    name: "Pi",
    launchCmd: "pi",
    caps: ["mcp", "proxy"],
    detect: () => hasCmd("pi") || existsSync(join(homedir(), ".pi")),
  },
  {
    id: "kimi",
    name: "Kimi Code",
    launchCmd: "kimi",
    caps: ["mcp", "skills"],
    detect: () => hasCmd("kimi") || existsSync(join(homedir(), ".kimi")),
  },
];

const GATEWAYS = [
  { id: "my-gateway", label: "My Gateway", mcp: 12, skills: 88, plugins: 10 },
  { id: "engineering", label: "Engineering", mcp: 24, skills: 140, plugins: 14 },
  { id: "personal", label: "Personal", mcp: 4, skills: 18, plugins: 2 },
];

function detectAgents() {
  if (USE_EMPTY) return ALL_AGENTS.map((a) => ({ ...a, detected: false }));
  if (USE_DEMO) {
    const demoSet = new Set(["claude-code", "cursor", "codex", "claude-desktop"]);
    return ALL_AGENTS.map((a) => ({ ...a, detected: demoSet.has(a.id) }));
  }
  return ALL_AGENTS.map((a) => ({ ...a, detected: a.detect() }));
}

function summarizeAgent(agent, gateway, useProxy) {
  const parts = [`${gateway.mcp} MCP`];
  if (agent.caps.includes("skills")) parts.push(`${gateway.skills} skills`);
  if (agent.caps.includes("plugins")) parts.push(`${gateway.plugins} plugins`);
  if (useProxy && agent.caps.includes("proxy")) parts.push("⇄ proxy");
  return parts.join(" · ");
}

/** Arrow-key + spacebar multi-select (collapses cleanly on confirm). */
async function multiSelect(title, items) {
  if (!IS_TTY || AUTO_YES) return items.filter((i) => i.checked);

  let cursor = 0;
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) write(`\x1b[${renderedLines}A`);
    const lines = [
      `${RAIL}  ${cyan("◆")} ${bold(title)} ${dim("(↑/↓ · space · a all · ↵)")}`,
    ];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const pointer = i === cursor ? cyan("❯") : " ";
      const box = it.checked ? green("◉") : dim("◯");
      const label = i === cursor ? bold(it.label) : it.dimmed && !it.checked ? dim(it.label) : it.label;
      const hint = it.hint ? ` ${dim(it.hint)}` : "";
      lines.push(`${RAIL}    ${pointer} ${box} ${label}${hint}`);
    }
    for (const line of lines) write(`\r\x1b[2K${line}\n`);
    renderedLines = lines.length;
  };

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    write("\x1b[?25l");
    render();

    const clear = () => {
      if (renderedLines > 0) {
        write(`\x1b[${renderedLines}A`);
        for (let i = 0; i < renderedLines; i++) write("\r\x1b[2K\n");
        write(`\x1b[${renderedLines}A`);
      }
    };
    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      write("\x1b[?25h");
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if ((key.ctrl && key.name === "c") || key.name === "escape" || key.name === "q") {
        clear();
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key.name === "space") {
        items[cursor].checked = !items[cursor].checked;
        render();
      } else if (key.name === "a") {
        const allOn = items.every((i) => i.checked);
        for (const i of items) i.checked = !allOn;
        render();
      } else if (key.name === "return") {
        clear();
        cleanup();
        resolve(items.filter((i) => i.checked));
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

/** Arrow-key single-select (collapses cleanly on confirm). */
async function singleSelect(title, options, defaultIndex = 0) {
  if (!IS_TTY || AUTO_YES) return options[defaultIndex];

  let cursor = defaultIndex;
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) write(`\x1b[${renderedLines}A`);
    const lines = [`${RAIL}  ${cyan("◆")} ${bold(title)} ${dim("(↑/↓ · ↵)")}`];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const pointer = i === cursor ? cyan("❯") : " ";
      const glyph = i === cursor ? cyan("●") : dim("○");
      const label = i === cursor ? bold(opt.label) : opt.label;
      const hint = opt.hint ? ` ${dim(opt.hint)}` : "";
      lines.push(`${RAIL}    ${pointer} ${glyph} ${label}${hint}`);
    }
    for (const line of lines) write(`\r\x1b[2K${line}\n`);
    renderedLines = lines.length;
  };

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    write("\x1b[?25l");
    render();

    const clear = () => {
      if (renderedLines > 0) {
        write(`\x1b[${renderedLines}A`);
        for (let i = 0; i < renderedLines; i++) write("\r\x1b[2K\n");
        write(`\x1b[${renderedLines}A`);
      }
    };
    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      write("\x1b[?25h");
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if ((key.ctrl && key.name === "c") || key.name === "escape" || key.name === "q") {
        clear();
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % options.length;
        render();
      } else if (key.name === "return") {
        clear();
        cleanup();
        resolve(options[cursor]);
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

/** Single-key Y/n toggle that collapses cleanly after answer. */
async function askYesNo(question, defaultYes = true) {
  if (!IS_TTY || AUTO_YES) return defaultYes;

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    write(`${RAIL}  ${cyan("◆")} ${bold(question)} ${dim(hint)} `);

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
    };

    const onKey = (str, key) => {
      if (key?.ctrl && key.name === "c") {
        write("\r\x1b[2K");
        cleanup();
        resolve(null);
        return;
      }
      const ch = (str || "").toLowerCase();
      if (key?.name === "return") {
        write("\r\x1b[2K");
        cleanup();
        resolve(defaultYes);
      } else if (ch === "y") {
        write("\r\x1b[2K");
        cleanup();
        resolve(true);
      } else if (ch === "n") {
        write("\r\x1b[2K");
        cleanup();
        resolve(false);
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

/** Interactive simulated browser approval (Enter = approve, d = simulate deny). */
async function waitForApproval(code) {
  if (!IS_TTY || AUTO_YES) {
    await spin(`Waiting for browser approval (${code})...`, 650);
    return "approved";
  }
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    write(
      `${RAIL}  ${cyan("◌")} Code ${bold(code)}  ${dim("(↵ approve · d deny · ^C cancel)")} `,
    );

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
    };

    const onKey = (str, key) => {
      if (key?.ctrl && key.name === "c") {
        write("\r\x1b[2K");
        cleanup();
        resolve("cancelled");
        return;
      }
      const ch = (str || "").toLowerCase();
      if (key?.name === "return" || ch === "y") {
        write("\r\x1b[2K");
        cleanup();
        resolve("approved");
      } else if (ch === "d") {
        write("\r\x1b[2K");
        cleanup();
        resolve("denied");
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

function runStatus({ host, plat, gateway, useProxy, wantBridge, chosenAgents }) {
  const localServers = STATUS_OFFLINE
    ? []
    : STATUS_DEGRADED
      ? [
          { name: "filesystem", status: "running", tools: 11, callsToday: 39 },
          { name: "postgres-local", status: "failed", error: "connection refused on :5432", callsToday: 0 },
          { name: "git", status: "running", tools: 8, callsToday: 27 },
        ]
      : [
          { name: "filesystem", status: "running", tools: 11, callsToday: 39 },
          { name: "postgres-local", status: "running", tools: 6, callsToday: 14 },
          { name: "git", status: "running", tools: 8, callsToday: 27 },
        ];

  const agentStatsById = {
    "claude-code": { callsToday: 84, lastActive: "2m ago" },
    cursor: { callsToday: 41, lastActive: "19m ago" },
    codex: { callsToday: 17, lastActive: "1h ago" },
    "claude-desktop": { callsToday: 0, lastActive: "idle" },
    opencode: { callsToday: 12, lastActive: "34m ago" },
    copilot: { callsToday: 6, lastActive: "3h ago" },
    kilo: { callsToday: 0, lastActive: "idle" },
    pi: { callsToday: 9, lastActive: "48m ago" },
    kimi: { callsToday: 4, lastActive: "5h ago" },
  };

  const stats = {
    toolCallsToday: 142,
    toolCalls7d: 1284,
    sparkline7d: "▁▂▃▅▄▇█",
    tokensInToday: "1.8M",
    tokensOutToday: "310k",
    costTodayUsd: 4.12,
    guardrails: { mode: "observe", blocked: 0, flagged: 3 },
  };

  const bridgeState = !wantBridge
    ? "disabled"
    : STATUS_OFFLINE
      ? "offline"
      : STATUS_DEGRADED
        ? "degraded"
        : "online";

  if (JSON_OUTPUT) {
    console.log(
      JSON.stringify(
        {
          device: { name: host, platform: plat, cliVersion: CLI_VERSION, url: ARCHESTRA_URL },
          gateway: { id: gateway.id, name: gateway.label, mcpServers: gateway.mcp, skills: gateway.skills },
          stats,
          bridge: { status: bridgeState, localServers },
          agents: chosenAgents.map((a) => ({
            id: a.id,
            name: a.name,
            connected: true,
            proxy: Boolean(useProxy && a.caps.includes("proxy")),
            ...(agentStatsById[a.id] ?? { callsToday: 0, lastActive: "idle" }),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log(`${pink("◆")} ${bold("Archestra")} ${dim("· status")}`);
  gap();

  step("Device", `${bold(host)} ${dim(`· ${plat} · v${CLI_VERSION}`)}`);
  step("Deployment", `${cyan(ARCHESTRA_URL)} ${dim(`· ${gateway.label}`)}`);
  gap();

  // Activity / usage stats strip
  step(
    "Activity",
    `${bold(String(stats.toolCallsToday))} ${dim("calls today ·")} ${bold(stats.toolCalls7d.toLocaleString())} ${dim("7d")}  ${cyan(stats.sparkline7d)}`,
  );
  step(
    "Usage",
    `${bold(stats.tokensInToday)} ${dim("in /")} ${bold(stats.tokensOutToday)} ${dim("out ·")} ${bold(`$${stats.costTodayUsd.toFixed(2)}`)} ${dim("today")}`,
  );
  step(
    "Guardrails",
    `${green("0")} ${dim("blocked ·")} ${yellow(String(stats.guardrails.flagged))} ${dim(`flagged (${stats.guardrails.mode})`)}`,
  );
  gap();

  // Bridge section (/account/devices)
  if (bridgeState === "online") {
    live("MCP bridge", `${green("online")} ${dim(`· up 4h 12m · ${localServers.length} local servers`)}`);
  } else if (bridgeState === "degraded") {
    console.log(
      `${RAIL}  ${yellow("▲")} ${"MCP bridge".padEnd(14)} ${yellow("degraded")} ${dim("· 2 running · 1 failed")}`,
    );
  } else if (bridgeState === "offline") {
    console.log(
      `${RAIL}  ${dim("○")} ${"MCP bridge".padEnd(14)} ${dim("offline · last seen 18m ago")}`,
    );
  } else {
    skip("MCP bridge", "not enabled");
  }

  for (const srv of localServers) {
    if (srv.status === "running") {
      console.log(
        `${RAIL}    ${dim("·")} ${srv.name.padEnd(16)} ${green("●")} ${dim(`${String(srv.tools).padStart(2)} tools · ${srv.callsToday} calls`)}`,
      );
    } else {
      console.log(
        `${RAIL}    ${dim("·")} ${srv.name.padEnd(16)} ${red("✗")} ${red(srv.error)}`,
      );
    }
  }

  gap();

  // Agents section (/connection)
  if (chosenAgents.length > 0) {
    for (const agent of chosenAgents) {
      const aStat = agentStatsById[agent.id] ?? { callsToday: 0, lastActive: "idle" };
      const activity =
        aStat.callsToday > 0
          ? `${aStat.callsToday} calls · ${aStat.lastActive}`
          : aStat.lastActive;
      const proxyTag = useProxy && agent.caps.includes("proxy") ? "⇄ proxy · " : "";
      console.log(
        `${RAIL}  ${green("✓")} ${agent.name.padEnd(14)} ${dim(`${gateway.mcp} MCP · ${proxyTag}${activity}`)}`,
      );
    }
  } else {
    warn("Agents", "none connected");
  }

  gap();
  if (bridgeState === "offline") {
    console.log(`${END} ${yellow("▲")} Bridge is stopped. Run ${cyan("archestra bridge start")} to resume.\n`);
  } else if (bridgeState === "degraded") {
    console.log(`${END} ${yellow("▲")} 1 local server failed. Run ${cyan("archestra logs postgres-local")} to inspect.\n`);
  } else {
    console.log(`${END} ${green("✓")} ${bold("Connected.")} ${dim("All systems nominal.")}\n`);
  }
}

async function main() {
  const plat = detectPlatform();
  const host = hostname().replace(/\.local$/, "");
  const code = "A7F2-9K3M";

  if (SUBCMD === "status") {
    const detected = detectAgents().filter((a) => a.detected);
    runStatus({
      host,
      plat,
      gateway: GATEWAYS[0],
      useProxy: true,
      wantBridge: !NO_BRIDGE_FLAG,
      chosenAgents: detected,
    });
    return;
  }

  if (SUBCMD === "doctor") {
    console.log("");
    console.log(`${pink("◆")} ${bold("Archestra")} ${dim("· doctor")}`);
    gap();
    await spin("Checking gateway reachability...", 320);
    ok("Gateway", `${green("200 OK")} ${dim("· 38ms · My Gateway")}`);
    await spin("Checking LLM proxy & guardrails...", 300);
    ok("Proxy", `${cyan("⇄")} ${bold("reachable")} ${dim("· guardrails: observe")}`);
    await spin("Checking local MCP bridge daemon...", 300);
    live("MCP bridge", `${green("online")} ${dim("· pid 41822 · 3 local servers")}`);
    await spin("Checking agent configs...", 280);
    const detected = detectAgents().filter((a) => a.detected);
    ok("Agents", dim(`${detected.length} configs valid · no drift detected`));
    gap();
    console.log(`${END} ${green("✓")} ${bold("Healthy.")} ${dim("(dry-run)")}\n`);
    return;
  }

  const agentAlias = {
    claude: "claude-code",
    cursor: "cursor",
    codex: "codex",
    opencode: "opencode",
    copilot: "copilot",
    pi: "pi",
    kimi: "kimi",
  }[SUBCMD];

  if (agentAlias) {
    const agent = ALL_AGENTS.find((a) => a.id === agentAlias);
    console.log("");
    console.log(`${pink("◆")} ${bold("Archestra")} ${dim(`· launching ${agent.name}`)}`);
    gap();
    step("Gateway", `${bold("My Gateway")} ${dim("· 12 MCP · 88 skills")}`);
    if (agent.caps.includes("proxy")) {
      step("Proxy", `${cyan("⇄")} ${bold("on")} ${dim("· guardrails: observe")}`);
    }
    step("Command", cyan(agent.launchCmd));
    gap();
    console.log(`${END} ${dim("(playbox dry-run — not actually spawning agent)")}\n`);
    return;
  }

  if (SUBCMD !== "connect") {
    console.error(`${red("✗")} Unknown command: ${bold(SUBCMD)}. Run ${cyan("archestra --help")}.`);
    process.exit(1);
  }

  printBanner("All your agents, MCP servers, and local bridge — one CLI");
  console.log("");
  console.log(`${pink("◆")} ${bold("Connect")} ${dim("· playbox dry-run")}`);
  gap();

  step("Platform", `${bold(plat)} ${dim(`· ${host}`)}`);

  await spin(`Installing archestra CLI v${CLI_VERSION}...`, 450);
  step("CLI", `${dim(`~/.local/bin/archestra · v${CLI_VERSION}`)}`);
  gap();

  await spin(`Scanning ${host} for installed agents...`, 400);
  const scanned = detectAgents();
  const detected = scanned.filter((a) => a.detected);
  const others = scanned.filter((a) => !a.detected);

  // 1. Interactive agent picker
  const agentMenu = [
    ...detected.map((a) => ({
      id: a.id,
      label: a.name,
      hint: "detected",
      checked: true,
      dimmed: false,
      agent: a,
    })),
    ...others.map((a) => ({
      id: a.id,
      label: a.name,
      hint: "not installed",
      checked: false,
      dimmed: true,
      agent: a,
    })),
  ];

  const pickedAgents = await multiSelect(
    detected.length > 0
      ? `Connect detected agents? (${detected.length} found)`
      : "No local agents detected — select any to configure:",
    agentMenu,
  );
  if (pickedAgents === null) {
    console.log(`${END} ${dim("Cancelled.")}\n`);
    process.exit(0);
  }
  const chosenAgents = pickedAgents.map((i) => i.agent);

  if (chosenAgents.length > 0) {
    ok("Agents", bold(chosenAgents.map((a) => a.name).join(", ")));
  } else {
    warn("Agents", "none · device bridge only");
  }

  // 2. Interactive local MCP bridge toggle (/account/devices)
  const wantBridge = await askYesNo(
    `Run local MCP bridge on ${host} (expose local MCP servers to Archestra)?`,
    !NO_BRIDGE_FLAG,
  );
  if (wantBridge === null) {
    console.log(`${END} ${dim("Cancelled.")}\n`);
    process.exit(0);
  }
  if (wantBridge) {
    ok("Bridge", `${bold("enabled")} ${dim("· background daemon")}`);
  } else {
    skip("Bridge", "skipped");
  }

  if (chosenAgents.length === 0 && !wantBridge) {
    console.log(`${END} ${dim("Nothing selected.")}\n`);
    process.exit(0);
  }

  // 3. Interactive gateway picker
  const gateway = await singleSelect(
    "Gateway:",
    GATEWAYS.map((g) => ({
      ...g,
      hint: `${g.mcp} MCP · ${g.skills} skills · ${g.plugins} plugins`,
    })),
    0,
  );
  if (!gateway) {
    console.log(`${END} ${dim("Cancelled.")}\n`);
    process.exit(0);
  }
  ok("Gateway", `${bold(gateway.label)} ${dim(`· ${gateway.mcp} MCP · ${gateway.skills} skills`)}`);

  // 4. Interactive LLM proxy toggle
  let useProxy = false;
  if (chosenAgents.some((a) => a.caps.includes("proxy"))) {
    const proxyAns = await askYesNo(
      "Route LLM traffic through Archestra proxy & guardrails?",
      true,
    );
    if (proxyAns === null) {
      console.log(`${END} ${dim("Cancelled.")}\n`);
      process.exit(0);
    }
    useProxy = proxyAns;
    if (useProxy) {
      ok("Proxy", `${cyan("⇄")} ${bold("on")} ${dim("· guardrails: observe")}`);
    } else {
      skip("Proxy", "off · MCP & skills only");
    }
  }

  // 5. Single browser approval
  gap();
  step("Approve ↗", cyan(`${ARCHESTRA_URL}/connect?code=${code}`));
  const decision = await waitForApproval(code);
  if (decision === "denied") {
    console.log(`${END} ${red("✗")} Approval denied in browser. Nothing was changed.\n`);
    process.exit(1);
  }
  if (decision === "cancelled") {
    console.log(`${END} ${dim("Cancelled.")}\n`);
    process.exit(0);
  }
  ok("Approved", dim(`linked ${host} → ${gateway.label}`));
  gap();

  // 6. Apply
  if (wantBridge) {
    await spin("Starting local MCP bridge...", 400);
    live("MCP bridge", dim("online · background daemon"));
  }
  for (const agent of chosenAgents) {
    await spin(`Configuring ${agent.name}...`, 280);
    console.log(
      `${RAIL}  ${green("✓")} ${agent.name.padEnd(14)} ${dim(summarizeAgent(agent, gateway, useProxy))}`,
    );
  }

  gap();

  // 7. Interactive "What next?"
  if (IS_TTY && !AUTO_YES) {
    const nextOptions = [];
    if (chosenAgents.length > 0) {
      const first = chosenAgents[0];
      nextOptions.push({
        id: "launch",
        label: `Launch ${first.name}`,
        hint: `→ ${first.launchCmd}`,
      });
    }
    nextOptions.push({
      id: "status",
      label: "Check archestra status",
      hint: "device · bridge · agents",
    });
    nextOptions.push({ id: "done", label: "Done", hint: "exit" });

    const next = await singleSelect("What next?", nextOptions, 0);
    if (next?.id === "status") {
      console.log(`${RAIL}  ${green("●")} ${"Device".padEnd(10)} ${bold(host)} ${dim(`· ${plat} · v${CLI_VERSION}`)}`);
      console.log(
        `${RAIL}  ${wantBridge ? green("●") : dim("○")} ${"Bridge".padEnd(10)} ${dim(wantBridge ? "online · background daemon" : "not enabled")}`,
      );
      console.log(
        `${RAIL}  ${green("●")} ${"Agents".padEnd(10)} ${dim(chosenAgents.map((a) => a.name).join(", ") || "none")}`,
      );
      gap();
    } else if (next?.id === "launch") {
      console.log(`${RAIL}  ${cyan("▸")} Would run: ${cyan(next.hint.replace(/^→ /, ""))} ${dim("(playbox dry-run)")}`);
      gap();
    }
  }

  console.log(
    `${END} ${bold("Done.")} Run ${cyan("archestra status")} anytime. ${dim("(dry-run: no files changed)")}\n`,
  );
}

main().catch((err) => {
  console.error(`${red("✗")} ${err.message}`);
  process.exit(1);
});
