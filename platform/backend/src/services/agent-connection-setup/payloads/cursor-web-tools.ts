/**
 * Cursor's own Web Search and Web Fetch tools call no hook, so Guardrails
 * cannot check them and setup switches them off. This Node script takes their
 * place: a local MCP server whose two tools Cursor does run its hooks for.
 *
 * Each call starts one headless Cursor CLI process that makes the same native
 * web call on the person's Cursor plan, with no other vendor involved. The
 * script reads that call's raw result from the CLI's output, checks that it
 * answers the request it was given, and stops the process.
 *
 * Cursor's native fetch runs on Cursor's servers, which cannot reach
 * `localhost` or a private network. A page there is fetched by this script
 * from the person's computer, and so is a page whose native fetch failed.
 * That covers a self-hosted Archestra's own pages, which the connection
 * prompt has the agent read.
 *
 * The CLI process is kept lean and confined:
 * - It runs with a home folder of its own, which holds only the Guardrails
 *   hook. The CLI reads hooks and MCP servers from the home folder, so the
 *   process starts none of the person's MCP servers, runs none of their other
 *   hooks, and leaves no chat in their CLI history. Its sign-in is kept
 *   outside that folder on Windows and Linux. On macOS the sign-in lives in
 *   the home folder itself, so there the process keeps the person's home and
 *   only its settings and chats go to the folder of its own.
 * - Its working folder has a permission file that denies shell, file and MCP
 *   tools. A headless web call needs the CLI's force flag, and the deny list
 *   is what holds under it.
 * - Its prompt names the one call to make, so the model takes one step, and
 *   the process is stopped as soon as the result arrives.
 *
 * Guardrails hand the call an id in its arguments once they allow it. The
 * script passes that id to the CLI process, whose hook reports with it, so
 * what the process does is checked as a subagent's step of the calling chat.
 */
export const CURSOR_WEB_TOOLS_FILENAME = "web-tools.mjs";
/** The folder under the temp folder where the web tools' CLI process keeps its data. */
export const CURSOR_WEB_CLI_DATA_DIRNAME = "archestra-cursor-web-cli";

/** The folder, next to the script, that holds the CLI process's folders. */
export const CURSOR_WEB_CLI_DIRNAME = "web-cli";

export const CURSOR_WEB_SEARCH_TOOL = "cursor_web_search";
export const CURSOR_WEB_FETCH_TOOL = "cursor_web_fetch";
/** Installs and signs in the CLI the other two run through (see the helper below). */
export const CURSOR_WEB_SETUP_TOOL = "cursor_web_setup";
export const CURSOR_WEB_SIGN_IN_FILENAME = "web-sign-in.cjs";

/** The argument Guardrails add to an allowed call: the id of that call. */
export const CURSOR_WEB_CALL_ARGUMENT = "guardrails_call";

/** How the id reaches the hook of the CLI process the call starts. */
export const CURSOR_WEB_CALL_ENV = "ARCHESTRA_GUARDRAILS_PARENT_CALL";
export const CURSOR_WEB_CALL_HEADER = "x-archestra-guardrails-parent-call";

/** What the CLI process may not do, whatever a web page tells its model. */
export const CURSOR_WEB_CLI_PERMISSIONS = {
  permissions: {
    allow: [],
    deny: ["Shell(*)", "Write(**)", "Read(**)", "Mcp(*:*)"],
  },
} as const;

