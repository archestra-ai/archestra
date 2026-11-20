import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderSetupScript } from "./index";
import {
  CURSOR_DISCONNECT_UNTIL_HEADER,
  CURSOR_GUARDRAILS_HOOK_STEPS,
} from "./payloads/cursor-guardrails-hook";
import type { SetupScriptContext } from "./types";

const execFileAsync = promisify(execFile);
const NODE_STEP_START = "node - <<'ARCHESTRA_NODE_SETUP'\n";
const NODE_STEP_END = "\nARCHESTRA_NODE_SETUP";

let root: string;
let home: string;
let server: Server | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "archestra-cursor-hook-"));
  home = path.join(root, "home");
  await mkdir(path.join(home, ".cursor"), { recursive: true });
});

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

function render(url: string, platform: "macos" | "windows" = "macos") {
  return renderSetupScript({
    clientId: "cursor",
    platform,
    appName: "Archestra",
    mcp: {
      serverName: "archestra",
      url: "https://archestra.example.com/v1/mcp/gateway",
    },
    proxy: null,
    skills: null,
    cursorGuardrailsHook: { url, token: "chk1_test-credential" },
  } as SetupScriptContext);
}

/** Runs the setup's Cursor hook step, as bash would, in a scratch home. */
async function installHook(url: string) {
  const script = render(url);
  const start = script.indexOf(NODE_STEP_START);
  const end = script.indexOf(NODE_STEP_END, start);
  if (start < 0 || end < 0) throw new Error("Missing the Cursor hook step");
  const step = path.join(root, "hook-step.cjs");
  await writeFile(step, script.slice(start + NODE_STEP_START.length, end));
  await execFileAsync(process.execPath, [step], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

async function runHook(step: string, event: Record<string, unknown>) {
  const child = execFile(process.execPath, [
    path.join(home, ".cursor", "archestra", "guardrails-hook.mjs"),
    step,
  ]);
  child.stdin?.end(JSON.stringify(event));
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  await new Promise((resolve) => child.on("close", resolve));
  return JSON.parse(stdout);
}

async function listen(
  answer: (body: Record<string, unknown>) => {
    status: number;
    json: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ url: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({
        ...parsed,
        authorization: request.headers.authorization,
      });
      const { status, json, headers } = answer(parsed);
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/connection-hooks/cursor`,
    requests,
  };
}

describe("Cursor Guardrails hook setup", () => {
  test("both scripts install the hook after the gateway entry", () => {
    for (const platform of ["macos", "windows"] as const) {
      const script = render("https://archestra.example.com/hooks", platform);
      const gateway = script.indexOf("Adding Archestra tools");
      const hook = script.indexOf(
        "Turning on Archestra Guardrails for Cursor chats",
      );
      expect(gateway).toBeGreaterThan(0);
      expect(hook).toBeGreaterThan(gateway);
    }
  });

  test("setup keeps the person's own hooks, and a re-run replaces only its own", async () => {
    await writeFile(
      path.join(home, ".cursor", "hooks.json"),
      `﻿${JSON.stringify({
        version: 1,
        hooks: { preToolUse: [{ command: "./my-audit.sh" }] },
      })}`,
    );
    await installHook("https://archestra.example.com/hooks");
    await installHook("https://archestra.example.com/hooks");

    const config = JSON.parse(
      await readFile(path.join(home, ".cursor", "hooks.json"), "utf8"),
    );
    expect(Object.keys(config.hooks).sort()).toEqual(
      [...CURSOR_GUARDRAILS_HOOK_STEPS].sort(),
    );
    expect(config.hooks.preToolUse).toHaveLength(2);
    expect(config.hooks.preToolUse[0]).toEqual({ command: "./my-audit.sh" });
    expect(config.hooks.preToolUse[1]).toMatchObject({
      timeout: 30,
      failClosed: true,
    });
    expect(config.hooks.preToolUse[1].command).toContain(process.execPath);
    expect(config.hooks.postToolUse).toHaveLength(1);
    expect(config.hooks.postToolUse[0].failClosed).toBeUndefined();
    await expect(
      readFile(
        path.join(home, ".cursor", "hooks.json.archestra-backup"),
        "utf8",
      ),
    ).resolves.toContain("my-audit.sh");
    const credential = path.join(
      home,
      ".cursor",
      "archestra",
      "guardrails.json",
    );
    expect((await stat(credential)).mode & 0o777).toBe(0o600);
  });

  test("setup refuses to overwrite an unreadable hooks.json", async () => {
    await writeFile(path.join(home, ".cursor", "hooks.json"), "{ not json");
    await expect(
      installHook("https://archestra.example.com/hooks"),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      readFile(path.join(home, ".cursor", "hooks.json"), "utf8"),
    ).resolves.toBe("{ not json");
  });

  test("the hook hands Archestra's answer to Cursor with the installation credential", async () => {
    const answer = {
      permission: "deny",
      user_message: "Blocked",
      agent_message: "Blocked by policy",
    };
    const archestra = await listen(() => ({ status: 200, json: answer }));
    await installHook(archestra.url);

    const event = {
      conversation_id: "chat-1",
      tool_use_id: "call-1",
      tool_name: "Shell",
      tool_input: { command: "ls" },
    };
    expect(await runHook("preToolUse", event)).toEqual(answer);
    expect(archestra.requests).toEqual([
      {
        step: "preToolUse",
        event,
        authorization: "Bearer chk1_test-credential",
      },
    ]);
  });

  test("an unchecked tool call is denied, and other steps carry on", async () => {
    const archestra = await listen(() => ({ status: 401, json: {} }));
    await installHook(archestra.url);
    const refused = await runHook("preToolUse", { tool_name: "Shell" });
    expect(refused.permission).toBe("deny");
    expect(refused.user_message).toContain("no longer valid");
    expect(await runHook("postToolUse", { tool_name: "Shell" })).toEqual({});

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const unreachable = await runHook("preToolUse", { tool_name: "Shell" });
    expect(unreachable.permission).toBe("deny");
    expect(unreachable.user_message).toContain("unreachable");
    expect(await runHook("stop", {})).toEqual({});
  });

  test("the hook names the deployment as its settings do, and no product without a name", async () => {
    await installHook("http://127.0.0.1:1/hooks");
    const settings = path.join(home, ".cursor", "archestra", "guardrails.json");
    const stored = JSON.parse(await readFile(settings, "utf8"));
    expect(stored.appName).toBe("Archestra");

    await writeFile(
      settings,
      JSON.stringify({ ...stored, appName: "Acme AI" }),
    );
    const named = await runHook("preToolUse", { tool_name: "Shell" });
    expect(named.user_message).toContain(
      "Acme AI Guardrails could not check this tool call, so it did not run: Acme AI is unreachable",
    );

    // A setup from before the name was stored.
    await writeFile(
      settings,
      JSON.stringify({ url: stored.url, token: stored.token }),
    );
    const unnamed = await runHook("preToolUse", { tool_name: "Shell" });
    expect(unnamed.user_message).toMatch(
      /^Guardrails could not check this tool call, so it did not run: The Guardrails server is unreachable/,
    );
  });

  test("the chat that disconnects Cursor goes on when Archestra stops answering, and no other chat does", async () => {
    const until = Date.now() + 5 * 60_000;
    let status = 200;
    const archestra = await listen((body) => ({
      status,
      json: {},
      headers:
        status === 200 &&
        (body.event as { conversation_id?: string }).conversation_id ===
          "chat-disconnect"
          ? { [CURSOR_DISCONNECT_UNTIL_HEADER]: String(until) }
          : undefined,
    }));
    await installHook(archestra.url);
    const call = (chat: string) =>
      runHook("preToolUse", { conversation_id: chat, tool_name: "Shell" });
    expect(await call("chat-disconnect")).toEqual({});
    expect(await call("chat-other")).toEqual({});

    // The person revoked the connection before the cleanup finished.
    status = 403;
    expect(await call("chat-disconnect")).toEqual({});
    expect((await call("chat-other")).permission).toBe("deny");

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect(await call("chat-disconnect")).toEqual({});
    expect((await call("chat-other")).permission).toBe("deny");
    expect((await call("chat-other")).user_message).toContain("unreachable");
  });

  test("a disconnect record that has ended, or claims more than a reference's life, lets nothing through", async () => {
    await installHook("http://127.0.0.1:1/hooks");
    const record = path.join(
      home,
      ".cursor",
      "archestra",
      "disconnecting.json",
    );
    const call = (chat: string) =>
      runHook("preToolUse", { conversation_id: chat, tool_name: "Shell" });
    await writeFile(
      record,
      JSON.stringify({
        ended: Date.now() - 1000,
        "too-long": Date.now() + 60 * 60_000,
        live: Date.now() + 60_000,
      }),
    );
    expect((await call("ended")).permission).toBe("deny");
    expect((await call("too-long")).permission).toBe("deny");
    expect(await call("live")).toEqual({});
  });
});
