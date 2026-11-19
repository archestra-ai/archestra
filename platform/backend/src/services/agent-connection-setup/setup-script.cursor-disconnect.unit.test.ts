import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cursorDisconnectCommand } from "@archestra/shared/connection-setup";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderSetupScript } from "./index";
import {
  CURSOR_APPLICATION_USER_KEY,
  CURSOR_DISCONNECT_FILENAME,
  CURSOR_WEB_TOOLS_KEY,
} from "./payloads/cursor-disconnect";
import type { SetupScriptContext } from "./types";

const execFileAsync = promisify(execFile);

/**
 * The Cursor setup and its cleanup helper, run for real in a scratch home:
 * what the helper leaves behind is what a person finds after disconnecting.
 */

let root: string;
let home: string;
let cursor: string;
let stateDb: string;
/**
 * While this file exists, the stand-in `pgrep` reports a running Cursor: the
 * process id the file holds, or one that no process has when it is empty.
 */
let cursorRuns: string;
/** One line per call of the stand-in `pgrep`. */
let pgrepCalls: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "archestra-cursor-disconnect-"));
  home = path.join(root, "home");
  cursor = path.join(home, ".cursor");
  stateDb = path.join(
    home,
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  );
  cursorRuns = path.join(root, "cursor-runs");
  pgrepCalls = path.join(root, "pgrep-calls");
  pollMs = "100";
  await mkdir(cursor, { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(path.join(root, "tmp"), { recursive: true });
  // Neither the setup nor the helper may look at this machine's own Cursor.
  await writeFile(
    path.join(root, "bin", "pgrep"),
    `#!/bin/sh\necho call >> "${pgrepCalls}"\n[ -e "${cursorRuns}" ] || exit 1\nif [ -s "${cursorRuns}" ]; then cat "${cursorRuns}"; else echo 4194000; fi\n`,
  );
  await chmod(path.join(root, "bin", "pgrep"), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** How often the helper's background copy looks whether Cursor has closed. */
let pollMs = "100";

const environment = () => ({
  ...process.env,
  ARCHESTRA_CURSOR_DISCONNECT_POLL_MS: pollMs,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: path.join(root, "tmp"),
  PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
  NO_COLOR: "1",
});

/** Runs the whole setup script a person would, with the gateway and the hook. */
async function connect() {
  const script = path.join(root, "connect.sh");
  await writeFile(
    script,
    renderSetupScript({
      clientId: "cursor",
      platform: "macos",
      appName: "Archestra",
      mcp: {
        serverName: "archestra",
        toolPrefix: "archestra__",
        url: "https://archestra.example.com/v1/mcp/gateway",
      },
      proxy: null,
      skills: null,
      cursorGuardrailsHook: {
        url: "https://archestra.example.com/v1/connection-hooks/cursor",
        token: "chk1_test-credential",
      },
    } as SetupScriptContext),
  );
  await execFileAsync("bash", [script], { env: environment() });
  // The skills step clones over the network; this is what it leaves.
  await writeClone(
    "archestra-default-org-skills",
    "https://user:secret@archestra.example.com/skills/marketplace.git",
  );
}

async function writeClone(name: string, url: string) {
  const folder = path.join(cursor, "skills", name);
  await mkdir(path.join(folder, ".git"), { recursive: true });
  await writeFile(
    path.join(folder, ".git", "config"),
    `[remote "origin"]\n\turl = ${url}\n`,
  );
  await writeFile(path.join(folder, "SKILL.md"), "# A skill\n");
}

/** The helper's background copies of this scratch home that still run. */
async function waitingCopies(): Promise<string[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
  const helper = path.join(cursor, "archestra", CURSOR_DISCONNECT_FILENAME);
  return stdout
    .split("\n")
    .filter((line) => line.includes(`${helper} --finish`));
}

async function disconnect(...flags: string[]) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(cursor, "archestra", CURSOR_DISCONNECT_FILENAME), ...flags],
      { env: environment() },
    );
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "" };
  }
}

/** Every file under a folder, with JSON read as a value, so formatting does not count. */
async function tree(folder: string): Promise<Record<string, unknown>> {
  const found: Record<string, unknown> = {};
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const text = await readFile(full, "utf8");
      found[path.relative(folder, full)] = full.endsWith(".json")
        ? JSON.parse(text)
        : text;
    }
  };
  await walk(folder);
  return found;
}

