import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderSetupScript } from "./index";
import {
  CURSOR_WEB_CALL_ARGUMENT,
  CURSOR_WEB_CALL_ENV,
  CURSOR_WEB_CALL_HEADER,
  CURSOR_WEB_CLI_PERMISSIONS,
  CURSOR_WEB_FETCH_TOOL,
  CURSOR_WEB_SEARCH_TOOL,
  CURSOR_WEB_SETUP_TOOL,
} from "./payloads/cursor-web-tools";
import type { SetupScriptContext } from "./types";

const execFileAsync = promisify(execFile);
const NODE_STEP_START = "node - <<'ARCHESTRA_NODE_SETUP'\n";
const NODE_STEP_END = "\nARCHESTRA_NODE_SETUP";

let root: string;
let home: string;
let fakeCli: string;
let started: ChildProcess[];
let server: Server | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "archestra-cursor-web-"));
  home = path.join(root, "home");
  fakeCli = path.join(root, "fake-cli");
  started = [];
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await mkdir(fakeCli, { recursive: true });
});

afterEach(async () => {
  for (const child of started) child.kill();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

function render(
  platform: "macos" | "windows" = "macos",
  finishWebSetup = false,
) {
  return renderSetupScript({
    clientId: "cursor",
    platform,
    appName: "Archestra",
    mcp: {
      serverName: "archestra",
      url: "https://archestra.example.com/v1/mcp/gateway",
      toolPrefix: "archestra__",
    },
    proxy: null,
    skills: null,
    cursorGuardrailsHook: {
      url: "https://archestra.example.com/v1/connection-hooks/cursor",
      token: "chk1_test-credential",
      finishWebSetup,
    },
  } as SetupScriptContext);
}

/** Runs the setup's Cursor Guardrails step, as bash would, in a scratch home. */
async function install() {
  const script = render();
  const start = script.indexOf(NODE_STEP_START);
  const end = script.indexOf(NODE_STEP_END, start);
  if (start < 0 || end < 0) throw new Error("Missing the Cursor hook step");
  const step = path.join(root, "hook-step.cjs");
  await writeFile(step, script.slice(start + NODE_STEP_START.length, end));
  await execFileAsync(process.execPath, [step], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

const archestraDir = () => path.join(home, ".cursor", "archestra");
const childHome = () => path.join(archestraDir(), "web-cli", "home");
const childWorkspace = () => path.join(archestraDir(), "web-cli", "workspace");

type CliRun = {
  stdout?: unknown[];
  stderr?: string;
  exit?: number;
  /** Keeps running after its output, as the real CLI does after a result. */
  hang?: boolean;
};

/**
 * Puts a stand-in for Cursor's CLI where the web tools look for it. Each run
 * records how it was started and plays the next entry of the plan.
 */
async function installFakeCli(plan: CliRun[]) {
  const bin = path.join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(fakeCli, "plan.json"), JSON.stringify(plan));
  const file = path.join(bin, "cursor-agent");
  await writeFile(
    file,
    `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = ${JSON.stringify(fakeCli)};
// The two account commands the sign-in helper uses.
if (process.argv[2] === "status") {
  console.log(JSON.stringify({ isAuthenticated: fs.existsSync(path.join(dir, "signed-in")) }, null, 2));
  process.exit(0);
}
if (process.argv[2] === "login") {
  fs.appendFileSync(path.join(dir, "logins"), "x");
  // A sign-in that waits for the person, as the real one does.
  if (fs.existsSync(path.join(dir, "login-waits"))) {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 150 && !fs.existsSync(path.join(dir, "login-works")); i++) Atomics.wait(pause, 0, 0, 100);
  }
  if (fs.existsSync(path.join(dir, "login-works"))) fs.writeFileSync(path.join(dir, "signed-in"), "");
  process.exit(0);
}
// The MCP commands the helper signs the agent in to the gateway with. The
// gateway is signed in unless a test says otherwise.
if (process.argv[2] === "mcp") {
  const state = path.join(dir, "gateway-state");
  const read = () => (fs.existsSync(state) ? fs.readFileSync(state, "utf8").trim() : "ready");
  if (process.argv[3] === "list") console.log("archestra: " + read() + "\\narchestra-web: ready");
  if (process.argv[3] === "enable") fs.appendFileSync(path.join(dir, "mcp-enables"), process.argv[4] + "\\n");
  if (process.argv[3] === "login") {
    fs.appendFileSync(path.join(dir, "mcp-logins"), process.argv[4] + " in " + process.cwd() + "\\n");
    console.log("Opening your browser...\\nhttp://archestra.example.com/api/auth/oauth2/authorize?client_id=x");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "gateway-approved")); i++) Atomics.wait(pause, 0, 0, 100);
    if (fs.existsSync(path.join(dir, "gateway-approved"))) fs.writeFileSync(state, "ready");
  }
  process.exit(0);
}
const calls = path.join(dir, "calls.jsonl");
const done = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(calls, JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR,
    CURSOR_DATA_DIR: process.env.CURSOR_DATA_DIR,
    parentCall: process.env[${JSON.stringify(CURSOR_WEB_CALL_ENV)}],
  },
}) + "\\n");
const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
const run = plan[Math.min(done, plan.length - 1)];
for (const line of run.stdout || []) process.stdout.write(JSON.stringify(line) + "\\n");
if (run.stderr) process.stderr.write(run.stderr);
if (run.hang) setInterval(() => {}, 1000);
else process.exitCode = run.exit || 0;
`,
  );
  await chmod(file, 0o755);
}

async function cliRuns(): Promise<
  Array<{
    pid: number;
    argv: string[];
    cwd: string;
    env: Record<string, string | undefined>;
  }>
> {
  const raw = await readFile(path.join(fakeCli, "calls.jsonl"), "utf8").catch(
    () => "",
  );
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Starts the installed web tools server and speaks MCP to it, as Cursor does. */
function webTools(env: Record<string, string> = {}) {
  const child = spawn(
    process.execPath,
    [path.join(archestraDir(), "web-tools.mjs")],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        // No real Cursor CLI of this machine is found through the path.
        PATH: path.dirname(process.execPath),
        XDG_CONFIG_HOME: "",
        ...env,
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  started.push(child);
  const waiting = new Map<number, (result: unknown) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message.result ?? message.error);
    waiting.delete(message.id);
  });
  let nextId = 0;
  const request = <T>(method: string, params?: unknown) =>
    new Promise<T>((resolve) => {
      const id = ++nextId;
      waiting.set(id, resolve as (result: unknown) => void);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  return {
    request,
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await request<{
        content: Array<{ text: string }>;
        isError?: boolean;
      }>("tools/call", { name, arguments: args });
      return { text: result.content[0].text, isError: result.isError === true };
    },
  };
}

const fetched = (url: string, markdown: string) => ({
  type: "tool_call",
  subtype: "completed",
  tool_call: {
    webFetchToolCall: { args: { url }, result: { success: { url, markdown } } },
  },
});

const searched = (searchTerm: string, chunk: string) => ({
  type: "tool_call",
  subtype: "completed",
  tool_call: {
    webSearchToolCall: {
      args: { searchTerm },
      result: {
        success: {
          references: [{ title: "Web search results", url: "", chunk }],
        },
      },
    },
  },
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Cursor web tools setup", () => {
  test("setup installs the web tools, their server entry and the CLI process's folders", async () => {
    await writeFile(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { mine: { url: "https://mine.example" } } }),
    );
    await install();
    await install();

    const servers = JSON.parse(
      await readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ).mcpServers;
    expect(servers.mine).toEqual({ url: "https://mine.example" });
    expect(servers["archestra-web"]).toEqual({
      command: process.execPath,
      args: [path.join(archestraDir(), "web-tools.mjs")],
    });
    // Cursor does not ask about a call Guardrails already rule on.
    const { mcpAllowlist } = JSON.parse(
      await readFile(path.join(home, ".cursor", "permissions.json"), "utf8"),
    );
    expect(mcpAllowlist).toEqual(
      expect.arrayContaining([
        `archestra-web:${CURSOR_WEB_SETUP_TOOL}`,
        `archestra-web:${CURSOR_WEB_SEARCH_TOOL}`,
        `archestra-web:${CURSOR_WEB_FETCH_TOOL}`,
      ]),
    );

    // The CLI process may make its web call and nothing else, and reports to
    // Guardrails through the same hook as the chat.
    expect(
      JSON.parse(
        await readFile(
          path.join(childWorkspace(), ".cursor", "cli.json"),
          "utf8",
        ),
      ),
    ).toEqual(CURSOR_WEB_CLI_PERMISSIONS);
    const hooks = JSON.parse(
      await readFile(path.join(childHome(), ".cursor", "hooks.json"), "utf8"),
    ).hooks;
    expect(hooks.preToolUse).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("guardrails-hook.mjs' preToolUse"),
        failClosed: true,
      }),
    ]);
  });

  test("on Linux the server's entry carries where the CLI keeps its sign-in", async () => {
    const script = render();
    const start = script.indexOf(NODE_STEP_START);
    const step = path.join(root, "hook-step.cjs");
    await writeFile(
      step,
      script.slice(
        start + NODE_STEP_START.length,
        script.indexOf(NODE_STEP_END, start),
      ),
    );
    await execFileAsync(process.execPath, [step], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(root, "xdg"),
      },
    });
    const entry = JSON.parse(
      await readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ).mcpServers["archestra-web"];
    // Cursor starts the server without the shell's variables.
    expect(entry.env).toEqual(
      process.platform === "linux"
        ? { XDG_CONFIG_HOME: path.join(root, "xdg") }
        : undefined,
    );
  });

  test("a mcp.json setup cannot read is left alone, and the person gets the entry to add", async () => {
    await writeFile(path.join(home, ".cursor", "mcp.json"), "{ // mine\n}");
    const script = render();
    const start = script.indexOf(NODE_STEP_START);
    const step = path.join(root, "hook-step.cjs");
    await writeFile(
      step,
      script.slice(
        start + NODE_STEP_START.length,
        script.indexOf(NODE_STEP_END, start),
      ),
    );
    const { stdout } = await execFileAsync(process.execPath, [step], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(stdout).toContain("add this server to its mcpServers by hand");
    expect(stdout).toContain('"archestra-web"');
    await expect(
      readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ).resolves.toBe("{ // mine\n}");
  });

  test("only the script a person runs installs and signs in the Cursor CLI, as its last Guardrails step", async () => {
    // A rendered script on its own (a test, a preview) reaches no CLI.
    await installFakeCli([]);
    await install();
    expect(await cliRuns()).toEqual([]);
    await expect(
      readFile(path.join(fakeCli, "logins"), "utf8"),
    ).rejects.toThrow();
    for (const platform of ["macos", "windows"] as const) {
      expect(render(platform)).not.toContain(
        "Getting web search and fetch ready for Cursor chats",
      );
      const script = render(platform, true);
      const hook = script.indexOf(
        "Turning on Archestra Guardrails for Cursor chats",
      );
      const step = script.indexOf(
        "Getting web search and fetch ready for Cursor chats",
      );
      expect(hook).toBeGreaterThan(0);
      expect(step).toBeGreaterThan(hook);
      expect(script.slice(step)).toContain("web-sign-in.cjs");
    }
  });

  test("the last step runs the helper and a step that does not finish leaves the setup in place", async () => {
    await install();
    await installFakeCli([]);
    const script = render("macos", true);
    const start = script.indexOf(
      "say 'Getting web search and fetch ready for Cursor chats'",
    );
    const body = script.slice(start, script.indexOf("\n\n", start));
    const run = (signedIn: boolean) =>
      execFileAsync(
        "bash",
        [
          "-c",
          `say() { echo "== $1"; }; warn() { echo "warning: $1"; }\n${body}\necho after`,
        ],
        {
          env: {
            HOME: home,
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            ARCHESTRA_CURSOR_CLI: path.join(
              home,
              ".local",
              "bin",
              signedIn ? "cursor-agent" : "no-such-cli",
            ),
          },
        },
      );
    await writeFile(path.join(fakeCli, "signed-in"), "");
    const ready = await run(true);
    expect(ready.stdout).toContain("Web search and fetch are ready.");
    expect(ready.stdout).not.toContain("warning:");

    const unfinished = await run(false);
    expect(unfinished.stdout).toContain(
      `warning: Web search and fetch are not ready yet. Ask Cursor to run its ${CURSOR_WEB_SETUP_TOOL} tool`,
    );
    // The script carries on.
    expect(unfinished.stdout.trim().endsWith("after")).toBe(true);
  });
});