export const CURSOR_WEB_TOOLS = `// Checked web search and fetch tools for Cursor. Setup writes this file; run setup again to update it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SETUP = ${JSON.stringify(CURSOR_WEB_SETUP_TOOL)};
const SEARCH = ${JSON.stringify(CURSOR_WEB_SEARCH_TOOL)};
const FETCH = ${JSON.stringify(CURSOR_WEB_FETCH_TOOL)};
const CALL_ARGUMENT = ${JSON.stringify(CURSOR_WEB_CALL_ARGUMENT)};
const CALL_ENV = ${JSON.stringify(CURSOR_WEB_CALL_ENV)};
const PERMISSIONS = ${JSON.stringify(JSON.stringify(CURSOR_WEB_CLI_PERMISSIONS, null, 2))};
// Cursor hands a hook a tool's result only while it is small. A larger one
// goes into a file the model then reads, and the hook is given an empty
// result: Guardrails would check nothing. So a result stays under that size
// (40000 bytes when this was written), and a longer page is read in parts.
// The size counts as the result travels: as a JSON string, in which a quote,
// a backslash and a line break each take two bytes.
const MAX_RESULT_BYTES = 36000;
// Room, inside that size, for the line that says where a part sits.
const NOTICE_BYTES = 400;
// A page read in parts is fetched once; the parts after the first come from
// here. A few pages are kept, the least recently fetched going first.
const PAGE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_KEPT_PAGES = 8;
const pages = new Map();
const CALL_TIMEOUT_MS = 120000;
// How long one call of the setup tool waits for a step. Tests shorten it.
const SETUP_WAIT_MS = Number(process.env.ARCHESTRA_CURSOR_WEB_SETUP_WAIT_MS) || 20000;
const USE_BROWSER = " Until that is fixed, read the web with Cursor's browser tool.";
const RUN_SETUP = " Call the " + SETUP + " tool now: it installs the agent and signs it in, and says what the user has to approve.";

const here = path.dirname(fileURLToPath(import.meta.url));
const childHome = path.join(here, ${JSON.stringify(CURSOR_WEB_CLI_DIRNAME)}, "home");
const childConfig = path.join(childHome, ".cursor");
const childWorkspace = path.join(here, ${JSON.stringify(CURSOR_WEB_CLI_DIRNAME)}, "workspace");
// The CLI keeps its sign-in in the home folder only on macOS.
const ownHome = process.platform === "win32" || process.platform === "linux";

// The CLI saves each web result into a file of its own and reports the save
// to the hook as a write. Those files go to the temp folder: a write under
// ~/.cursor/archestra is one a person must approve.
const childData = path.join(os.tmpdir(), ${JSON.stringify(CURSOR_WEB_CLI_DATA_DIRNAME)});

/** The environment that gives the CLI process its own home and keeps its sign-in. */
function childEnvironment() {
  const own = { CURSOR_CONFIG_DIR: childConfig, CURSOR_DATA_DIR: childData };
  if (!ownHome) return own;
  if (process.platform === "win32") return { ...own, USERPROFILE: childHome, HOME: childHome };
  return {
    ...own,
    HOME: childHome,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  };
}

const TOOLS = [
  {
    name: SETUP,
    description:
      "Gets web search and fetch ready: installs Cursor's command-line agent if it is missing and signs it in if it is signed out. Call it when a web tool says the agent is missing or signed out, or to check. One call waits about twenty seconds for a step to finish. Tell the user what it asks of them, such as approving a browser page, and call it again until it says ready or failed: that can take the user a minute or two.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: SEARCH,
    description:
      "Search the web. Returns the top results with their links and a short synthesis. Use it for anything that needs current information. Runs Cursor's own web search, checked by Guardrails.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for. Be specific; include versions or dates when they matter." } },
      required: ["query"],
    },
  },
  {
    name: FETCH,
    description:
      "Fetch a web page by its URL, including one on localhost or the user's own network. Returns the page as text; a long page comes in parts, and each part says how to get the next. Runs Cursor's own web fetch, or fetches from this computer when Cursor's servers cannot reach the page. Checked by Guardrails.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page's full http or https URL." },
        offset: { type: "integer", minimum: 0, description: "Where to start reading a long page: the character position a previous result named. Leave out for the start." },
      },
      required: ["url"],
    },
  },
];

/** One native call, named exactly, so the CLI's model takes a single step. */
function childPrompt(kind, value) {
  const call =
    kind === "search"
      ? 'call the tool WebSearch on the server "cursor" with arguments ' + JSON.stringify({ search_term: value }) + ". You already know its schema (one required string argument, search_term)"
      : 'call the tool WebFetch on the server "cursor" with arguments ' + JSON.stringify({ url: value }) + ". You already know its schema (one required string argument, url)";
  return "Make exactly one tool call now and nothing else: " + call + ", so do not look it up. Do not call any other tool. Do not write any text.";
}

/** Cursor's CLI, started without a shell so no argument is ever parsed as one. */
function findCli() {
  // An install somewhere else is named here: an executable, not a script a shell has to start.
  const named = process.env.ARCHESTRA_CURSOR_CLI;
  if (named) return existsSync(named) ? { command: named, args: [], env: {} } : null;
  if (process.platform !== "win32") {
    const candidates = [
      path.join(os.homedir(), ".local", "bin", "cursor-agent"),
      ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "cursor-agent")),
      "/usr/local/bin/cursor-agent",
      "/opt/homebrew/bin/cursor-agent",
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    return found ? { command: found, args: [], env: {} } : null;
  }
  // The Windows launcher is a script only a shell can start. It runs the
  // newest installed version's own Node.js, which is what is started here.
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const versions = path.join(local, "cursor-agent", "versions");
  let names = [];
  try {
    names = readdirSync(versions);
  } catch {
    return null;
  }
  const rank = (name) => Number(name.split("-")[0].split(".").map((part) => part.padStart(2, "0")).join(""));
  const newest = names
    .filter((name) => /^[0-9]{4}[.][0-9]{1,2}[.][0-9]{1,2}-/.test(name))
    .filter((name) => existsSync(path.join(versions, name, "node.exe")) && existsSync(path.join(versions, name, "index.js")))
    .sort((a, b) => rank(b) - rank(a))[0];
  if (!newest) return null;
  return {
    command: path.join(versions, newest, "node.exe"),
    args: [path.join(versions, newest, "index.js")],
    env: {
      CURSOR_INVOKED_AS: "cursor-agent.cmd",
      NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE || path.join(local, "cursor-compile-cache"),
    },
  };
}

/** The CLI process's folders. Without its deny list or its hook it does not run. */
function prepareChild() {
  if (ownHome && !existsSync(path.join(childConfig, "hooks.json")))
    return "its Guardrails hook is missing; run the setup for Cursor again";
  try {
    const file = path.join(childWorkspace, ".cursor", "cli.json");
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {}
    if (current !== PERMISSIONS) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, PERMISSIONS);
    }
  } catch {
    return "its permission file could not be written";
  }
  return null;
}

/** A host only this computer or its network can reach, never Cursor's servers. */
function localHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\\[|\\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".") && !host.includes(":")) return true;
  if (/[.](local|internal|lan|home[.]arpa)$/.test(host)) return true;
  if (/^(127|10)[.]/.test(host) || /^192[.]168[.]/.test(host) || /^169[.]254[.]/.test(host) || /^172[.](1[6-9]|2[0-9]|3[01])[.]/.test(host)) return true;
  return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
}

const MAX_PAGE_CHARS = 2000000;
// Four bytes are the longest one character takes.
const MAX_PAGE_BYTES = MAX_PAGE_CHARS * 4;

/** The start of a response's body, read no further than a page may be long. */
async function bodyStart(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= MAX_PAGE_BYTES || text.length >= MAX_PAGE_CHARS) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return (text + decoder.decode()).slice(0, MAX_PAGE_CHARS);
}

/** A page as readable text: markup, scripts and styles left out. */
function readable(body, type) {
  if (!/html/i.test(type) && !/^\\s*<(!doctype|html)/i.test(body)) return body;
  return body
    .replace(/<(script|style|noscript)\\b[\\s\\S]*?<\\/\\1>/gi, " ")
    .replace(/<\\/(p|div|section|article|h[1-6]|li|tr|pre|blockquote)>|<br\\s*\\/?>/gi, "\\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(x27|39);/g, "'")
    .replace(/[ \\t]+/g, " ")
    .replace(/ ?\\n ?/g, "\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
}

/** Fetches a page from this computer. */
async function fetchHere(url) {
  let response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { accept: "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5" } });
  } catch (error) {
    throw new Error("the web fetch failed: " + (error?.name === "TimeoutError" ? "the page did not answer within 20 seconds" : "this computer could not reach the page (" + (error?.cause?.code ?? error?.message ?? "connection failed") + ")"));
  }
  if (!response.ok) throw new Error("the web fetch failed: HTTP " + response.status);
  let body;
  try {
    body = await bodyStart(response);
  } catch (error) {
    throw new Error("the web fetch failed: " + (error?.name === "TimeoutError" ? "the page did not finish within 20 seconds" : "the page's content could not be read"));
  }
  return readable(body, response.headers.get("content-type") ?? "");
}

const sameUrl = (a, b) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
};

// Each run leaves a chat and its saved results behind; nothing reads them.
for (const leftover of [path.join(childConfig, "chats"), path.join(childConfig, "projects"), childData]) {
  try {
    rmSync(leftover, { recursive: true, force: true });
  } catch {}
}

const running = new Set();
function stop(child) {
  running.delete(child);
  try {
    // The launcher on macOS and Linux is a script: its group is what runs the model.
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill();
  } catch {}
}

/** One headless CLI run on one model. Resolves to { text }, { error } or { tryNextModel, error }. */
function runOnce(params) {
  const { cli, kind, value, model, parentCall } = params;
  const key = kind === "search" ? "webSearchToolCall" : "webFetchToolCall";
  return new Promise((resolve) => {
    const child = spawn(
      cli.command,
      [...cli.args, "-p", "--force", "--trust", ...(model ? ["--model", model] : []), "--output-format", "stream-json", childPrompt(kind, value)],
      {
        cwd: childWorkspace,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...cli.env, ...childEnvironment(), [CALL_ENV]: parentCall },
      },
    );
    running.add(child);
    let settled = false;
    let noise = "";
    let startedArgs;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop(child);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ error: "Cursor's command-line agent gave no result within " + CALL_TIMEOUT_MS / 1000 + " seconds" }), CALL_TIMEOUT_MS);
    const note = (text) => {
      noise = (noise + " " + String(text)).slice(-600);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return note(line);
      }
      if (!event || event.type !== "tool_call" || !event.tool_call) return;
      const call = event.tool_call[key];
      if (!call) {
        // A look at a tool's schema is harmless; anything else is not the call asked for.
        const other = Object.keys(event.tool_call).find((name) => name.endsWith("ToolCall"));
        if (other && other !== "getMcpToolsToolCall")
          finish({ error: "Cursor's command-line agent tried another tool (" + other + ") and was stopped" });
        return;
      }
      // A failed native call reports its result without its arguments.
      if (event.subtype !== "completed") {
        startedArgs = call.args ?? startedArgs;
        return;
      }
      const args = call.args ?? startedArgs;
      const asked = kind === "search" ? args?.searchTerm === value : sameUrl(String(args?.url ?? ""), value);
      if (!asked) return finish({ error: "Cursor's command-line agent ran a different request than the one asked for, so its result was dropped" });
      const result = call.result ?? {};
      if (result.success) {
        const text =
          kind === "search"
            ? (result.success.references ?? []).map((item) => [item.title, item.url, item.chunk].filter(Boolean).join("\\n")).join("\\n\\n")
            : String(result.success.markdown ?? "");
        return finish({ text });
      }
      const reason = result.error?.error ?? result.rejected?.reason ?? JSON.stringify(result).slice(0, 300);
      finish({ error: "the web " + (kind === "search" ? "search" : "fetch") + " failed: " + reason, nativeFailed: Boolean(result.error) });
    });
    child.stderr.on("data", note);
    child.on("error", (error) => finish({ error: "Cursor's command-line agent could not start (" + (error?.code ?? error?.message ?? "unknown") + ")" }));
    child.on("close", () => {
      const said = noise.replace(/\\s+/g, " ").trim();
      if (/authentication required|not logged in|cursor-agent login|agent login/i.test(said))
        return finish({ unavailable: true, error: "Cursor's command-line agent is not signed in." + RUN_SETUP });
      if (/not included in|not available|unknown model|invalid model|cannot use this model|model .* not found/i.test(said))
        return finish({ unavailable: true, tryNextModel: true, error: "Cursor did not run the model this tool uses (" + (model || "its default") + "): " + said.slice(0, 300) });
      finish({ error: "Cursor's command-line agent stopped without a result" + (said ? ": " + said.slice(0, 300) : "") });
    });
  });
}

// The models to try, in order. Auto is on every Cursor plan this was tried
// with; the server's entry in mcp.json can name others in its env. A plan
// that lacks one is asked for the next, and the one that worked goes first after.
// The CLI keeps the last model it was started with as its default, so its
// default is no fallback of its own.
let models = [...new Set((process.env.ARCHESTRA_CURSOR_WEB_MODELS || "auto").split(",").map((name) => name.trim()).filter(Boolean))];
if (models.length === 0) models = ["auto"];

/** The bytes a text takes in a result on its way to Cursor. */
const wireBytes = (text) => Buffer.byteLength(JSON.stringify(text));

/** The longest start of the text that, with a notice after it, fits the size a hook still sees. */
function fitting(text) {
  const room = MAX_RESULT_BYTES - NOTICE_BYTES;
  if (wireBytes(text) <= room) return text;
  let end = Math.min(text.length, room);
  while (end > 0 && wireBytes(text.slice(0, end)) > room) end = Math.floor(end * 0.95);
  return text.slice(0, end);
}

/** One part of a page, with where it sits and how to read on. */
function part(text, offset) {
  const start = Math.min(Math.max(0, offset), text.length);
  const shown = fitting(text.slice(start));
  const end = start + shown.length;
  if (start === 0 && end === text.length) return text;
  return (
    shown +
    "\\n\\n[Characters " + start + " to " + end + " of " + text.length + "." +
    (end < text.length ? " Call this tool again with the same url and offset " + end + " to read on.]" : " This is the end of the page.]")
  );
}

async function webCall(kind, value, parentCall, offset = 0) {
  if (typeof value !== "string" || !value.trim()) throw new Error(kind === "search" ? "query must be a non-empty string" : "url must be a non-empty string");
  if (kind === "fetch") {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("url is not a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must start with http:// or https://");
  }
  const kept = kind === "fetch" && offset > 0 ? pages.get(value) : undefined;
  if (kept && Date.now() - kept.at < PAGE_LIFETIME_MS) return part(kept.text, offset);
  const keep = (text) => {
    pages.delete(value);
    for (const [url, page] of pages) if (Date.now() - page.at >= PAGE_LIFETIME_MS) pages.delete(url);
    while (pages.size >= MAX_KEPT_PAGES) pages.delete(pages.keys().next().value);
    pages.set(value, { text, at: Date.now() });
    return part(text, offset);
  };
  if (kind === "fetch" && localHost(new URL(value).hostname)) return keep(await fetchHere(value));
  const cli = findCli();
  if (!cli)
    throw new Error("Cursor's command-line agent is not installed, and it runs this tool." + RUN_SETUP + USE_BROWSER);
  const unready = prepareChild();
  if (unready) throw new Error("This tool cannot run: " + unready + "." + USE_BROWSER);
  let last = { error: "" };
  for (const model of [...models]) {
    const outcome = await runOnce({ cli, kind, value, model, parentCall });
    if (outcome.text !== undefined) {
      models = [model, ...models.filter((name) => name !== model)];
      if (kind === "fetch") return keep(outcome.text);
      const shown = fitting(outcome.text);
      return shown.length < outcome.text.length ? shown + "\\n\\n[Cut here: the results have " + (outcome.text.length - shown.length) + " more characters.]" : shown;
    }
    last = outcome;
    // Cursor's servers could not get the page: this computer may reach it.
    if (kind === "fetch" && outcome.nativeFailed) {
      try {
        return keep(await fetchHere(value));
      } catch {}
    }
    if (!outcome.tryNextModel) break;
  }
  throw new Error(
    last.error.replace(/[.]+$/, "") +
      "." +
      (last.tryNextModel ? " Name a model of the user's Cursor plan in ARCHESTRA_CURSOR_WEB_MODELS, in this server's env in ~/.cursor/mcp.json." : "") +
      (last.unavailable ? USE_BROWSER : ""),
  );
}

// The same steps the connection command runs at the end of setup.
const setup = createRequire(import.meta.url)("./" + ${JSON.stringify(CURSOR_WEB_SIGN_IN_FILENAME)});

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message ?? {};
  // A notification has no id and gets no answer.
  if (id === undefined || id === null) return;
  if (method === "initialize")
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "archestra-web-tools", version: "1" },
      },
    });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const stamped = args[CALL_ARGUMENT];
    const parentCall = typeof stamped === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(stamped) ? stamped : "";
    if (params?.name === SETUP) {
      // A step such as the sign-in waits for the person. One call waits a
      // while for it, so a chat does not give up after a few quick checks.
      const until = Date.now() + SETUP_WAIT_MS;
      let outcome;
      for (;;) {
        try {
          outcome = setup.step();
        } catch (error) {
          outcome = { failed: true, text: "The setup step could not run: " + String(error?.message ?? error) };
        }
        const left = until - Date.now();
        if (outcome.ready || outcome.failed || left <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000, left)));
      }
      const next = outcome.ready || outcome.failed ? "" : " This can take the user a minute or two. Call this tool again now, and keep calling it until it says ready or failed.";
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: outcome.text + next }], isError: outcome.failed === true } });
    }
    try {
      const text =
        params?.name === SEARCH
          ? await webCall("search", args.query, parentCall)
          : params?.name === FETCH
            ? await webCall("fetch", args.url, parentCall, Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0)
            : (() => {
                throw new Error("Unknown tool " + String(params?.name));
              })();
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (error) {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true } });
    }
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});
// Cursor closed the server: nothing it started outlives it.
input.on("close", () => {
  for (const child of [...running]) stop(child);
  setup.stop();
  process.exit(0);
});
`;