async function sqlite(statements: string): Promise<string> {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
${statements}
db.commit()`,
    stateDb,
  ]);
  return stdout;
}

async function writeSettings(
  composerState: Record<string, unknown>,
  user: Record<string, unknown> = {},
) {
  await mkdir(path.dirname(stateDb), { recursive: true });
  await sqlite(
    `db.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
db.execute("INSERT INTO ItemTable VALUES (?, ?)", ("${CURSOR_APPLICATION_USER_KEY}", ${JSON.stringify(JSON.stringify({ ...user, composerState }))}))`,
  );
}

async function settings(): Promise<Record<string, string>> {
  return JSON.parse(
    await sqlite(
      `print(json.dumps(dict(db.execute("SELECT key, value FROM ItemTable").fetchall())))`,
    ),
  );
}

describe("Cursor cleanup helper", () => {
  test("a setup followed by its cleanup leaves Cursor's folder and settings as they were", async () => {
    const own = {
      "mcp.json": {
        mcpServers: { mine: { url: "https://tools.example.org/mcp/" } },
      },
      "hooks.json": {
        version: 1,
        hooks: { preToolUse: [{ command: "node ./my-hook.mjs" }] },
      },
      "permissions.json": { mcpAllowlist: ["mine:search"] },
    };
    for (const [name, value] of Object.entries(own)) {
      await writeFile(
        path.join(cursor, name),
        `${JSON.stringify(value, null, 2)}\n`,
      );
    }
    await writeClone("mine", "https://git.example.org/skills/mine.git");
    const composerState = {
      isWebSearchToolEnabled: true,
      isWebSearchToolEnabled2: false,
      isWebFetchToolEnabled: true,
      playwrightProtection: false,
    };
    await writeSettings(composerState);
    const before = await tree(cursor);

    await connect();
    const connected = await tree(cursor);
    expect(Object.keys(connected)).toContain("archestra/guardrails.json");
    expect(Object.keys(connected)).toContain(
      `archestra/${CURSOR_DISCONNECT_FILENAME}`,
    );
    expect(
      JSON.parse((await settings())[CURSOR_APPLICATION_USER_KEY]).composerState
        .isWebFetchToolEnabled,
    ).toBe(false);

    const { code, stdout } = await disconnect();
    expect(code).toBe(0);
    expect(stdout).toContain(
      'Removed "archestra" and "archestra-web" from the MCP servers',
    );
    expect(stdout).toContain("Cursor is disconnected from Archestra");
    // The clone URL's credential is never printed.
    expect(stdout).not.toContain("secret");

    expect(await tree(cursor)).toEqual(before);
    const stored = await settings();
    expect(
      JSON.parse(stored[CURSOR_APPLICATION_USER_KEY]).composerState,
    ).toEqual(composerState);
    expect(stored[CURSOR_WEB_TOOLS_KEY]).toBeUndefined();
  });

  test("a setup switches off the web search switch Cursor reads even when the settings do not hold it, as after a cleanup", async () => {
    // What Cursor writes by itself: its newest switch and the fetch switch
    // with no value, which it reads as on.
    await writeSettings({
      isWebSearchToolEnabled: true,
      isWebSearchToolEnabled2: false,
      isWebSearchToolEnabled3: null,
      isWebFetchToolEnabled: null,
    });
    const composerState = async () =>
      JSON.parse((await settings())[CURSOR_APPLICATION_USER_KEY]).composerState;
    await connect();
    await disconnect();
    // The cleanup takes a switch that had no value out again, and Cursor,
    // which would write it back, has not run since.
    expect(await composerState()).toEqual({
      isWebSearchToolEnabled: true,
      isWebSearchToolEnabled2: false,
    });

    await connect();
    expect(await composerState()).toEqual({
      isWebSearchToolEnabled: false,
      isWebSearchToolEnabled2: false,
      isWebSearchToolEnabled3: false,
      isWebFetchToolEnabled: false,
    });
    await disconnect();
    expect(await composerState()).toEqual({
      isWebSearchToolEnabled: true,
      isWebSearchToolEnabled2: false,
    });
  });

  test("files that setup created are deleted, not left empty", async () => {
    await connect();
    expect((await disconnect()).code).toBe(0);
    // The folder the skills clone sat in goes too, once it is empty.
    expect(await tree(cursor)).toEqual({});
    expect(await readdir(cursor)).toEqual([]);
  });

  const webSearchSwitch = async () =>
    JSON.parse((await settings())[CURSOR_APPLICATION_USER_KEY]).composerState
      .isWebSearchToolEnabled;
  const helperFolder = () => path.join(cursor, "archestra");

  test("while Cursor runs it removes everything but Cursor's settings, and restores those by itself once Cursor has quit", async () => {
    await writeSettings({ isWebSearchToolEnabled: true });
    await connect();
    await writeFile(cursorRuns, "");

    const first = await disconnect();
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Cursor is running");
    expect(first.stdout).toContain(
      "the next time you quit Cursor. There is nothing else to run.",
    );
    expect(first.stdout).not.toContain("--wait");
    // The hooks and the credential are gone at once; only the helper stays,
    // with the file its waiting copy touches.
    expect((await readdir(helperFolder())).sort()).toEqual([
      CURSOR_DISCONNECT_FILENAME,
      "finishing",
    ]);
    expect(await webSearchSwitch()).toBe(false);

    // A second run while the copy waits starts no other.
    await disconnect();
    expect(await waitingCopies()).toHaveLength(1);

    await rm(cursorRuns);
    await expect
      .poll(() => existsSync(helperFolder()), { timeout: 10_000 })
      .toBe(false);
    expect(await webSearchSwitch()).toBe(true);
    expect(await tree(cursor)).toEqual({});
  });

  test("a person's run in a terminal and the waiting copy can both reach a closed Cursor, and the settings are restored once", async () => {
    pollMs = "1500";
    await writeSettings({ isWebSearchToolEnabled: true });
    await connect();
    await writeFile(cursorRuns, "");
    await disconnect();

    await rm(cursorRuns);
    // Whichever of the two gets there first, neither fails.
    const second = await disconnect("--wait");
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain("Could not");
    expect(await webSearchSwitch()).toBe(true);
    expect(await tree(cursor)).toEqual({});
    await expect.poll(waitingCopies, { timeout: 10_000 }).toHaveLength(0);
    expect(existsSync(helperFolder())).toBe(false);
  });

  test("the waiting copy watches Cursor's process and starts no program while it runs", async () => {
    await writeSettings({ isWebSearchToolEnabled: true });
    await connect();
    // A process of this test's stands in for Cursor.
    const running = execFile(process.execPath, [
      "-e",
      "setTimeout(() => {}, 60000)",
    ]);
    try {
      await writeFile(cursorRuns, `${running.pid}\n`);
      await disconnect();
      const calls = async () =>
        (await readFile(pgrepCalls, "utf8")).split("\n").length;
      // Many polls later it has asked for the process list no more often.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = await calls();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await calls()).toBe(before);
      expect(await webSearchSwitch()).toBe(false);

      await rm(cursorRuns);
      running.kill();
      await expect
        .poll(() => existsSync(helperFolder()), { timeout: 10_000 })
        .toBe(false);
      expect(await webSearchSwitch()).toBe(true);
    } finally {
      running.kill();
    }
  });

  test("settings that cannot be changed leave the helper in place, and the waiting copy finishes them", async () => {
    await writeSettings({ isWebSearchToolEnabled: true });
    await connect();
    // Another program holds Cursor's settings store for longer than the
    // helper keeps trying.
    const holder = execFile("python3", [
      "-c",
      `import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.execute("BEGIN EXCLUSIVE")
print("locked", flush=True)
time.sleep(4)
db.execute("COMMIT")`,
      stateDb,
    ]);
    try {
      await new Promise<void>((resolve) =>
        holder.stdout?.once("data", () => resolve()),
      );
      const blocked = await disconnect();
      expect(blocked.code).toBe(1);
      expect(blocked.stdout).toContain(
        "Could not disconnect: Cursor's settings could not be changed. Run this again: node ",
      );
      expect(blocked.stdout).not.toContain("Cursor is disconnected from");
      // Everything else is gone; the helper stays to finish the settings.
      expect((await readdir(helperFolder())).sort()).toEqual([
        CURSOR_DISCONNECT_FILENAME,
        "finishing",
      ]);
    } finally {
      await new Promise((resolve) => holder.once("close", resolve));
    }
    await expect
      .poll(() => existsSync(helperFolder()), { timeout: 15_000 })
      .toBe(false);
    expect(await webSearchSwitch()).toBe(true);
    expect(await tree(cursor)).toEqual({});
  });

  test("a waiting copy leaves a Cursor that was connected again as it is", async () => {
    await writeSettings({ isWebSearchToolEnabled: true });
    await connect();
    await writeFile(cursorRuns, "");
    await disconnect();
    // What a new setup writes first.
    await writeFile(path.join(helperFolder(), "guardrails.json"), "{}");

    await expect.poll(waitingCopies, { timeout: 10_000 }).toHaveLength(0);
    await rm(cursorRuns);
    expect(await webSearchSwitch()).toBe(false);
    expect((await readdir(helperFolder())).sort()).toEqual([
      CURSOR_DISCONNECT_FILENAME,
      "finishing",
      "guardrails.json",
    ]);
  });

  test("takes model routing off, even when a later setup left only its base URL", async () => {
    // An earlier setup routed Cursor's models; the last one switched the key
    // off again and kept the URL, and its key row is still there.
    await writeSettings(
      { isWebSearchToolEnabled: false, isWebFetchToolEnabled: false },
      {
        useOpenAIKey: false,
        openAIBaseUrl: "https://archestra.example.com/v1/unified-model",
      },
    );
    await sqlite(
      `db.execute("INSERT INTO ItemTable VALUES (?, ?)", ("cursorAuth/openAIKey", "arch_a-virtual-key"))`,
    );
    await connect();
    const { stdout } = await disconnect();
    expect(stdout).toContain("Cursor uses its own models again");
    const stored = await settings();
    const user = JSON.parse(stored[CURSOR_APPLICATION_USER_KEY]);
    expect(user.openAIBaseUrl).toBeNull();
    expect(user.useOpenAIKey).toBe(false);
    expect(stored["cursorAuth/openAIKey"]).toBeUndefined();
  });

  test("leaves a model base URL and key that are not this deployment's", async () => {
    await writeSettings(
      { isWebSearchToolEnabled: false, isWebFetchToolEnabled: false },
      { useOpenAIKey: true, openAIBaseUrl: "https://models.example.org/v1" },
    );
    await sqlite(
      `db.execute("INSERT INTO ItemTable VALUES (?, ?)", ("cursorAuth/openAIKey", "sk-the-persons-own"))`,
    );
    await connect();
    expect((await disconnect()).stdout).not.toContain("its own models again");
    const stored = await settings();
    expect(JSON.parse(stored[CURSOR_APPLICATION_USER_KEY])).toMatchObject({
      useOpenAIKey: true,
      openAIBaseUrl: "https://models.example.org/v1",
    });
    expect(stored["cursorAuth/openAIKey"]).toBe("sk-the-persons-own");
  });

  test("takes its models out of the picker and leaves a key the person has since pointed at another service", async () => {
    await writeSettings(
      { isWebSearchToolEnabled: false, isWebFetchToolEnabled: false },
      {
        useOpenAIKey: true,
        openAIBaseUrl: "https://models.example.org/v1",
        aiSettings: {
          userAddedModels: ["my-own-model", "openai:gpt-5.4"],
          modelOverrideEnabled: ["my-own-model", "openai:gpt-5.4"],
        },
      },
    );
    await sqlite(
      `db.execute("INSERT INTO ItemTable VALUES (?, ?)", ("cursorAuth/openAIKey", "sk-the-persons-own"))`,
    );
    await connect();
    // What a setup that routed Cursor's models had recorded.
    await sqlite(
      `db.execute("INSERT INTO ItemTable VALUES (?, ?)", ("archestra/cursorModelRouterModels", ${JSON.stringify(JSON.stringify(["openai:gpt-5.4"]))}))`,
    );
    const { stdout } = await disconnect();
    expect(stdout).toContain("out of Cursor's model picker");
    expect(stdout).not.toContain("its own models again");
    const stored = await settings();
    const user = JSON.parse(stored[CURSOR_APPLICATION_USER_KEY]);
    expect(user).toMatchObject({
      useOpenAIKey: true,
      openAIBaseUrl: "https://models.example.org/v1",
    });
    expect(user.aiSettings.userAddedModels).toEqual(["my-own-model"]);
    expect(user.aiSettings.modelOverrideEnabled).toEqual(["my-own-model"]);
    expect(stored["cursorAuth/openAIKey"]).toBe("sk-the-persons-own");
    expect(stored["archestra/cursorModelRouterModels"]).toBeUndefined();
  });

  test("leaves Cursor's command-line agent installed and signed in, also one setup installed", async () => {
    const install = path.join(home, ".local", "share", "cursor-agent");
    const launcher = path.join(home, ".local", "bin", "cursor-agent");
    const binary = path.join(install, "versions", "1", "cursor-agent");
    const calls = path.join(home, "cli-calls");
    await mkdir(path.dirname(binary), { recursive: true });
    await mkdir(path.dirname(launcher), { recursive: true });
    // Records how it is called: a disconnect must not sign it out.
    await writeFile(binary, `#!/bin/sh\necho "$@" >> "${calls}"\nexit 0\n`);
    await chmod(binary, 0o755);
    await symlink(binary, launcher);

    await connect();
    // What an earlier setup left when it installed the agent itself.
    await writeFile(
      path.join(cursor, "archestra", "cli-installed-by-setup"),
      "",
    );
    const { stdout } = await disconnect();
    expect(stdout).toContain("Cursor is disconnected from");
    expect(stdout).not.toContain("command-line agent");
    expect(await readdir(path.dirname(launcher))).toEqual(["cursor-agent"]);
    expect(await readdir(path.dirname(binary))).toEqual(["cursor-agent"]);
    expect(existsSync(calls)).toBe(false);
  });

  test("removes the command-line agent's sign-ins to the gateway in every folder, and no other server's", async () => {
    await connect();
    const project = (name: string) => path.join(cursor, "projects", name);
    for (const name of ["C-Users-x", "C-work-app"]) {
      await mkdir(project(name), { recursive: true });
      await writeFile(
        path.join(project(name), "mcp-auth.json"),
        JSON.stringify({
          archestra: { tokens: { access_token: "gateway-token" } },
          ...(name === "C-work-app"
            ? { github: { tokens: { access_token: "the-persons-own" } } }
            : {}),
        }),
      );
      await writeFile(
        path.join(project(name), "mcp-approvals.json"),
        JSON.stringify([
          "archestra-2e10ebc31a44661a",
          "archestra-web-f5e48e5a665f6904",
          ...(name === "C-work-app" ? ["github-0123456789abcdef"] : []),
        ]),
      );
    }
    const { stdout } = await disconnect();
    expect(stdout).toContain(
      "Removed the sign-in of Cursor's command-line agent to Archestra tools in 2 folders.",
    );
    expect(stdout).not.toContain("gateway-token");
    expect(await tree(path.join(cursor, "projects"))).toEqual({
      "C-work-app/mcp-auth.json": {
        github: { tokens: { access_token: "the-persons-own" } },
      },
      "C-work-app/mcp-approvals.json": ["github-0123456789abcdef"],
    });
  });

  test("keeps the shared skills when asked", async () => {
    await connect();
    const { stdout } = await disconnect("--keep-skills");
    expect(stdout).toContain("Kept the shared skills");
    expect(Object.keys(await tree(cursor))).toEqual([
      "skills/archestra-default-org-skills/.git/config",
      "skills/archestra-default-org-skills/SKILL.md",
    ]);
  });

  test("says which file it could not read, and still removes the rest", async () => {
    await connect();
    await writeFile(
      path.join(cursor, "mcp.json"),
      '{ // my servers\n  "mcpServers": {} }',
    );
    const { code, stdout } = await disconnect();
    expect(code).toBe(1);
    expect(stdout).toContain("Could not disconnect:");
    expect(stdout).toContain("mcp.json has comments or is not valid JSON");
    expect(Object.keys(await tree(cursor).catch(() => ({})))).not.toContain(
      "hooks.json",
    );
  });

  test("the disconnect command runs the helper, and succeeds again once the helper has removed itself", async () => {
    await connect();
    const run = () =>
      execFileAsync(
        "bash",
        ["-c", cursorDisconnectCommand("bash", { wait: true })],
        { env: environment() },
      );
    expect((await run()).stdout).toContain("Cursor is disconnected from");
    expect(await tree(cursor)).toEqual({});
    expect((await run()).stdout).toBe("No local cleanup script remains.\n");
  });

  test("a second run finds nothing left", async () => {
    await connect();
    const helper = await readFile(
      path.join(cursor, "archestra", CURSOR_DISCONNECT_FILENAME),
      "utf8",
    );
    await disconnect();
    await mkdir(path.join(cursor, "archestra"), { recursive: true });
    await writeFile(
      path.join(cursor, "archestra", CURSOR_DISCONNECT_FILENAME),
      helper,
    );
    const { stdout } = await disconnect();
    expect(stdout).not.toContain("Removed");
    expect(await readdir(cursor)).toEqual([]);
  });
});
