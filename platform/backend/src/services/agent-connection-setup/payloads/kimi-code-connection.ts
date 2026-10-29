import { MARKETPLACE_SKILLS_SYNC } from "./marketplace-skills-sync";

/**
 * Node.js code the Kimi Code setup and its lifecycle helper (disconnect,
 * gateway sign-in, skills refresh) share. Kimi Code
 * keeps its model providers, permission rules and skill folders in
 * `$KIMI_CODE_HOME/config.toml` and its MCP servers in `mcp.json`; it also
 * rewrites config.toml itself (`kimi login`, model changes). So the connection
 * edits only what it owns: its tables (in a marked block, and found again by
 * name if Kimi dropped the markers), `default_model`,
 * `default_permission_mode` and one
 * `extra_skill_dirs` entry. `kimi doctor` validates the result with Kimi's own
 * parser before setup finishes.
 */
export const KIMI_CODE_CONNECTION = String.raw`
const KimiCodeConnection = (() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
  const { execFileSync, spawn } = require("node:child_process");
  const BLOCK_START = "# >>> archestra kimi-code connection >>>";
  const BLOCK_END = "# <<< archestra kimi-code connection <<<";
  const AGENTS_START = "<!-- >>> archestra kimi-code connection >>> -->";
  const AGENTS_END = "<!-- <<< archestra kimi-code connection <<< -->";
  const PROVIDER = "archestra", MODEL = "archestra";
  const home = os.homedir();
  const stateRoot = path.join(home, ".archestra", "kimi-code");
  const stateFile = path.join(stateRoot, "state.json");
  // The connection's own skill checkouts. The shared ~/.archestra/skills
  // belongs to whichever deployment made it first.
  const skillsRoot = path.join(stateRoot, "skills");
  // The folder the gateway sign-in runs Kimi Code in.
  const signInRoot = path.join(stateRoot, "sign-in");
  const kimiHome =() => path.resolve(process.env.KIMI_CODE_HOME || path.join(home, ".kimi-code"));
  const tomlString = value => JSON.stringify(String(value));

  // Refuse a path that leaves the home directory or passes through a link or
  // another user's file, so setup never writes through someone else's file.
  function safe(file) {
    const root = path.resolve(home); let current = path.resolve(file);
    if (!current.startsWith(root + path.sep)) throw new Error("Kimi Code configuration must stay inside your home directory. Unset KIMI_CODE_HOME or point it inside your home directory.");
    while (current !== root) {
      let stat; try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (stat && (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))) throw new Error("Refusing a linked or unowned Kimi Code configuration file: " + current);
      current = path.dirname(current);
    }
  }
  function read(file) { safe(file); return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null; }
  function write(file, text, mode = 0o600) {
    safe(file); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (text === null) { fs.rmSync(file, { force: true }); return; }
    const temp = file + ".archestra-" + crypto.randomUUID();
    try { fs.writeFileSync(temp, text, { flag: "wx", mode }); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  function backup(file) {
    const original = read(file), copy = file + ".archestra-backup";
    if (original !== null && read(copy) === null) write(copy, original);
  }

  // Line layout of a TOML file: table headers and top-level keys, found
  // outside strings and multi-line values.
  function layout(text) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.length > 0 ? text.split(/\r?\n/) : [];
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const headers = [], keys = [];
    let multi = null, depth = 0, current = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (multi === null && depth === 0) {
        const header = /^\s*(\[\[?)\s*([^\]#]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
        if (header) { headers.push({ index, name: keyPath(header[2]), array: header[1] === "[[" }); continue; }
        const key = /^\s*([A-Za-z0-9_-]+|"[^"]*"|'[^']*')\s*=/.exec(line);
        if (key && headers.length === 0) current = { key: unquote(key[1]), start: index, end: index };
      }
      ({ multi, depth } = scan(line, multi, depth));
      if (current) { current.end = index; if (multi === null && depth === 0) { keys.push(current); current = null; } }
    }
    if (current) keys.push(current);
    return { eol, lines, headers, keys };
  }
  function scan(line, multi, depth) {
    let i = 0;
    while (i < line.length) {
      if (multi) { const end = line.indexOf(multi, i); if (end === -1) return { multi, depth }; i = end + 3; multi = null; continue; }
      const ch = line[i];
      if (ch === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) { multi = line.slice(i, i + 3); i += 3; continue; }
      if (ch === '"') { i++; while (i < line.length && line[i] !== '"') { if (line[i] === "\\") i++; i++; } i++; continue; }
      if (ch === "'") { const end = line.indexOf("'", i + 1); i = end === -1 ? line.length : end + 1; continue; }
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      i++;
    }
    return { multi, depth };
  }
  function unquote(part) {
    if (part.startsWith('"')) return JSON.parse(part);
    if (part.startsWith("'")) return part.slice(1, -1);
    return part;
  }
  function keyPath(name) { return (name.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.\s]+/g) || []).map(unquote).join("."); }
  const join = (lines, eol) => lines.length > 0 ? lines.join(eol) + eol : "";

  // The tables this connection owns: its provider and model, and the gateway
  // permission rules it added.
  function ownedSection(header, body, patterns) {
    if (!header.array) return header.name === "providers." + PROVIDER || header.name.startsWith("providers." + PROVIDER + ".") || header.name === "models." + MODEL;
    if (header.name !== "permission.rules") return false;
    const pattern = body.map(line => /^\s*pattern\s*=\s*("(?:[^"\\]|\\.)*")\s*(#.*)?$/.exec(line)).find(Boolean);
    return !!pattern && patterns.includes(JSON.parse(pattern[1]));
  }
  function withoutOwnedTables(text, patterns) {
    let { eol, lines } = layout(text);
    const start = lines.indexOf(BLOCK_START), end = lines.indexOf(BLOCK_END);
    if (start !== -1 || end !== -1) {
      if (start === -1 || end < start) throw new Error("config.toml has an incomplete Kimi Code connection block. Restore config.toml from config.toml.archestra-backup, then rerun setup.");
      lines.splice(start, end - start + 1);
    }
    const parsed = layout(join(lines, eol));
    lines = parsed.lines;
    const remove = new Set();
    parsed.headers.forEach((header, i) => {
      const stop = i + 1 < parsed.headers.length ? parsed.headers[i + 1].index : lines.length;
      if (ownedSection(header, lines.slice(header.index + 1, stop), patterns)) for (let j = header.index; j < stop; j++) remove.add(j);
    });
    lines = lines.filter((_, i) => !remove.has(i));
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return join(lines, eol);
  }
  // Kimi Code's own sign-in (kimi login) as a reference another provider can
  // share: Kimi Code keeps one token per key and refreshes it for both.
  function loginOAuth(text) {
    const { lines, headers } = layout(text);
    const at = headers.findIndex(header => !header.array && header.name === "providers.managed:kimi-code.oauth");
    if (at === -1) return null;
    const stop = at + 1 < headers.length ? headers[at + 1].index : lines.length;
    const ref = {};
    for (const line of lines.slice(headers[at].index + 1, stop)) {
      const entry = /^\s*(storage|key|oauth_host)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(#.*)?$/.exec(line);
      if (entry) ref[entry[1]] = unquote(entry[2]);
    }
    return ref.storage && ref.key ? ref : null;
  }
  function foreignTables(text) {
    return layout(text).headers.filter(header => !header.array && (header.name === "providers." + PROVIDER || header.name === "models." + MODEL)).map(header => "[" + header.name + "]");
  }
  // Sets a single-line top-level key, or removes it when value is null.
  // Returns the line it replaced, or null when the key was absent.
  function setTopLevel(text, key, value) {
    const { eol, lines, headers, keys } = layout(text);
    const span = keys.find(entry => entry.key === key);
    const line = value === null ? [] : [key + " = " + value];
    if (span) {
      if (span.end !== span.start) throw new Error("config.toml sets " + key + " over several lines. Put it on one line, then rerun setup.");
      const previous = lines[span.start];
      lines.splice(span.start, 1, ...line);
      return { text: join(lines, eol), previous };
    }
    if (value === null) return { text, previous: null };
    const at = keys.length > 0 ? keys[keys.length - 1].end + 1 : 0;
    lines.splice(at, 0, ...line, ...(at === 0 && headers.length > 0 ? [""] : []));
    return { text: join(lines, eol), previous: null };
  }
  function topLevelLine(text, key) {
    const { lines, keys } = layout(text);
    const span = keys.find(entry => entry.key === key);
    return span && span.start === span.end ? lines[span.start] : null;
  }
  // The folders of a one-line extra_skill_dirs array, or null when it is
  // written in a way this helper does not edit.
  function skillDirs(line) {
    if (line === null) return [];
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/\s+#.*$/, "");
    if (!value.startsWith("[") || !value.endsWith("]")) return null;
    const dirs = []; let rest = value.slice(1, -1).trim();
    while (rest.length > 0) {
      const match = /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(,\s*)?/.exec(rest);
      if (!match) return null;
      dirs.push(unquote(match[1])); rest = rest.slice(match[0].length);
    }
    return dirs;
  }
  function withSkillDir(text, dir, add) {
    const line = topLevelLine(text, "extra_skill_dirs");
    const dirs = skillDirs(line);
    if (dirs === null) return null;
    const next = add ? [...new Set([...dirs, dir])] : dirs.filter(entry => entry !== dir);
    if (next.length === dirs.length && next.every((entry, i) => entry === dirs[i])) return { text, created: false };
    const value = next.length > 0 ? "[" + next.map(tomlString).join(", ") + "]" : null;
    return { text: setTopLevel(text, "extra_skill_dirs", value).text, created: line === null };
  }
  // Replaces this connection's block in AGENTS.md, or removes it when body is
  // empty. The person's own instructions around it stay as they are.
  function withAgentsBlock(text, body) {
    let current = text ?? "";
    const start = current.indexOf(AGENTS_START);
    const end = start === -1 ? -1 : current.indexOf(AGENTS_END, start);
    if (start !== -1 && end !== -1) {
      const before = current.slice(0, start).replace(/\s+$/, "");
      const after = current.slice(end + AGENTS_END.length).replace(/^\s+/, "");
      current = before && after ? before + "\n\n" + after : before + after;
    }
    current = current.replace(/\s+$/, "");
    if (body) current = (current ? current + "\n\n" : "") + AGENTS_START + "\n" + body.trim() + "\n" + AGENTS_END;
    return current ? current + "\n" : null;
  }

  // The exact name Kimi Code gives a gateway tool (agent-core
  // mcpCore/tool-naming.ts): each name part keeps letters, digits, "_" and
  // "-", with runs of "_" cut to one; a name over 64 characters is cut and
  // ends with a hash.
  function qualifiedToolName(server, tool) {
    const part = value => value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
    const full = "mcp__" + part(server) + "__" + part(tool);
    if (full.length <= 64) return full;
    let hash = 2166136261;
    for (let i = 0; i < full.length; i++) { hash ^= full.codePointAt(i); hash = Math.trunc(Math.imul(hash, 16777619)); }
    const suffix = hash.toString(16).padStart(8, "0");
    return full.slice(0, 64 - suffix.length - 1) + "_" + suffix;
  }

  // Kimi Code reads its own thinking support only for its built-in catalog. K3
  // and Kimi for Coding models think; K3.1 Pro refuses a request without it.
  function capabilities(model) {
    const name = model.toLowerCase(), out = ["tool_use"];
    if (/^(kimi-)?(k3|for-coding)/.test(name) || name.includes("thinking")) out.push("thinking");
    if (/^(kimi-)?k3\.1/.test(name)) out.push("always_thinking");
    return out;
  }

  // The kimi on PATH. Kimi Code's install script puts a native build there,
  // which runs as is. Its npm package declares dist/main.mjs as the kimi
  // command on every platform, so that runs with this Node.js; on Windows its
  // .cmd and .ps1 shims cannot run without a shell.
  function command() {
    const searchPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
    const names = process.platform === "win32" ? ["kimi.exe", "kimi.cmd", "kimi.ps1", "kimi"] : ["kimi"];
    const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
    for (const dir of searchPath.split(path.delimiter).map(entry => entry.replace(/^"|"$/g, "")).filter(Boolean)) {
      for (const name of names) {
        const file = path.join(dir, name);
        if (!isFile(file)) continue;
        for (const root of [path.dirname(fs.realpathSync(file)), path.join(dir, "node_modules", "@moonshot-ai", "kimi-code"), path.join(dir, "..", "lib", "node_modules", "@moonshot-ai", "kimi-code")]) {
          let directory = root;
          for (let up = 0; up < 4; up++) {
            const manifest = path.join(directory, "package.json");
            if (isFile(manifest)) {
              const pkg = JSON.parse(fs.readFileSync(manifest, "utf8").replace(/^﻿/, ""));
              const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.kimi;
              const entry = typeof bin === "string" ? path.resolve(directory, bin) : null;
              if (pkg.name === "@moonshot-ai/kimi-code" && entry && entry.startsWith(directory + path.sep) && isFile(entry)) return { argv: [process.execPath, entry], version: String(pkg.version || ""), npm: true };
            }
            directory = path.dirname(directory);
          }
        }
        if (process.platform !== "win32" || name === "kimi.exe") return { argv: [file], version: null, npm: false };
      }
    }
    const install = process.platform === "win32" ? "irm https://code.kimi.com/kimi-code/install.ps1 | iex" : "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash";
    throw new Error("Kimi Code was not found on PATH. Install it with " + install + ", open a new terminal where kimi --version works, then rerun setup.");
  }
  function run(kimi, args) {
    return execFileSync(kimi.argv[0], [...kimi.argv.slice(1), ...args], { encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 60000, env: { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CLI_NO_AUTO_UPDATE: "1" } });
  }

  function readState() { const text = read(stateFile); return text === null ? null : JSON.parse(text); }
  function writeState(state) { write(stateFile, JSON.stringify(state, null, 2) + "\n"); }
  function lock() {
    safe(stateRoot); fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(path.join(stateRoot, "lock"), { mode: 0o700 }); }
    catch { throw new Error("Another Kimi Code setup or disconnect is running. Wait for it to finish, then retry. If none is running, remove ~/.archestra/kimi-code/lock."); }
  }
  function unlock() { fs.rmSync(path.join(stateRoot, "lock"), { recursive: true, force: true }); }

  // Keeps only the named marketplace's checkout, and only when this origin
  // made it, so a connection to another deployment makes its own.
  function pruneSkills(name, origin) {
    safe(skillsRoot);
    let entries;
    try { entries = fs.readdirSync(skillsRoot); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(skillsRoot, entry, ".git", "archestra-skills.json"), "utf8")); } catch {}
      if (entry !== name || owner?.origin !== origin) fs.rmSync(path.join(skillsRoot, entry), { recursive: true, force: true, maxRetries: 3 });
    }
  }
  function removeSkills() { safe(skillsRoot); fs.rmSync(skillsRoot, { recursive: true, force: true, maxRetries: 3 }); }

  // Removes everything the recorded connection added. Each step only touches
  // what is still the connection's own, so a file Kimi or the person changed
  // keeps their changes.
  function removeConnection(state, files) {
    let config = files.config;
    if (config !== null) {
      config = withoutOwnedTables(config, state.rulePatterns || []);
      const current = topLevelLine(config, "default_model");
      if (current !== null && /^\s*default_model\s*=\s*("archestra"|'archestra')\s*(#.*)?$/.test(current)) {
        const previous = state.previousDefaultModel;
        config = setTopLevel(config, "default_model", previous ? previous.slice(previous.indexOf("=") + 1).trim() : null).text;
      }
      // Only a connection that set the mode restores it, and only while the
      // mode is still the one it set.
      if (Object.hasOwn(state, "previousPermissionMode") && /^\s*default_permission_mode\s*=\s*("yolo"|'yolo')\s*(#.*)?$/.test(topLevelLine(config, "default_permission_mode") ?? "")) {
        const previous = state.previousPermissionMode;
        config = setTopLevel(config, "default_permission_mode", previous ? previous.slice(previous.indexOf("=") + 1).trim() : null).text;
      }
      if (state.skillDir) config = withSkillDir(config, state.skillDir, false)?.text ?? config;
      if (config.trim() === "") config = null;
    }
    let mcp = files.mcp;
    if (mcp !== null) {
      const parsed = JSON.parse(mcp);
      const entry = parsed?.mcpServers?.[state.server];
      if (entry && entry.url === state.gateway) {
        delete parsed.mcpServers[state.server];
        const empty = Object.keys(parsed).length === 1 && Object.keys(parsed.mcpServers).length === 0;
        mcp = empty ? null : JSON.stringify(parsed, null, 2) + "\n";
      }
    }
    return { config, mcp, agents: files.agents === null ? null : withAgentsBlock(files.agents, null) };
  }
  function filesOf(root) {
    return { config: path.join(root, "config.toml"), mcp: path.join(root, "mcp.json"), agents: path.join(root, "AGENTS.md") };
  }
  function readFiles(paths) { return { config: read(paths.config), mcp: read(paths.mcp), agents: read(paths.agents) }; }
  function writeFiles(paths, next, before) {
    for (const key of ["config", "mcp", "agents"]) if (next[key] !== before[key]) write(paths[key], next[key]);
  }

  // The helper as the person types it: Windows PowerShell does not expand ~.
  function helperCommand(action) {
    return process.platform === "win32" ? 'node "$HOME\\.archestra\\kimi-code\\lifecycle.cjs" ' + action : "node ~/.archestra/kimi-code/lifecycle.cjs " + action;
  }
  function openUrl(url) {
    const [file, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try { const child = spawn(file, args, { detached: true, stdio: "ignore" }); child.on("error", () => {}); child.unref(); } catch {}
  }

  // Kimi Code keeps each MCP server's sign-in as <name>-tokens.json next to a
  // <name>-meta.json that names the server URL. The gateway's tokens file, or
  // null when Kimi Code has none.
  function gatewayTokens(state) {
    const dir = path.join(state.kimiHome, "credentials", "mcp");
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) {
      if (!name.endsWith("-meta.json")) continue;
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch {}
      if (meta?.serverUrl !== state.gateway) continue;
      const tokens = path.join(dir, name.slice(0, -"-meta.json".length) + "-tokens.json");
      if (fs.existsSync(tokens)) return tokens;
    }
    return null;
  }

  // Kimi Code signs in to an MCP server only through the server's
  // authenticate tool, so a one-prompt run asks it to call that tool. The tool
  // prints the authorization URL and waits for the browser; this opens the URL
  // when it names the connection's gateway. Like claude mcp login, it signs in
  // again when Kimi Code is signed in already: Kimi Code offers the tool only
  // without saved tokens, so they wait aside and come back if the sign-in does
  // not finish. The run has its own folder, so kimi -c in a project never
  // continues it. During the setup window its prompt carries the setup
  // reference, so the proxy lets this one conversation finish the setup
  // without Guardrails.
  function signIn() {
    const state = readState();
    if (!state?.server) throw new Error("Kimi Code has no gateway connection. Rerun connection setup.");
    const kimi = command();
    const prompt = "Sign in to the " + state.server + " MCP server: call its authenticate tool once and wait for it to finish. Do nothing else." + (state.setupReference ? " Setup reference: " + state.setupReference : "");
    safe(signInRoot);
    fs.mkdirSync(signInRoot, { recursive: true, mode: 0o700 });
    const earlier = gatewayTokens(state);
    const aside = earlier ? earlier + ".archestra-sign-in" : null;
    if (earlier) { safe(earlier); fs.renameSync(earlier, aside); }
    console.log("Starting Kimi Code to sign in to the " + state.server + " MCP gateway...");
    return new Promise((resolve) => {
      const child = spawn(kimi.argv[0], [...kimi.argv.slice(1), "-p", prompt], { cwd: signInRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CLI_NO_AUTO_UPDATE: "1" } });
      // Ctrl+C reaches Kimi Code too; this waits for it to exit, then puts
      // the earlier sign-in back.
      const keepRunning = () => {};
      process.on("SIGINT", keepRunning);
      let opened = false, finished = false, answer = "", errors = "";
      const gatewayUrl = line => {
        const url = /^\s*(https?:\/\/\S+)\s*$/.exec(line)?.[1];
        let parsed = null;
        try { parsed = url ? new URL(url) : null; } catch {}
        return parsed?.searchParams.get("resource") === state.gateway ? url : null;
      };
      const watch = (stream, onLine) => {
        let pending = "";
        stream.on("data", chunk => {
          pending += chunk.toString("utf8");
          const lines = pending.split(/\r?\n/);
          pending = lines.pop();
          lines.forEach(onLine);
        });
        stream.on("end", () => { if (pending) onLine(pending); });
      };
      const progress = line => {
        const url = gatewayUrl(line);
        if (url && !opened) {
          opened = true;
          openUrl(url);
          console.log("Opened the sign-in page in your browser. If it did not open, go to:\n\n  " + url + "\n\nWaiting for you to approve it...");
          return true;
        }
        return url !== null;
      };
      // Kimi Code prints the model's thinking and the tool progress on stderr
      // and the model's answer on stdout. The person sees this helper's own
      // progress; the answer and Kimi Code's errors show only on failure.
      watch(child.stderr, line => {
        if (progress(line)) return;
        if (/^(\s|•|kimi version |To resume this session: |Discovering OAuth|Open this URL|Waiting for the OAuth|Authorized)/.test(line) || line.trim() === "") return;
        errors += line + "\n";
      });
      watch(child.stdout, line => { if (!progress(line) && !/^To resume this session: /.test(line)) answer += line + "\n"; });
      const finish = () => {
        if (finished) return;
        finished = true;
        process.removeListener("SIGINT", keepRunning);
        if (gatewayTokens(state)) {
          if (aside) fs.rmSync(aside, { force: true });
          return resolve(0);
        }
        if (aside) try { fs.renameSync(aside, earlier); } catch {}
        if (answer.trim()) process.stdout.write(answer);
        if (errors.trim()) process.stderr.write(errors);
        console.error("Kimi Code did not sign in to the " + state.server + " MCP gateway." + (aside ? " Its earlier sign-in is kept." : ""));
        resolve(1);
      };
      child.on("error", error => { errors += error.message + "\n"; finish(); });
      child.on("close", finish);
    });
  }

  // Updates the connection's skills checkout from the marketplace it was set
  // up with; the launch check runs this at most once a day.
  function refreshSkills() {
    const state = readState();
    if (!state?.skills) return;
    syncMarketplaceSkills({ source: state.skills, root: skillsRoot });
  }

  function disconnect() {
    lock();
    try {
      const state = readState();
      if (!state) { console.log("Kimi Code is not connected."); return; }
      const paths = filesOf(state.kimiHome);
      const before = readFiles(paths);
      writeFiles(paths, removeConnection(state, before), before);
      write(stateFile, null);
      // A running Kimi Code can hold a skill file open on Windows.
      try { removeSkills(); } catch { console.warn("Could not remove " + skillsRoot + ". Close Kimi Code, then delete it."); }
      try { fs.rmSync(signInRoot, { recursive: true, force: true }); } catch {}
      // This helper is loaded already, so it can remove itself.
      write(path.join(stateRoot, "lifecycle.cjs"), null);
      console.log("Kimi Code is disconnected. Your other providers, MCP servers and skills were kept. Gateway sign-ins stay in Kimi Code until you remove them with /mcp-config.");
    } finally {
      unlock();
      try { fs.rmdirSync(stateRoot); } catch {}
    }
  }

  return { BLOCK_START, BLOCK_END, PROVIDER, MODEL, safe, read, write, backup, layout, withoutOwnedTables, foreignTables, loginOAuth, setTopLevel, topLevelLine, withSkillDir, withAgentsBlock, qualifiedToolName, capabilities, command, run, readState, writeState, lock, unlock, pruneSkills, removeSkills, removeConnection, filesOf, readFiles, writeFiles, helperCommand, signIn, refreshSkills, disconnect, kimiHome, stateRoot, stateFile, skillsRoot, tomlString };
})();
`;

/** The disconnect helper setup installs as ~/.archestra/kimi-code/lifecycle.cjs. */
export const KIMI_CODE_LIFECYCLE = `#!/usr/bin/env node
// Managed Kimi Code connection: run "node lifecycle.cjs disconnect" to remove it.
"use strict";
${KIMI_CODE_CONNECTION}
${MARKETPLACE_SKILLS_SYNC}
const action = process.argv[2];
(async () => {
  if (action === "disconnect") KimiCodeConnection.disconnect();
  else if (action === "sign-in") process.exitCode = await KimiCodeConnection.signIn();
  else if (action === "refresh-skills") KimiCodeConnection.refreshSkills();
  else { console.error("Usage: node lifecycle.cjs disconnect | sign-in | refresh-skills"); process.exitCode = 2; }
})().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;