/**
 * Gets Cursor's command-line agent ready, which the web tools run through:
 * installs it with Cursor's own installer when it is missing, and signs it in
 * when it is signed out, since it signs in separately from the Cursor app.
 *
 * The connection command runs this file at the end of setup. The web tools'
 * server loads it too, for the `cursor_web_setup` tool, so an agent can finish
 * the same work from a chat. Each `step` does what is missing next and says
 * what it started; the install and the sign-in run on their own, so no call
 * waits on a download or on the person's browser.
 */
/** What setup knows that the sign-in helper cannot find on the computer. */
export interface CursorWebSignInSetup {
  appName: string;
  /** The name setup gave the gateway in ~/.cursor/mcp.json, when it added one. */
  gateway: string | null;
}

/** The sign-in helper as setup writes it. */
export function cursorWebSignInHelper(setup: CursorWebSignInSetup): string {
  return `const SETUP = ${JSON.stringify(setup)};\n${CURSOR_WEB_SIGN_IN}`;
}

/**
 * Installs Cursor's command-line agent, signs it in to Cursor, and then
 * signs it in to the gateway. The web tools need the first two. The third is
 * for the person's own chats in that agent: they load the Guardrails hooks,
 * and a blocked call's remedy tools are the gateway's.
 *
 * The agent keeps an MCP sign-in per folder (in
 * ~/.cursor/projects/<folder>/mcp-auth.json), so the gateway sign-in covers
 * chats started in the folder this helper ran in. A step of it that does not
 * work leaves the web tools ready and says how to sign in by hand.
 */
