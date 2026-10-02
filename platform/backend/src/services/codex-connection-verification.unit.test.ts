import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ARCHESTRA_TOOL_PREFIX,
  getArchestraToolPrefix,
} from "@archestra/shared/archestra-mcp-server";
import {
  ARCHESTRA_CODEX_CONNECTION_ORIGINATOR,
  isCodexOriginator,
} from "@archestra/shared/interactions/client";
import { expect, test } from "vitest";
import { CODEX_CONNECTION_VERIFICATION_WINDOWS } from "./codex-connection-verification.windows";
import { CODEX_HANDOFF_HELPER } from "./codex-handoff";
import { renderSetupScript } from "./connection-setup-script";
import { CODEX_GUARD_CLIENT } from "./startup-guard.clients";

const exec = promisify(execFile);

const scenarios = [
  "success",
  "originator-override",
  "early-events",
  "foreign-events",
  "npm-shim",
  "node-pipe-denied",
  "gateway-error",
  "no-safe-tool",
  "wrong-provider",
  "wrong-thread-provider",
  "repeated-cursor",
  "approval",
  "shell-attempt",
  "inference-error",
  "last-error",
  "no-reply",
  "missing-turn",
  "init-exit",
  "init-payload",
  "rpc-error",
  "rpc-payload",
  "rpc-ansi-payload",
  "early-exit",
  "branded-list-skills",
  "branded-missing-prefix",
  "branded-wrong-server",
  "branded-collision",
  "branded-required",
  "branded-mixed-whoami",
  "branded-mixed-policy",
  "branded-mixed-skills",
  "branded-canonical-only",
  "invalid-tool-prefix",
] as const;
test.for([
  ...scenarios.flatMap((scenario) =>
    ["node", "powershell"].map((runtime) => ({
      scenario,
      runtime,
      printed: false,
    })),
  ),
  { scenario: "success", runtime: "node", printed: true },
  { scenario: "success", runtime: "powershell", printed: true },
  { scenario: "branded-list-skills", runtime: "node", printed: true },
  { scenario: "branded-list-skills", runtime: "powershell", printed: true },
])("native connection verification: $runtime / $scenario / printed=$printed", async ({
  scenario,
  runtime,
  printed,
}, { skip }) => {
  if (runtime === "powershell" && spawnSync("pwsh", ["--version"]).status !== 0)
    skip("PowerShell is not installed");
  const directory = await mkdtemp(path.join(tmpdir(), "codex verification "));
  try {
    const helper = path.join(directory, "handoff.cjs");
    const windowsHelper = path.join(directory, "verify.ps1");
    const binary = path.join(
      directory,
      scenario === "npm-shim" ? "codex.cmd" : "codex",
    );
    const cli =
      scenario === "npm-shim"
        ? path.join(directory, "node_modules/@openai/codex/bin/codex.js")
        : binary;
    const calls = path.join(directory, "calls.jsonl");
    const config = path.join(directory, "config.toml");
    const original =
      'model = "selected-model"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n';
    await writeFile(helper, CODEX_HANDOFF_HELPER);
    await writeFile(windowsHelper, CODEX_CONNECTION_VERIFICATION_WINDOWS);
    await writeFile(config, original);
    if (scenario === "npm-shim") {
      await mkdir(path.dirname(cli), { recursive: true });
      await writeFile(binary, "This shim must never be executed directly.");
    }
    const spawnFault = path.join(directory, "spawn-fault.cjs");
    if (scenario === "node-pipe-denied")
      await writeFile(
        spawnFault,
        `const cp=require('node:child_process');const original=cp.spawn;cp.spawn=function(command,args,options){if(options?.stdio?.includes('pipe')){const error=new Error('spawn EPERM');error.code='EPERM';throw error;}return original.apply(this,arguments);};`,
      );
    await writeFile(
      cli,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const scenario = ${JSON.stringify(scenario)};
const log = value => appendFileSync(${JSON.stringify(calls)}, JSON.stringify(value) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
log({ argv: process.argv.slice(2), network: process.env.CODEX_SANDBOX_NETWORK_DISABLED, ...(scenario === 'originator-override' ? { originatorOverride: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE } : {}) });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  log(request);
  const reply = result => send({ id: request.id, result });
  switch (request.method) {
    case 'initialize':
      if (scenario === 'init-exit') { process.stderr.write('EROFS: read-only file system opening Codex state\\nAuthorization: Bearer fixture-credential-secret\\n'); return process.exit(78); }
      if (scenario === 'init-payload') return process.stderr.write('input: [\\n' + 'padding\\n'.repeat(2000) + 'PRIVATE REQUEST\\n]\\n', () => process.exit(79));
      return reply({});
    case 'config/read':
      if (scenario === 'rpc-error') return send({ id: request.id, error: { code: -32603, message: 'Configuration unavailable. access_token=fixture-credential-secret' } });
      if (scenario === 'rpc-payload') return send({ id: request.id, error: { code: -32603, message: 'Request failed\\n"arguments": [\\n"PRIVATE REQUEST"\\n]\\n' } });
      if (scenario === 'rpc-ansi-payload') return send({ id: request.id, error: { code: -32603, message: 'input:\\x1b[0m ["PRIVATE REQUEST"]' } });
      return reply({ config: { model: 'selected-model', model_provider: scenario === 'wrong-provider' ? 'other' : 'selected-proxy', approval_policy: 'on-request', sandbox_mode: 'workspace-write' } });
    case 'thread/start': return reply({ thread: { id: 'verification-thread' }, modelProvider: scenario === 'wrong-thread-provider' ? 'other' : 'selected-proxy' });
    case 'mcpServerStatus/list': {
      if (scenario === 'repeated-cursor') return reply({ data: [], nextCursor: 'same-page' });
      if (!request.params.cursor) return reply({ data: [{ name: 'unrelated', tools: {} }], nextCursor: 'page-2' });
      const emptySchema = { type: 'object', properties: {} };
      const brandedSkills = { name: 'archestra_staging__list_skills', inputSchema: emptySchema };
      const selectedTools = () => {
        if (scenario === 'no-safe-tool') return { unsafe: { name: 'dangerous__delete' } };
        if (scenario === 'branded-list-skills' || scenario === 'branded-missing-prefix') return { skills: brandedSkills };
        if (scenario === 'branded-required') return {
          skills: { name: 'archestra_staging__list_skills', inputSchema: { type: 'object', required: ['name'] } },
          hint: { name: 'archestra_staging__execute_remedy_plan', inputSchema: emptySchema, annotations: { readOnlyHint: true } },
        };
        if (scenario === 'branded-collision') return {
          model: { name: 'mcp__archestra_staging__archestra_staging__list_skills', inputSchema: emptySchema },
          suffix: { name: 'archestra_staging__list_skills_extra', inputSchema: emptySchema },
          serverish: { name: 'selected-gateway__list_skills', inputSchema: emptySchema },
          side: { name: 'archestra_staging__execute_remedy_plan', inputSchema: emptySchema, annotations: { readOnlyHint: true } },
          skills: brandedSkills,
        };
        if (scenario === 'branded-wrong-server') return { serverish: { name: 'selected-gateway__list_skills', inputSchema: emptySchema } };
        const canonical = {
          whoami: { name: 'archestra__whoami', inputSchema: emptySchema },
          policy: { name: 'archestra__get_guardrails_policy', inputSchema: emptySchema },
          skills: { name: 'archestra__list_skills', inputSchema: emptySchema },
          serverish: { name: 'selected-gateway__whoami', inputSchema: emptySchema },
        };
        if (scenario === 'branded-canonical-only') return canonical;
        if (scenario === 'branded-mixed-whoami') return { ...canonical, branded: { name: 'archestra_staging__whoami', inputSchema: emptySchema } };
        if (scenario === 'branded-mixed-policy') return { ...canonical, branded: { name: 'archestra_staging__get_guardrails_policy', inputSchema: emptySchema } };
        if (scenario === 'branded-mixed-skills') return { ...canonical, branded: { name: 'archestra_staging__list_skills', inputSchema: emptySchema } };
        return { policy: { name: 'archestra__get_guardrails_policy', inputSchema: emptySchema } };
      };
      if (scenario === 'branded-wrong-server') return reply({ data: [{ name: 'other-gateway', tools: { skills: brandedSkills } }, { name: 'selected-gateway', tools: selectedTools() }], nextCursor: null });
      return reply({ data: [{ name: 'selected-gateway', tools: selectedTools() }], nextCursor: null });
    }
    case 'mcpServer/tool/call':
      if (scenario === 'early-exit') return process.exit(1);
      if (scenario === 'approval') return send({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: { message: 'Approve?' } });
      return reply({ isError: scenario === 'gateway-error', content: [{ type: 'text', text: 'PRIVATE GATEWAY CONTENT' }] });
    case 'turn/start': {
      const context = { threadId: 'verification-thread', turnId: 'verification-turn' };
      const started = () => reply({ turn: scenario === 'missing-turn' ? {} : { id: 'verification-turn' } });
      if (scenario !== 'early-events') started();
      if (scenario === 'foreign-events') {
        send({ method: 'turn/completed', params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'failed' } } });
        send({ method: 'item/started', params: { threadId: 'verification-thread', turnId: 'old-turn', item: { type: 'commandExecution' } } });
        send({ method: 'turn/completed', params: { threadId: 'verification-thread', turn: { id: 'old-turn', status: 'failed' } } });
      }
      if (scenario === 'shell-attempt') return send({ method: 'item/started', params: { ...context, item: { type: 'commandExecution', command: 'Write-Output test' } } });
      if (scenario !== 'no-reply') send({ method: 'item/completed', params: { ...context, item: { type: 'agentMessage', text: 'PRIVATE MODEL CONTENT' } } });
      const error = { message: 'Missing scopes: api.responses.write. Bearer fixture-credential-secret' };
      if (scenario === 'last-error') send({ method: 'error', params: { ...context, error, willRetry: false } });
      send({ method: 'turn/completed', params: { threadId: context.threadId, turn: { id: context.turnId, status: ['inference-error', 'last-error'].includes(scenario) ? 'failed' : 'completed', ...(scenario === 'inference-error' ? { error } : {}) } } });
      if (scenario === 'early-events') started();
      return;
    }
  }
});
`,
      { mode: 0o700 },
    );
    const toolPrefix =
      scenario === "invalid-tool-prefix"
        ? "selected-gateway"
        : scenario.startsWith("branded-") &&
            scenario !== "branded-missing-prefix"
          ? "archestra_staging__"
          : undefined;
    const options = Buffer.from(
      JSON.stringify({
        server: "selected-gateway",
        provider: "selected-proxy",
        ...(toolPrefix ? { toolPrefix } : {}),
      }),
    ).toString("base64");
    let command = runtime === "powershell" ? "pwsh" : process.execPath;
    let args =
      runtime === "powershell"
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            windowsHelper,
            "-CodexPath",
            binary,
            "-OptionsBase64",
            options,
          ]
        : [helper, "--verify", binary, options];
    if (printed) {
      const windows = runtime === "powershell";
      const script = renderSetupScript({
        appName: "Archestra",
        clientId: "codex",
        platform: windows ? "windows" : "linux",
        mcp: {
          serverName: "selected-gateway",
          url: "https://example.test/v1/mcp/gateway",
        },
        toolPrefix:
          scenario === "branded-list-skills"
            ? "archestra_staging__"
            : undefined,
        proxy: null,
        skills: null,
      });
      const verify = script.match(/Verification command: ([^\n]+)/)?.[1];
      if (!verify) throw new Error("missing printed verification command");
      const installed = path.join(
        directory,
        `${
          windows
            ? CODEX_GUARD_CLIENT.psScriptRelpath
            : CODEX_GUARD_CLIENT.scriptRelpath
        }${windows ? ".verify.ps1" : ".handoff.cjs"}`,
      );
      await mkdir(path.dirname(installed), { recursive: true });
      await writeFile(
        installed,
        windows ? CODEX_CONNECTION_VERIFICATION_WINDOWS : CODEX_HANDOFF_HELPER,
      );
      command = windows ? "pwsh" : "bash";
      args = windows
        ? ["-NoProfile", "-NonInteractive", "-Command", verify]
        : ["-c", verify];
    }
    const result = await exec(command, args, {
      env: {
        ...process.env,
        CODEX_HOME: directory,
        HOME: directory,
        USERPROFILE: directory,
        PATH: directory + path.delimiter + process.env.PATH,
        CODEX_SANDBOX_NETWORK_DISABLED: "1",
        ...(scenario === "originator-override"
          ? { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_cli_rs" }
          : {}),
        ...(scenario === "node-pipe-denied"
          ? { NODE_OPTIONS: `--require ${JSON.stringify(spawnFault)}` }
          : {}),
      },
      timeout: 10_000,
    }).then(
      (value) => ({ ...value, code: 0 }),
      (error) => ({
        stdout: String(error.stdout),
        stderr: String(error.stderr),
        code: error.code,
      }),
    );
    const requests = (
      await readFile(calls, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      })
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (scenario === "node-pipe-denied" && runtime === "node") {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("EPERM");
      expect(result.stderr).toContain("executable");
      expect(requests).toEqual([]);
      expect(await readFile(config, "utf8")).toBe(original);
      return;
    }
    if (scenario === "invalid-tool-prefix") {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Invalid Codex verification options.");
      expect(requests).toEqual([]);
      expect(result.stdout).not.toContain('"verified"');
      return;
    }
    expect(requests[0]).toEqual({
      argv: ["app-server"],
      network: "1",
      ...(scenario === "originator-override"
        ? { originatorOverride: ARCHESTRA_CODEX_CONNECTION_ORIGINATOR }
        : {}),
    });
    expect(
      isCodexOriginator(
        requests.find((request) => request.method === "initialize").params
          .clientInfo.name,
      ),
    ).toBe(true);
    expect(await readFile(config, "utf8")).toBe(original);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE");
    expect(result.stdout + result.stderr).not.toContain(
      "fixture-credential-secret",
    );
    const started = requests.find(
      (request) => request.method === "thread/start",
    );
    if (
      ![
        "wrong-provider",
        "init-exit",
        "init-payload",
        "rpc-error",
        "rpc-payload",
        "rpc-ansi-payload",
      ].includes(scenario)
    )
      expect(started.params).toEqual({ cwd: process.cwd(), ephemeral: true });
    if (
      [
        "success",
        "originator-override",
        "early-events",
        "foreign-events",
        "npm-shim",
        "node-pipe-denied",
        "branded-list-skills",
        "branded-collision",
        "branded-mixed-whoami",
        "branded-mixed-policy",
        "branded-mixed-skills",
      ].includes(scenario)
    ) {
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        gateway: "verified",
        proxy: printed ? "not-selected" : "verified",
      });
      expect(
        requests.find((request) => request.method === "mcpServer/tool/call")
          .params,
      ).toEqual({
        threadId: "verification-thread",
        server: "selected-gateway",
        tool:
          {
            "branded-list-skills": "archestra_staging__list_skills",
            "branded-collision": "archestra_staging__list_skills",
            "branded-mixed-whoami": "archestra_staging__whoami",
            "branded-mixed-policy": "archestra_staging__get_guardrails_policy",
            "branded-mixed-skills": "archestra_staging__list_skills",
          }[scenario] ?? "archestra__get_guardrails_policy",
        arguments: {},
      });
      expect(
        requests.filter((request) => request.method === "mcpServer/tool/call"),
      ).toHaveLength(1);
      const turn = requests.find((request) => request.method === "turn/start");
      if (printed) expect(turn).toBeUndefined();
      else
        expect(Object.keys(turn.params).sort()).toEqual(["input", "threadId"]);
    } else {
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain('"verified"');
      if (
        [
          "gateway-error",
          "no-safe-tool",
          "wrong-provider",
          "wrong-thread-provider",
          "repeated-cursor",
          "approval",
          "early-exit",
          "init-exit",
          "init-payload",
          "rpc-error",
          "rpc-payload",
          "rpc-ansi-payload",
          "branded-missing-prefix",
          "branded-wrong-server",
          "branded-required",
          "branded-canonical-only",
        ].includes(scenario)
      ) {
        expect(
          requests.some((request) => request.method === "turn/start"),
        ).toBe(false);
      }
      if (scenario === "approval")
        expect(
          requests.find((request) => request.id === "approval-1"),
        ).toMatchObject({ error: { code: -32601 } });
      if (scenario === "init-exit") {
        expect(result.stderr).toContain("exit 78");
        expect(result.stderr).toContain("read-only file system");
      }
      if (scenario === "init-payload") {
        expect(result.stderr).toContain("exit 79");
        expect(result.stderr).toContain("diagnostic omitted");
      }
      if (["inference-error", "last-error"].includes(scenario))
        expect(result.stderr).toContain("Missing scopes: api.responses.write");
      if (scenario === "rpc-error")
        expect(result.stderr).toContain("Configuration unavailable");
      if (["rpc-payload", "rpc-ansi-payload"].includes(scenario))
        expect(result.stderr).toContain("diagnostic payload omitted");
      if (
        [
          "branded-missing-prefix",
          "branded-wrong-server",
          "branded-required",
          "branded-canonical-only",
        ].includes(scenario)
      ) {
        expect(result.stderr).toContain(
          "no supported read-only verification tool",
        );
        expect(
          requests.some((request) => request.method === "mcpServer/tool/call"),
        ).toBe(false);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("printed verification options use the branding prefix, not the client server name", () => {
  const toolPrefix = getArchestraToolPrefix({
    appName: "Archestra Staging",
    fullWhiteLabeling: true,
  });
  expect(toolPrefix).toBe("archestra_staging__");
  expect(
    getArchestraToolPrefix({
      appName: "Archestra Staging",
      fullWhiteLabeling: false,
    }),
  ).toBe(ARCHESTRA_TOOL_PREFIX);
  const context = {
    appName: "Archestra Staging",
    clientId: "codex" as const,
    mcp: {
      serverName: "renamed_gateway",
      url: "https://example.test/v1/mcp/gateway",
    },
    proxy: null,
    skills: null,
    toolPrefix,
  };
  const linux = renderSetupScript({ ...context, platform: "linux" });
  const linuxEncoded = linux.match(
    /--verify "\$\(command -v codex\)" '([^']+)'/,
  )?.[1];
  expect(
    JSON.parse(Buffer.from(linuxEncoded ?? "", "base64").toString()),
  ).toEqual({
    server: "renamed_gateway",
    toolPrefix: "archestra_staging__",
  });
  const windows = renderSetupScript({ ...context, platform: "windows" });
  const windowsEncoded = windows.match(/-OptionsBase64 '([^']+)'/)?.[1];
  expect(
    JSON.parse(Buffer.from(windowsEncoded ?? "", "base64").toString()),
  ).toEqual({
    server: "renamed_gateway",
    toolPrefix: "archestra_staging__",
  });
  const canonical = renderSetupScript({
    ...context,
    platform: "linux",
    toolPrefix: ARCHESTRA_TOOL_PREFIX,
  });
  const canonicalEncoded = canonical.match(
    /--verify "\$\(command -v codex\)" '([^']+)'/,
  )?.[1];
  expect(
    JSON.parse(Buffer.from(canonicalEncoded ?? "", "base64").toString()),
  ).toEqual({ server: "renamed_gateway" });
});