describe("Cursor CLI setup helper", () => {
  const helper = async (env: Record<string, string> = {}) => {
    const child = spawn(
      process.execPath,
      [path.join(archestraDir(), "web-sign-in.cjs")],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PATH: path.dirname(process.execPath),
          // The stand-in is named, so the helper never runs an installer.
          ARCHESTRA_CURSOR_CLI: path.join(
            home,
            ".local",
            "bin",
            "cursor-agent",
          ),
          ...env,
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    started.push(child);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const status = await new Promise<number | null>((resolve) =>
      child.on("close", resolve),
    );
    return { status, stdout };
  };
  const logins = () =>
    readFile(path.join(fakeCli, "logins"), "utf8").then(
      (text) => text.length,
      () => 0,
    );

  test("a signed-in CLI needs nothing, and no browser page opens", async () => {
    await install();
    await installFakeCli([]);
    await writeFile(path.join(fakeCli, "signed-in"), "");
    const { status, stdout } = await helper();
    expect(status).toBe(0);
    expect(stdout).toContain("installed and signed in");
    expect(await logins()).toBe(0);
  });

  test("a signed-out CLI is signed in, and the result is checked", async () => {
    await install();
    await installFakeCli([]);
    await writeFile(path.join(fakeCli, "login-works"), "");
    const done = await helper();
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("approve the browser page that opens");
    expect(done.stdout).toContain("Web search and fetch are ready.");
    expect(await logins()).toBe(1);
  });

  test("the helper then signs the agent in to the gateway, for the folder it runs in", async () => {
    await install();
    await installFakeCli([]);
    await writeFile(path.join(fakeCli, "signed-in"), "");
    await writeFile(
      path.join(fakeCli, "gateway-state"),
      "requires_authentication",
    );
    setTimeout(
      () => writeFile(path.join(fakeCli, "gateway-approved"), ""),
      600,
    );
    const done = await helper();
    expect(done.status).toBe(0);
    expect(done.stdout).toContain(
      "Signing Cursor's command-line agent in to Archestra tools too",
    );
    expect(done.stdout).toContain("Web search and fetch are ready.");
    expect(done.stdout).toContain("are signed in to Archestra tools");
    expect(done.stdout).toContain("the agent asks again in another folder");
    expect(await readFile(path.join(fakeCli, "mcp-logins"), "utf8")).toMatch(
      /^archestra in /,
    );
  });

  test("a gateway sign-in nobody approves leaves the web tools ready and says how to do it by hand", async () => {
    await install();
    await installFakeCli([]);
    await writeFile(path.join(fakeCli, "signed-in"), "");
    await writeFile(
      path.join(fakeCli, "gateway-state"),
      "requires_authentication",
    );
    const done = await helper({
      ARCHESTRA_CURSOR_GATEWAY_SIGN_IN_WAIT_MS: "500",
    });
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("Web search and fetch are ready.");
    expect(done.stdout).toContain("cursor-agent mcp login archestra");
  });

  test("a server the agent has not approved for the folder is enabled first", async () => {
    await install();
    await installFakeCli([]);
    await writeFile(path.join(fakeCli, "signed-in"), "");
    await writeFile(
      path.join(fakeCli, "gateway-state"),
      "not loaded (needs approval)",
    );
    const done = await helper();
    expect(done.status).toBe(0);
    expect(await readFile(path.join(fakeCli, "mcp-enables"), "utf8")).toBe(
      "archestra\n",
    );
    // Still not offered a sign-in: the web tools are ready, the rest by hand.
    expect(done.stdout).toContain("cursor-agent mcp login archestra");
  });

  test("a sign-in the person did not finish is reported", async () => {
    await install();
    await installFakeCli([]);
    const unfinished = await helper();
    expect(unfinished.status).toBe(1);
    expect(unfinished.stdout).toContain("did not finish");
  });

  test("a CLI named somewhere it is not gets Cursor's install command, and no installer runs", async () => {
    await install();
    const missing = await helper({
      ARCHESTRA_CURSOR_CLI: path.join(root, "no-such-cli"),
    });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain(
      "curl https://cursor.com/install -fsS | bash",
    );
  });
});

describe("Cursor web tools", () => {
  test("the server offers a web search and a web fetch", async () => {
    await install();
    const { tools } = await webTools().request<{
      tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
    }>("tools/list");
    expect(tools.map((tool) => [tool.name, tool.inputSchema.required])).toEqual(
      [
        [CURSOR_WEB_SETUP_TOOL, undefined],
        [CURSOR_WEB_SEARCH_TOOL, ["query"]],
        [CURSOR_WEB_FETCH_TOOL, ["url"]],
      ],
    );
  });

  test("the setup tool signs a signed-out CLI in from a chat, and waits for the person within a call", async () => {
    await install();
    await installFakeCli([]);
    await writeFile(path.join(fakeCli, "login-waits"), "");
    const cli = {
      ARCHESTRA_CURSOR_CLI: path.join(home, ".local", "bin", "cursor-agent"),
    };
    // The person has not approved yet: a call waits its time, then says what
    // it waits for and to keep calling.
    const waiting = webTools({
      ...cli,
      ARCHESTRA_CURSOR_WEB_SETUP_WAIT_MS: "300",
    });
    const first = await waiting.call(CURSOR_WEB_SETUP_TOOL, {});
    expect(first.isError).toBe(false);
    expect(first.text).toContain("approve the browser page that open");
    expect(first.text).toContain(
      "keep calling it until it says ready or failed",
    );
    // An approval that arrives while a call waits is that call's answer.
    const patient = webTools(cli);
    const call = patient.call(CURSOR_WEB_SETUP_TOOL, {});
    setTimeout(() => writeFile(path.join(fakeCli, "login-works"), ""), 500);
    expect((await call).text).toContain("Web search and fetch are ready.");
  });

  test("the setup tool says what failed, and a web tool names it when the CLI is missing", async () => {
    await install();
    const tools = webTools({
      ARCHESTRA_CURSOR_CLI: path.join(root, "no-such-cli"),
    });
    const setup = await tools.call(CURSOR_WEB_SETUP_TOOL, {});
    expect(setup.isError).toBe(true);
    expect(setup.text).toContain("was not found at");
    const search = await tools.call(CURSOR_WEB_SEARCH_TOOL, { query: "x" });
    expect(search.text).toContain(`Call the ${CURSOR_WEB_SETUP_TOOL} tool now`);
  });

  test("a fetch runs one native call in a confined CLI process and returns its raw result", async () => {
    await install();
    await installFakeCli([
      {
        stdout: [
          { type: "system", subtype: "init" },
          // The model may look the tool up first.
          {
            type: "tool_call",
            subtype: "completed",
            tool_call: { getMcpToolsToolCall: { args: {}, result: {} } },
          },
          fetched("https://example.com/", "# Example Domain"),
        ],
        hang: true,
      },
    ]);
    const result = await webTools().call(CURSOR_WEB_FETCH_TOOL, {
      url: "https://example.com",
      [CURSOR_WEB_CALL_ARGUMENT]: "call-id-0123456789",
    });
    expect(result).toEqual({ text: "# Example Domain", isError: false });

    const [run] = await cliRuns();
    // Headless, on one model, with the call named so the model takes one step.
    expect(run.argv.slice(0, -1)).toEqual([
      "-p",
      "--force",
      "--trust",
      "--model",
      "auto",
      "--output-format",
      "stream-json",
    ]);
    expect(run.argv.at(-1)).toContain(
      'call the tool WebFetch on the server "cursor" with arguments {"url":"https://example.com"}',
    );
    // In the folder whose permission file denies everything else, with its
    // own settings, and reporting to Guardrails for the call that started it.
    expect(run.cwd).toBe(childWorkspace());
    expect(run.env.CURSOR_CONFIG_DIR).toBe(path.join(childHome(), ".cursor"));
    expect(run.env.parentCall).toBe("call-id-0123456789");
    // The files the CLI saves results into stay out of ~/.cursor/archestra,
    // where a write needs a person's approval.
    expect(run.env.CURSOR_DATA_DIR).toBe(
      path.join(tmpdir(), "archestra-cursor-web-cli"),
    );
    if (process.platform === "linux") {
      // Its own home, so none of the person's MCP servers or hooks load; its
      // sign-in stays where the CLI keeps it.
      expect(run.env.HOME).toBe(childHome());
      expect(run.env.XDG_CONFIG_HOME).toBe(path.join(home, ".config"));
    }
    // The process is stopped once its result is in.
    await expect.poll(() => isRunning(run.pid), { timeout: 5000 }).toBe(false);
  });

  test("a search returns the results the native tool gave", async () => {
    await install();
    await installFakeCli([
      {
        stdout: [
          searched("node lts", "Links:\n1. [Node.js](https://nodejs.org)"),
        ],
      },
    ]);
    const result = await webTools().call(CURSOR_WEB_SEARCH_TOOL, {
      query: "node lts",
    });
    expect(result).toEqual({
      text: "Web search results\nLinks:\n1. [Node.js](https://nodejs.org)",
      isError: false,
    });
    const [run] = await cliRuns();
    expect(run.argv.at(-1)).toContain(
      'call the tool WebSearch on the server "cursor" with arguments {"search_term":"node lts"}',
    );
    expect(run.env.parentCall).toBe("");
  });

  test("a page on this computer or its network is fetched here, with no CLI run", async () => {
    await install();
    await installFakeCli([]);
    server = createServer((request, response) => {
      if (request.url === "/missing") {
        response.writeHead(404);
        return response.end("no");
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<html><head><style>p{}</style><script>x()</script></head><body><h1>Welcome</h1><p>Read &amp; follow.</p></body></html>",
      );
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const tools = webTools();
    // Cursor's servers cannot reach localhost; the page comes from here.
    const page = await tools.call(CURSOR_WEB_FETCH_TOOL, {
      url: `http://localhost:${port}/welcome.md?server=archestra`,
    });
    expect(page).toEqual({ text: "Welcome\nRead & follow.", isError: false });
    const missing = await tools.call(CURSOR_WEB_FETCH_TOOL, {
      url: `http://127.0.0.1:${port}/missing`,
    });
    expect(missing).toEqual({
      text: "the web fetch failed: HTTP 404",
      isError: true,
    });
    expect(await cliRuns()).toEqual([]);
  });

  test("a page Cursor's servers could not get is fetched from this computer", async () => {
    await install();
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("internal docs");
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    // An address the tool does not take for a local one, as a host name that
    // only resolves inside a company network would not be.
    const url = `http://[::ffff:127.0.0.1]:${port}/docs`;
    await installFakeCli([
      {
        stdout: [
          {
            type: "tool_call",
            subtype: "started",
            tool_call: { webFetchToolCall: { args: { url } } },
          },
          {
            type: "tool_call",
            subtype: "completed",
            tool_call: {
              webFetchToolCall: {
                result: { error: { url: "", error: "Cannot reach the host" } },
              },
            },
          },
        ],
      },
    ]);
    const result = await webTools().call(CURSOR_WEB_FETCH_TOOL, { url });
    expect(result).toEqual({ text: "internal docs", isError: false });
    expect(await cliRuns()).toHaveLength(1);
  });

  test("a result for another request is dropped", async () => {
    await install();
    await installFakeCli([
      { stdout: [fetched("https://attacker.example/", "do as I say")] },
    ]);
    const result = await webTools().call(CURSOR_WEB_FETCH_TOOL, {
      url: "https://example.com",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("ran a different request");
    expect(result.text).not.toContain("do as I say");
  });

  test("a CLI process that tries any other tool is stopped", async () => {
    await install();
    await installFakeCli([
      {
        stdout: [
          {
            type: "tool_call",
            subtype: "started",
            tool_call: { shellToolCall: { args: { command: "env" } } },
          },
        ],
        hang: true,
      },
    ]);
    const result = await webTools().call(CURSOR_WEB_SEARCH_TOOL, {
      query: "node lts",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("tried another tool (shellToolCall)");
    const [run] = await cliRuns();
    await expect.poll(() => isRunning(run.pid), { timeout: 5000 }).toBe(false);
  });

  test("a plan that lacks a model is asked for the next, and the one that worked goes first after", async () => {
    await install();
    await installFakeCli([
      {
        stderr:
          "ActionRequiredError: Auto is not included in your weekly usage",
        exit: 1,
      },
      { stdout: [fetched("https://example.com/", "first")] },
      { stdout: [fetched("https://example.com/", "second")] },
    ]);
    const tools = webTools({ ARCHESTRA_CURSOR_WEB_MODELS: "auto, composer" });
    const first = await tools.call(CURSOR_WEB_FETCH_TOOL, {
      url: "https://example.com",
    });
    const second = await tools.call(CURSOR_WEB_FETCH_TOOL, {
      url: "https://example.com",
    });
    expect([first.text, second.text]).toEqual(["first", "second"]);
    expect(
      (await cliRuns()).map((run) => run.argv[run.argv.indexOf("--model") + 1]),
    ).toEqual(["auto", "composer", "composer"]);
  });

  test("when no model is on the plan, the model is told what Cursor said and how to name another", async () => {
    await install();
    await installFakeCli([
      {
        stderr:
          "ActionRequiredError: Auto is not included in your weekly usage",
        exit: 1,
      },
    ]);
    const result = await webTools().call(CURSOR_WEB_FETCH_TOOL, {
      url: "https://example.com",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not included in your weekly usage");
    expect(result.text).toContain("ARCHESTRA_CURSOR_WEB_MODELS");
    expect(result.text).toContain("Cursor's browser tool");
    // The CLI's own default is whatever it ran last, so it is not tried.
    expect(await cliRuns()).toHaveLength(1);
  });

  test("a signed-out CLI and a missing CLI say how to fix them", async () => {
    await install();
    const missing = await webTools({
      ARCHESTRA_CURSOR_CLI: path.join(root, "no-such-cli"),
    }).call(CURSOR_WEB_FETCH_TOOL, { url: "https://example.com" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("is not installed");
    expect(missing.text).toContain(CURSOR_WEB_SETUP_TOOL);

    await installFakeCli([
      {
        stderr:
          "Error: Authentication required. Run 'cursor-agent login', pass --api-key.",
        exit: 1,
      },
    ]);
    const signedOut = await webTools().call(CURSOR_WEB_FETCH_TOOL, {
      url: "https://example.com",
    });
    expect(signedOut.isError).toBe(true);
    expect(signedOut.text).toContain("is not signed in");
    expect(signedOut.text).toContain(CURSOR_WEB_SETUP_TOOL);
    // Another model would be signed out too.
    expect(await cliRuns()).toHaveLength(1);
  });

  test("a failed native call and a bad request are errors, not results", async () => {
    await install();
    // Nothing listens there, so this computer cannot get the page either.
    const unreachable = "http://[::ffff:127.0.0.1]:1/page";
    await installFakeCli([
      {
        stdout: [
          {
            type: "tool_call",
            subtype: "completed",
            tool_call: {
              webFetchToolCall: {
                args: { url: unreachable },
                result: { error: { url: "", error: "HTTP 404" } },
              },
            },
          },
        ],
      },
    ]);
    const tools = webTools();
    const failed = await tools.call(CURSOR_WEB_FETCH_TOOL, {
      url: unreachable,
    });
    expect(failed).toMatchObject({ isError: true });
    expect(failed.text).toContain("the web fetch failed: HTTP 404");
    // The tool works; this page does not.
    expect(failed.text).not.toContain("Until that is fixed");

    const unsafe = await tools.call(CURSOR_WEB_FETCH_TOOL, {
      url: "file:///etc/passwd",
    });
    expect(unsafe).toMatchObject({ isError: true });
    expect(unsafe.text).toContain("http:// or https://");
    expect(await cliRuns()).toHaveLength(1);
  });

  test("a long page comes in parts small enough for the hook to see, from one fetch", async () => {
    await install();
    const page = `${"a".repeat(50_000)}${"b".repeat(30_000)}`;
    await installFakeCli([{ stdout: [fetched("https://example.com/", page)] }]);
    const tools = webTools();
    const first = await tools.call(CURSOR_WEB_FETCH_TOOL, {
      url: "https://example.com",
    });
    // Cursor gives a hook nothing of a result over 40000 bytes.
    expect(Buffer.byteLength(first.text)).toBeLessThan(40_000);
    const next =
      /\[Characters 0 to (\d+) of 80000\. Call this tool again with the same url and offset \1 to read on\.\]$/.exec(
        first.text,
      );
    expect(next).not.toBeNull();

    const parts = [first.text];
    let offset = Number(next?.[1]);
    while (offset < page.length) {
      const more = await tools.call(CURSOR_WEB_FETCH_TOOL, {
        url: "https://example.com",
        offset,
      });
      expect(Buffer.byteLength(more.text)).toBeLessThan(40_000);
      parts.push(more.text);
      offset = Number(/\[Characters \d+ to (\d+) of/.exec(more.text)?.[1]);
    }
    expect(parts.at(-1)).toContain("This is the end of the page.]");
    expect(
      parts
        .map((text) => text.replace(/\n\n\[Characters [^\]]*\]$/, ""))
        .join(""),
    ).toBe(page);
    // The parts after the first cost no second run.
    expect(await cliRuns()).toHaveLength(1);
  });

  test("a part stays small enough as it travels, when the page is full of characters that JSON escapes", async () => {
    await install();
    // A quote, a backslash and a line break each take two bytes in a result.
    const page = '"\\\n'.repeat(30_000);
    await installFakeCli([{ stdout: [fetched("https://example.com/", page)] }]);
    const tools = webTools();
    const parts: string[] = [];
    let offset = 0;
    while (offset < page.length) {
      const next = await tools.call(CURSOR_WEB_FETCH_TOOL, {
        url: "https://example.com",
        ...(offset > 0 ? { offset } : {}),
      });
      expect(next.isError).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(next.text))).toBeLessThan(40_000);
      parts.push(next.text.replace(/\n\n\[Characters [^\]]*\]$/, ""));
      offset = Number(/\[Characters \d+ to (\d+) of/.exec(next.text)?.[1]);
    }
    expect(parts.join("")).toBe(page);
    expect(await cliRuns()).toHaveLength(1);
  });

  test("a local page is read no further than a page may be long, and only a few pages are kept", async () => {
    await install();
    await installFakeCli([]);
    let sent = 0;
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      if (request.url !== "/endless")
        return response.end(`page ${request.url}`);
      // A page with no end: the reader has to stop it.
      const more = () => {
        sent += 1;
        if (response.write("x".repeat(1_000_000))) setImmediate(more);
        else response.once("drain", more);
      };
      response.on("close", () => response.removeAllListeners("drain"));
      more();
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const tools = webTools();
    const endless = await tools.call(CURSOR_WEB_FETCH_TOOL, {
      url: `http://127.0.0.1:${port}/endless`,
    });
    expect(endless.isError).toBe(false);
    expect(endless.text).toMatch(/\[Characters 0 to \d+ of 2000000\./);
    expect(sent).toBeLessThan(50);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sentByFirstFetch = sent;

    // The first of ten pages is no longer kept: its second part is fetched again.
    for (let page = 0; page < 10; page++) {
      await tools.call(CURSOR_WEB_FETCH_TOOL, {
        url: `http://127.0.0.1:${port}/p${page}`,
      });
    }
    const again = await tools.call(CURSOR_WEB_FETCH_TOOL, {
      url: `http://127.0.0.1:${port}/endless`,
      offset: 10,
    });
    expect(again.text).toMatch(/\[Characters 10 to \d+ of 2000000\./);
    expect(sent).toBeGreaterThan(sentByFirstFetch);
  });

  test("long search results are cut to what the hook can see", async () => {
    await install();
    await installFakeCli([
      { stdout: [searched("node lts", "r".repeat(90_000))] },
    ]);
    const result = await webTools().call(CURSOR_WEB_SEARCH_TOOL, {
      query: "node lts",
    });
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.text)).toBeLessThan(40_000);
    expect(result.text).toMatch(
      /\[Cut here: the results have \d+ more characters\.\]$/,
    );
  });

  test("the CLI process's hook reports with the id of the call that started it", async () => {
    await install();
    const requests: Array<string | string[] | undefined> = [];
    server = createServer((request, response) => {
      requests.push(request.headers[CURSOR_WEB_CALL_HEADER]);
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    await writeFile(
      path.join(archestraDir(), "guardrails.json"),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, token: "t" }),
    );
    const hook = (env: Record<string, string>) =>
      new Promise<void>((resolve) => {
        const child = execFile(
          process.execPath,
          [path.join(archestraDir(), "guardrails-hook.mjs"), "sessionStart"],
          { env: { ...process.env, ...env } },
          () => resolve(),
        );
        child.stdin?.end("{}");
      });
    await hook({ [CURSOR_WEB_CALL_ENV]: "call-id-0123456789" });
    await hook({ [CURSOR_WEB_CALL_ENV]: "" });
    expect(requests).toEqual(["call-id-0123456789", undefined]);
  });
});