const CURSOR_WEB_SIGN_IN = `// Setup helper for Cursor's command-line agent. Setup writes this file.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const windows = process.platform === "win32";
const INSTALL = windows ? "irm 'https://cursor.com/install?win32=true' | iex" : "curl https://cursor.com/install -fsS | bash";
// A person who names the agent's place looks after its install.
const named = process.env.ARCHESTRA_CURSOR_CLI;

function findCli() {
  if (named) return fs.existsSync(named) ? named : null;
  const candidates = windows
    ? [path.join(process.env.LOCALAPPDATA || "", "cursor-agent", "cursor-agent.cmd")]
    : [
        path.join(os.homedir(), ".local", "bin", "cursor-agent"),
        ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "cursor-agent")),
        "/usr/local/bin/cursor-agent",
        "/opt/homebrew/bin/cursor-agent",
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

// The Windows launcher is a script, which only a shell starts.
const cliCommand = (cli, args) => (windows ? { command: '"' + cli + '" ' + args.join(" "), args: [], shell: true } : { command: cli, args, shell: false });

// How long the agent may take to say whether it is signed in. The web tools'
// server runs this, and answers nothing else meanwhile. Tests shorten it.
const STATUS_TIMEOUT_MS = Number(process.env.ARCHESTRA_CURSOR_STATUS_TIMEOUT_MS) || 10000;

/**
 * Asks the agent whether it is signed in to Cursor: { signedIn }, or
 * { timedOut } when it did not say in time, or { cause } when it could not
 * run at all, which no later call changes.
 */
function account(cli) {
  const { command, args, shell } = cliCommand(cli, ["status", "--format", "json"]);
  const result = spawnSync(command, args, { shell, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: STATUS_TIMEOUT_MS, windowsHide: true });
  if (result.error?.code === "ETIMEDOUT") return { timedOut: true };
  if (result.error) return { cause: result.error.code || result.error.message };
  if (result.signal) return { cause: "stopped by " + result.signal };
  return { signedIn: /"isAuthenticated":\\s*true/.test(String(result.stdout || "")) };
}

// What is running: { child, done, output } for the install and the two sign-ins.
const work = { install: null, login: null, gateway: null, gatewayDone: false, gatewayNote: "" };
const appName = (typeof SETUP === "object" && SETUP && SETUP.appName) || "the gateway's";
const gateway = typeof SETUP === "object" && SETUP && typeof SETUP.gateway === "string" ? SETUP.gateway : null;
const READY = "Cursor's command-line agent is installed and signed in. Web search and fetch are ready.";
// How long the gateway sign-in may wait for the person. Tests shorten it.
const GATEWAY_WAIT_MS = Number(process.env.ARCHESTRA_CURSOR_GATEWAY_SIGN_IN_WAIT_MS) || 180000;

function start(command, args, shell) {
  const job = { done: false, output: "" };
  job.child = spawn(command, args, { shell, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const keep = (chunk) => {
    job.output = (job.output + String(chunk)).slice(-4000);
  };
  job.child.stdout.on("data", keep);
  job.child.stderr.on("data", keep);
  job.child.on("error", () => {
    job.done = true;
  });
  job.child.on("close", () => {
    job.done = true;
  });
  return job;
}

/** The sign-in page's address, when the agent printed one. */
function link(job) {
  const found = /https?:\\/\\/\\S+/.exec(job.output.replace(/\\u001b\\[[0-9;]*[A-Za-z]/g, ""));
  return found ? " If no page opened, open this link: " + found[0] : "";
}

/**
 * Does what is missing next. Returns { ready } once the agent is installed
 * and signed in, { failed } when a step did not work, and otherwise what is
 * under way. Its text is for the person.
 */
function step() {
  const cli = findCli();
  if (!cli) {
    if (named) return { failed: true, text: "Cursor's command-line agent was not found at " + named + ". Install it there, or with: " + INSTALL };
    if (work.install && !work.install.done) return { text: "Still installing Cursor's command-line agent." };
    if (work.install) {
      work.install = null;
      return { failed: true, text: "Cursor's command-line agent could not be installed. Install it with: " + INSTALL };
    }
    work.install = windows
      ? start("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", INSTALL], false)
      : start("bash", ["-c", INSTALL], false);
    return { text: "Installing Cursor's command-line agent with Cursor's own installer. The web search and fetch tools run through it, on the Cursor plan." };
  }
  const answer = account(cli);
  // No answer in time is not a signed-out agent, so no sign-in starts: the
  // next call asks again. An agent that cannot run will not run later either.
  if (answer.timedOut) return { text: "Cursor's command-line agent did not say in time whether it is signed in." };
  if (answer.cause) return { failed: true, text: "Cursor's command-line agent could not run (" + answer.cause + "). Install it again with: " + INSTALL };
  if (answer.signedIn) {
    const waiting = gatewayStep(cli);
    if (waiting) return waiting;
    stop();
    return { ready: true, text: READY + work.gatewayNote };
  }
  if (work.login && !work.login.done) return { text: "Waiting for the sign-in to Cursor's command-line agent: approve the browser page that opened." + link(work.login) };
  if (work.login) {
    work.login = null;
    return { failed: true, text: "The sign-in to Cursor's command-line agent did not finish. Start it again, or run: cursor-agent login" };
  }
  const { command, args, shell } = cliCommand(cli, ["login"]);
  work.login = start(command, args, shell);
  return { text: "Signing in to Cursor's command-line agent, which signs in separately from the Cursor app: approve the browser page that opens." };
}

/** How the agent lists the gateway for this folder: "ready", "requires_authentication", or what else it says. */
function gatewayState(cli) {
  const { command, args, shell } = cliCommand(cli, ["mcp", "list"]);
  const result = spawnSync(command, args, { shell, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000, windowsHide: true });
  const lines = String(result.stdout || "").replace(/\\u001b\\[[0-9;]*[A-Za-z]/g, "").split(/\\r?\\n/);
  const line = lines.find((entry) => entry.trim().startsWith(gateway + ":"));
  return line ? line.trim().slice(gateway.length + 1).trim() : null;
}

/**
 * Signs the agent in to the gateway for this folder. Returns what is under
 * way, or nothing once there is no more to do; the outcome is then in
 * work.gatewayNote, for the line that says the web tools are ready.
 */
function gatewayStep(cli) {
  if (!gateway || work.gatewayDone) return null;
  const byHand = " To sign its own chats in to " + appName + " tools, run in the folder you start them from: cursor-agent mcp login " + gateway;
  if (work.gateway && !work.gateway.done) {
    if (Date.now() - work.gateway.since < GATEWAY_WAIT_MS)
      return { text: "Waiting for the sign-in of Cursor's command-line agent to " + appName + " tools: approve the browser page that opened." + link(work.gateway) };
    // The web tools are ready without it: stop waiting for a page nobody approved.
    try {
      work.gateway.child.kill();
    } catch {}
    work.gateway = null;
    work.gatewayDone = true;
    work.gatewayNote = byHand;
    return null;
  }
  let state = gatewayState(cli);
  if (state && state !== "ready" && state !== "requires_authentication" && !work.gateway) {
    // The agent asks before it loads a server of the folder's own config.
    const { command, args, shell } = cliCommand(cli, ["mcp", "enable", gateway]);
    spawnSync(command, args, { shell, stdio: "ignore", timeout: 60000, windowsHide: true });
    state = gatewayState(cli);
  }
  if (state === "ready") {
    work.gatewayDone = true;
    work.gatewayNote = " Chats in Cursor's command-line agent that start in " + process.cwd() + " are signed in to " + appName + " tools; the agent asks again in another folder.";
    return null;
  }
  if (work.gateway || state !== "requires_authentication") {
    // The sign-in ended without one, or the agent does not offer one.
    work.gateway = null;
    work.gatewayDone = true;
    work.gatewayNote = byHand;
    return null;
  }
  const { command, args, shell } = cliCommand(cli, ["mcp", "login", gateway]);
  work.gateway = start(command, args, shell);
  work.gateway.since = Date.now();
  return { text: "Signing Cursor's command-line agent in to " + appName + " tools too, so that its own chats can use them: approve the browser page that opens." };
}

function stop() {
  for (const job of [work.install, work.login, work.gateway]) {
    try {
      if (job && !job.done) job.child.kill();
    } catch {}
  }
  work.install = null;
  work.login = null;
  work.gateway = null;
}

module.exports = { step, stop };

// Run from a terminal or by setup: keep going until ready, for at most ten minutes.
if (require.main === module) {
  const until = Date.now() + 10 * 60 * 1000;
  let said = "";
  const turn = () => {
    const outcome = step();
    if (outcome.text !== said) console.log(outcome.text);
    said = outcome.text;
    if (outcome.ready) process.exit(0);
    if (outcome.failed) process.exit(1);
    if (Date.now() > until) {
      stop();
      console.log("Stopped waiting. Run this again when you are ready: node ~/.cursor/archestra/web-sign-in.cjs");
      process.exit(1);
    }
    setTimeout(turn, 2000);
  };
  turn();
}
`;
