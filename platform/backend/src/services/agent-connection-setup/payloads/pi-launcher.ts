import { MARKETPLACE_SKILLS_SYNC } from "./marketplace-skills-sync";
import { PI_MCP_SIGN_IN } from "./pi-mcp-sign-in";

/** Run Pi without a shell layer, always loading the managed extension. */
export const PI_LAUNCHER = `// Managed Pi launcher.
(function () {
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
${MARKETPLACE_SKILLS_SYNC}
${PI_MCP_SIGN_IN}
try {
  const root = path.join(os.homedir(), ".archestra/pi");
  const lifecycle = path.join(root, "lifecycle.cjs");
  const initialArgs = process.argv.slice(2);
  const verifyHelper = (file, expected) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || !expected || require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expected) throw new Error("The Pi lifecycle files changed. Preserve your edits and rerun connection setup before retrying.");
  };
  if (initialArgs[0] === "--disconnect") {
    if (!fs.existsSync(lifecycle)) throw new Error("Pi recovery snapshot is missing. Preserve existing configuration and rerun setup for recovery instructions.");
    const saved = JSON.parse(fs.readFileSync(path.join(root, "connection.json"), "utf8"));
    verifyHelper(lifecycle, saved.lifecycleSha256);
    const child = spawnSync(process.execPath, [lifecycle, "disconnect"], { stdio: "inherit", shell: false });
    process.exit(child.status ?? 1);
  }
  const config = JSON.parse(fs.readFileSync(path.join(root, "connection.json"), "utf8"));
  const extension = path.join(os.homedir(), ".pi/agent/extensions/archestra-pi.js");
  const source = fs.readFileSync(extension);
  if (require("node:crypto").createHash("sha256").update(source).digest("hex") !== config.extensionSha256) throw new Error("The Pi connection extension changed. Rerun connection setup before starting arcpi.");
  if (!Array.isArray(config.piCommand) || !config.piCommand.length || !config.piCommand.every(item => typeof item === "string")) throw new Error("Pi launch command is missing. Rerun connection setup.");
  const utility = initialArgs.length === 1 && ["--version", "-v", "--help", "-h"].includes(initialArgs[0]);
  if (utility) {
    const child = spawnSync(config.piCommand[0], [...config.piCommand.slice(1), ...initialArgs], { stdio: "inherit", shell: false });
    process.exit(child.status ?? 1);
  }
  if (initialArgs[0] === "--reconnect") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run arcpi --reconnect in an interactive terminal to sign in. No browser or stdin prompt was opened.");
    verifyHelper(lifecycle, config.lifecycleSha256);
    signInPiGateway({ config, root, lifecycle }).catch(() => {
      console.error("Pi MCP sign-in did not finish. Review the sign-in status above and run arcpi --reconnect to retry.");
      process.exitCode = 1;
    });
    return;
  }
  const args = initialArgs, forwarded = [], overrides = {};
  const valueFlags = new Set(["--mode", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--session", "--session-id", "--fork", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--export", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme", "--tui-mode"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { forwarded.push(...args.slice(i)); break; }
    const name = arg.split("=")[0];
    const key = name === "--provider" ? "provider" : ["--model", "-m"].includes(name) ? "model" : undefined;
    if (!key) {
      forwarded.push(arg);
      if (valueFlags.has(arg) && i + 1 < args.length) forwarded.push(args[++i]);
      continue;
    }
    if (Object.hasOwn(overrides, key)) throw new Error("Specify each provider or model override only once.");
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
    if (!value || value.startsWith("-")) throw new Error("The provider or model override requires a value.");
    overrides[key] = value;
  }
  const catalogs = config.providers || [{ provider: config.provider || "openai", models: [{ id: config.model }] }];
  const selected = catalogs.find(entry => entry.provider === config.provider && entry.models.some(model => model.id === config.model)) || catalogs.find(entry => entry.models.some(model => model.id === config.model));
  if (!selected) throw new Error("The default model is missing from the connected catalog. Rerun setup.");
  const connected = new Map([["archestra", selected.models], ...catalogs.map(entry => ["archestra-" + entry.provider, entry.models])]);
  let provider = overrides.provider || "archestra", model = overrides.model;
  if (model) {
    // Exact references only: Pi's fuzzy fallback must not select a direct provider.
    const reference = [...connected.keys()].find(id => model.startsWith(id + "/"));
    if (reference) {
      if (overrides.provider && overrides.provider !== reference) throw new Error("The model reference and provider override disagree.");
      provider = reference; model = model.slice(reference.length + 1);
    }
  }
  if (!connected.has(provider)) throw new Error("Choose a connected provider with /model. arcpi cannot launch an unconnected provider.");
  model ||= provider === "archestra" ? config.model : connected.get(provider)[0]?.id;
  if (!connected.get(provider).some(entry => entry.id === model)) throw new Error("Choose an exact model ID from the connected catalog.");
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.some(arg => ["--mode", "--print", "-p"].includes(arg) || arg.startsWith("--mode="));
  if (config.lifecycleVersion === 1) {
    if (!fs.existsSync(lifecycle)) throw new Error("Pi lifecycle helper is missing. Rerun setup; no direct provider fallback is allowed.");
    verifyHelper(lifecycle, config.lifecycleSha256);
    if (interactive) {
      verifyHelper(path.join(root, process.platform === "win32" ? "startup.ps1" : "startup.sh"), config.guardSha256);
      const windows = process.platform === "win32";
      const child = spawnSync(windows ? "powershell.exe" : "bash", windows ? ["-NoProfile", "-File", path.join(root, "startup.ps1")] : [path.join(root, "startup.sh")], { stdio: "inherit", shell: false });
      if (child.error || child.status !== 0) throw new Error("Pi startup check could not run. Rerun setup.");
      if (!fs.existsSync(path.join(root, "connection.json"))) { console.log("Disconnected. Open a new terminal and run pi."); process.exit(0); }
    }
    // The shared UI may be skipped. The native launcher must still fail closed.
    const check = spawnSync(process.execPath, [lifecycle, "check"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 65536 });
    let report; try { report = JSON.parse(check.stdout); } catch {}
    if (check.error || check.status !== 0 || !report || [report.llm, report.mcp, report.skills].some(value => value !== "ok")) {
      for (const reason of report?.reasons || []) console.error(reason);
      throw new Error("Pi stays connected, but startup checks failed. Retry, use arcpi --reconnect for MCP sign-in, or arcpi --disconnect to restore Pi. No model request or local tool was started.");
    }
  }
  const skills = syncMarketplaceSkills({ source: config.skills });
  const launchArgs = [...config.piCommand.slice(1), ...(skills ? ["--skill", skills] : []), "--provider", provider, "--model", model, "--extension", extension, ...forwarded];
  const child = spawnSync(config.piCommand[0], launchArgs, { stdio: "inherit", shell: false });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
} catch (error) {
  console.error(error instanceof SyntaxError ? "Pi configuration could not be read. Preserve it and repair the JSON before retrying." : error.message);
  process.exit(1);
}
})();
`;

/** Resolve npm/pnpm wrappers without executing a shell or assuming a package layout. */
export const PI_COMMAND_RESOLVER = String.raw`// Resolve the effective installed CLI, including Windows npm/pnpm wrapper chains.
const windows = process.platform === "win32";
const searchPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
const binaryNames = windows ? ["pi.exe", "pi.cmd", "pi.bat", "pi.ps1"] : ["pi"];
const isFile = file => fs.existsSync(file) && fs.statSync(file).isFile();
const piFile = searchPath.split(path.delimiter).map(dir => dir.replace(/^"|"$/g, "")).filter(Boolean)
  .flatMap(dir => binaryNames.map(name => path.join(dir, name))).find(isFile);
if (!piFile) throw new Error("Pi was not found on PATH. Open a terminal where pi --version works, then rerun setup.");
function packageEntry(file) {
  let directory = path.dirname(fs.realpathSync(file));
  for (;;) {
    const manifestFile = path.join(directory, "package.json");
    if (isFile(manifestFile)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8").replace(/^\uFEFF/, ""));
      if (["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(manifest.name)) {
        const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
        if (typeof bin === "string") {
          const entry = path.resolve(directory, bin);
          if (entry.startsWith(directory + path.sep) && /\.[cm]?js$/i.test(entry) && isFile(entry) && fs.realpathSync(entry).startsWith(directory + path.sep)) return entry;
        }
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
function resolvePi(file, seen = new Set()) {
  const actual = fs.realpathSync(file);
  if (seen.has(actual) || seen.size >= 8) return;
  seen.add(actual);
  if (/pi\.exe$/i.test(actual)) return [actual];
  const source = fs.readFileSync(actual, "utf8").replace(/^\uFEFF/, "");
  if (/^#![^\r\n]*\bnode\b/.test(source)) {
    const entry = packageEntry(actual);
    if (entry) return [process.execPath, entry];
    if (!windows) return [process.execPath, actual];
  }
  const directory = path.dirname(actual);
  // pi.dev's native install has a sibling launcher, not an npm package.
  // Match the complete static wrapper before granting this exception: a quoted
  // JS filename alone cannot establish which program the wrapper would run.
  const nativeWrappers = ${JSON.stringify(nativeWindowsWrappers())};
  const normalizeWrapper = text => text.replace(/\r\n/g, "\n").trim().split("\n").map(line => line.trim().toLowerCase()).join("\n");
  const nativeWrapper = nativeWrappers[path.extname(actual).toLowerCase()];
  if (windows && nativeWrapper && normalizeWrapper(source) === normalizeWrapper(nativeWrapper)) {
    const launcher = path.join(directory, "pi-launcher.js");
    if (!isFile(launcher)) return;
    const stat = fs.lstatSync(launcher);
    if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || path.dirname(fs.realpathSync(launcher)).toLowerCase() !== directory.toLowerCase()) return;
    return [process.execPath, launcher];
  }
  const targets = [
    ...Array.from(source.matchAll(/^# cmd-shim-target=(.+)$/gm), match => match[1].trim()),
    ...Array.from(source.matchAll(/["']([^"'\r\n]+\.(?:[cm]?js|cmd|bat|ps1|exe))["']/gi), match => match[1]),
  ];
  for (const target of targets) {
    const expanded = target.replace(/%~dp0|%_?dp0%|\$\{(?:basedir_win|basedir|PSScriptRoot)\}|\$(?:basedir_win|basedir|PSScriptRoot)/gi, directory + path.sep);
    if (/[%$]/.test(expanded)) continue; // Unrecognized shell expansion is never evaluated.
    const candidate = path.resolve(directory, expanded);
    if (!isFile(candidate)) continue;
    if (/\.[cm]?js$/i.test(candidate)) {
      const entry = packageEntry(candidate);
      if (entry) return [process.execPath, entry];
    } else if (!/node\.exe$/i.test(candidate)) {
      const command = resolvePi(candidate, seen);
      if (command) return command;
    }
  }
  if (!windows && /^#![^\r\n]*\b(?:ba)?sh\b/.test(source)) return [actual];
}
const piCommand = resolvePi(piFile);
if (!piCommand) throw new Error("Cannot resolve this Pi launcher safely. Share the contents of the pi.cmd or pi.ps1 found on PATH (without credentials) so its wrapper format can be supported.");
`;

// Native pi.dev installer wrappers; deliberately no general shell evaluation.
function nativeWindowsWrappers() {
  return {
    ".cmd": String.raw`@ECHO off
SETLOCAL
SET "node=node"
"%node%" "%~dp0pi-launcher.js" %*
SET "pi_exit_code=%ERRORLEVEL%"
IF "%pi_exit_code%"=="9009" (
  IF "%node%"=="node" (
    "%SystemRoot%\System32\where.exe" /Q node
    IF ERRORLEVEL 1 GOTO node_missing
  ) ELSE IF NOT EXIST "%node%" GOTO node_missing
)
EXIT /B %pi_exit_code%
:node_missing
ECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2
EXIT /B %pi_exit_code%`,
    ".ps1": `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$launcher=Join-Path $basedir "pi-launcher.js"
$node="node"
try {
  if ($MyInvocation.ExpectingInput) {
    $input | & $node $launcher $args
  } else {
    & $node $launcher $args
  }
} catch [System.Management.Automation.CommandNotFoundException] {
  [Console]::Error.WriteLine("Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev.")
  exit 127
}
exit $LASTEXITCODE`,
  };
}
