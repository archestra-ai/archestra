import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const exec = promisify(execFile);
const IMAGE_BIN = path.resolve(
  import.meta.dirname,
  "../../../../docker_images/agent/bin",
);
const SECRETS = {
  OPENAI_API_KEY: "synthetic-virtual-key",
  ARCHESTRA_MCP_GATEWAY_TOKEN: "synthetic-gateway-token",
  ARCHESTRA_AGENT_RUNTIME_BINDING: "synthetic-runtime-binding",
};
const GATEWAY_FAILURE =
  "The Agent could not load its MCP gateway tools. Check gateway availability and access, then retry.\n";

describe("Kimi Code image entrypoint", () => {
  test("writes a credential-free Kimi config and runs delegated work in the native TUI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const { bin, runtime, state } = await prepare(root);
      await exec("bash", [path.join(bin, "archestra-kimi")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_STATE_DIR: state,
          ARCHESTRA_AGENT_RUNTIME_MODEL_PROVIDER: "kimi",
          ARCHESTRA_AGENT_RUNTIME_MODEL_CONTEXT_LENGTH: "262144",
          ARCHESTRA_AGENT_RUNTIME_MODEL_OUTPUT_LENGTH: "32768",
          ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT: "Follow the team rules.",
        }),
      });

      // The TUI stays in the pane, so terminal steering reaches the turn.
      expect(
        (await readFile(path.join(runtime, "started"), "utf8")).split("\n"),
      ).toEqual([
        "archestra-tui-run",
        path.join(runtime, "turn-complete"),
        path.join(runtime, "final-answer.txt"),
        path.join(bin, "archestra-kimi-tui-start"),
        "kimi",
        "--auto",
        "",
      ]);
      const home = path.join(state, "kimi");
      const config = await readToml(path.join(home, "config.toml"));
      expect(config).toMatchObject({
        default_model: "archestra",
        default_permission_mode: "auto",
        telemetry: false,
        providers: {
          archestra: {
            type: "kimi",
            base_url: "http://platform:9000/v1/model-router/agent",
            api_key_env: "OPENAI_API_KEY",
            custom_headers: {
              "X-Archestra-Run-Id": "task-1",
              "X-Archestra-Session-Id": "workspace-1",
              "X-Appa-Session-ID": "workspace-1",
            },
          },
        },
        models: {
          archestra: {
            provider: "archestra",
            model: "k3.1-pro",
            max_context_size: 262144,
            max_output_size: 32768,
            // K3.1 Pro refuses a request with thinking disabled.
            capabilities: ["tool_use", "thinking", "always_thinking"],
          },
        },
      });
      const hooks = config.hooks as { event: string; command: string }[];
      expect(hooks.map((hook) => hook.event)).toEqual(
        expect.arrayContaining([
          "SessionStart",
          "UserPromptSubmit",
          "PermissionRequest",
          "Stop",
          "StopFailure",
          "Interrupt",
        ]),
      );
      expect(hooks[0].command).toBe(
        `${path.join(bin, "archestra-kimi-hook")} SessionStart`,
      );
      expect(await readToml(path.join(home, "tui.toml"))).toMatchObject({
        auto_session_title: false,
        disable_feedback_survey: true,
        upgrade: { auto_install: false },
      });
      expect(
        JSON.parse(await readFile(path.join(home, "mcp.json"), "utf8")),
      ).toEqual({
        mcpServers: {
          archestra: {
            command: path.join(bin, "archestra-kimi-mcp"),
            startupTimeoutMs: 30000,
            toolTimeoutMs: 600000,
          },
        },
      });
      expect(await readFile(path.join(home, "AGENTS.md"), "utf8")).toContain(
        "Follow the team rules.",
      );
      // The binding reaches the proxy through Kimi's header variable only.
      expect(await readFile(path.join(runtime, "env"), "utf8")).toBe(
        [
          "KIMI_CODE_CUSTOM_HEADERS=X-Archestra-Runtime-Binding: synthetic-runtime-binding",
          `KIMI_CODE_HOME=${home}`,
          "KIMI_CODE_NO_AUTO_UPDATE=1",
          "KIMI_CODE_TRUST_WORKSPACE=1",
          "",
        ].join("\n"),
      );

      // No credential reaches a file Kimi or the workspace can read later.
      for (const file of await filesUnder(home)) {
        expect((await stat(file)).mode & 0o777, file).toBe(0o600);
        const content = await readFile(file, "utf8");
        for (const secret of Object.values(SECRETS)) {
          expect(content, file).not.toContain(secret);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses the plain OpenAI provider type, a default context size and no binding for other providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const { bin, runtime } = await prepare(root);
      await exec("bash", [path.join(bin, "archestra-kimi")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_MODEL_PROVIDER: "openai",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "gpt-4.1",
          ARCHESTRA_AGENT_RUNTIME_OPENAPPA: "0",
          ARCHESTRA_AGENT_RUNTIME_BINDING: "",
        }),
      });
      const config = await readToml(path.join(runtime, "kimi", "config.toml"));
      const providers = config.providers as Record<string, unknown>;
      const models = config.models as Record<string, Record<string, unknown>>;
      expect(providers.archestra).toMatchObject({ type: "openai" });
      // Kimi refuses a model without a context size.
      expect(models.archestra.max_context_size).toBe(131072);
      expect(models.archestra).not.toHaveProperty("max_output_size");
      expect(models.archestra).not.toHaveProperty("capabilities");
      expect(await readFile(path.join(runtime, "env"), "utf8")).not.toContain(
        "KIMI_CODE_CUSTOM_HEADERS",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    { model: "k3.1-pro-highspeed", thinking: ["thinking", "always_thinking"] },
    { model: "kimi-k3.1-pro", thinking: ["thinking", "always_thinking"] },
    { model: "k3-256k", thinking: ["thinking"] },
    { model: "kimi-for-coding", thinking: ["thinking"] },
    { model: "kimi-k2-thinking", thinking: ["thinking"] },
    { model: "moonshot-v1-8k", thinking: [] },
  ])("declares the thinking support of the Kimi model $model", async ({
    model,
    thinking,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const { bin, runtime } = await prepare(root);
      await exec("bash", [path.join(bin, "archestra-kimi")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_MODEL_PROVIDER: "kimi",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: model,
        }),
      });
      const config = await readToml(path.join(runtime, "kimi", "config.toml"));
      const models = config.models as Record<string, Record<string, unknown>>;
      expect(models.archestra.capabilities).toEqual(["tool_use", ...thinking]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes non-ASCII config values as literal TOML text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const { bin, runtime } = await prepare(root);
      const model = "kimí 🚀";
      await exec("bash", [path.join(bin, "archestra-kimi")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: model,
          ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID: "werkstätte",
        }),
      });
      const configPath = path.join(runtime, "kimi", "config.toml");
      // JSON would write the emoji as a UTF-16 surrogate pair, which TOML
      // rejects; the value must survive a TOML parser unchanged.
      expect(await readFile(configPath, "utf8")).toContain(
        `model = "${model}"`,
      );
      const config = await readToml(configPath);
      const models = config.models as Record<string, Record<string, unknown>>;
      const providers = config.providers as Record<
        string,
        Record<string, Record<string, string>>
      >;
      expect(models.archestra.model).toBe(model);
      expect(providers.archestra.custom_headers["X-Appa-Session-ID"]).toBe(
        "werkstätte",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs plain delegated work in print mode, without a terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const { bin, runtime } = await prepare(root);
      await exec("bash", [path.join(bin, "archestra-kimi")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_PLAIN: "1",
        }),
      });
      // Print mode always auto-approves and refuses --auto.
      expect(await readFile(path.join(runtime, "started"), "utf8")).toBe(
        "archestra-kimi-print\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a missing kimi CLI before starting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const { bin, runtime } = await prepare(root);
      const result = await exec("bash", [path.join(bin, "archestra-kimi")], {
        cwd: root,
        env: {
          ...runtimeEnv({ root, mode: "one_shot" }),
          PATH: process.env.PATH,
        },
      }).catch((error) => error);
      expect(result.code).toBe(78);
      expect(
        JSON.parse(await readFile(path.join(runtime, "turn.failure"), "utf8")),
      ).toMatchObject({ version: 1, code: "kimi_missing" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    "present",
    "missing",
  ])("resumes only the recorded session (%s marker)", async (marker) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const { bin, runtime } = await prepare(root);
      if (marker === "present") {
        await writeFile(path.join(runtime, "kimi-main-session"), "session_1\n");
      }
      const result = await exec("bash", [path.join(bin, "archestra-kimi")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "interactive",
          ARCHESTRA_AGENT_RUNTIME_CONTINUE: "1",
          ARCHESTRA_AGENT_RUNTIME_TASK: "",
        }),
      }).catch((error) => error);

      if (marker === "present") {
        expect(
          (await readFile(path.join(runtime, "started"), "utf8")).split("\n"),
        ).toEqual([
          "archestra-kimi-tui-start",
          "kimi",
          "--yolo",
          "--session",
          "session_1",
          "",
        ]);
      } else {
        expect(result.code).toBe(78);
        expect(result.stderr).toContain(
          "Cannot resume the saved Kimi Code session",
        );
        await expect(
          readFile(path.join(runtime, "started"), "utf8"),
        ).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kimi Code MCP gateway bridge", () => {
  test("relays Kimi's requests with the run headers and records the loaded catalog", async () => {
    const requests: { headers: IncomingHttpHeaders; body: JsonRpc }[] = [];
    const gateway = await startGateway((body) => {
      if (body.method === "tools/list") {
        return {
          tools: ["archestra__get_remedy_plans", "github__list_repos"].map(
            (name) => ({ name, description: `[[gwa1_x.y]]\n${name}` }),
          ),
        };
      }
      if (body.method === "tools/call") {
        return { content: [{ type: "text", text: "TOOL_OK" }] };
      }
      return { protocolVersion: "2025-03-26", capabilities: {} };
    }, requests);
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const bridge = startBridge(root, gateway.url);
      const initialize = await bridge.request({ method: "initialize" });
      expect(await gatewayState(root)).toBe("pending");
      const listed = await bridge.request({ method: "tools/list" });
      const called = await bridge.request({
        method: "tools/call",
        params: { name: "archestra__get_remedy_plans", arguments: {} },
      });
      bridge.close();

      expect(initialize.result).toMatchObject({ capabilities: {} });
      // Names and descriptions, attestation markers included, pass unchanged.
      expect(listed.result).toEqual({
        tools: [
          {
            name: "archestra__get_remedy_plans",
            description: "[[gwa1_x.y]]\narchestra__get_remedy_plans",
          },
          {
            name: "github__list_repos",
            description: "[[gwa1_x.y]]\ngithub__list_repos",
          },
        ],
      });
      expect(called.result).toEqual({
        content: [{ type: "text", text: "TOOL_OK" }],
      });
      expect(await gatewayState(root)).toBe("ready 2");
      expect(requests.map(({ body }) => body.method)).toEqual([
        "initialize",
        "tools/list",
        "tools/call",
      ]);
      for (const { headers } of requests) {
        expect(headers).toMatchObject({
          authorization: "Bearer synthetic-gateway-token",
          "x-archestra-run-id": "task-1",
          "x-archestra-session-id": "workspace-1",
          "x-appa-session-id": "workspace-1",
          "x-archestra-runtime-binding": "synthetic-runtime-binding",
        });
      }
    } finally {
      await gateway.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "a JSON-RPC error", status: 200 },
    { name: "an HTTP rejection without a JSON-RPC answer", status: 401 },
  ])("records a failed catalog when tools/list returns $name", async ({
    status,
  }) => {
    const gateway = await startGateway(
      (body) =>
        body.method === "tools/list"
          ? status === 200
            ? { error: { code: -32603, message: "Synthetic failure" } }
            : { status, body: { error: "unauthorized" } }
          : { protocolVersion: "2025-03-26", capabilities: {} },
      [],
    );
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const bridge = startBridge(root, gateway.url);
      await bridge.request({ method: "initialize" });
      const listed = await bridge.request({ method: "tools/list" });
      bridge.close();
      // Kimi still receives an answer, so it never hangs on the request.
      expect(listed.error).toBeDefined();
      expect(await gatewayState(root)).toBe("failed");
    } finally {
      await gateway.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kimi Code prompt gate", () => {
  test.each([
    { state: { state: "ready", tools: 3 }, openappa: "1", allowed: true },
    { state: { state: "ready", tools: 0 }, openappa: "0", allowed: true },
    { state: { state: "ready", tools: 0 }, openappa: "1", allowed: false },
    { state: { state: "failed", tools: 0 }, openappa: "0", allowed: false },
  ])("decides a delegated prompt for $state (OpenAPPA $openappa)", async ({
    state,
    openappa,
    allowed,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = path.join(root, "runtime");
      await mkdir(runtime);
      await writeFile(
        path.join(runtime, "kimi-gateway-state.json"),
        JSON.stringify(state),
      );
      const result = await runHook(
        root,
        "UserPromptSubmit",
        { session_id: "s-1", prompt: [{ type: "text", text: "Work." }] },
        { ARCHESTRA_AGENT_RUNTIME_OPENAPPA: openappa },
      );
      if (allowed) {
        expect(result.code).toBe(0);
        await expect(
          stat(path.join(runtime, "turn.failure")),
        ).rejects.toThrow();
        return;
      }
      // Exit 2 is Kimi's block: the prompt never reaches the model.
      expect(result.code).toBe(2);
      expect(
        JSON.parse(await readFile(path.join(runtime, "turn.failure"), "utf8")),
      ).toMatchObject({ version: 1, code: "mcp_startup" });
      expect(
        await readFile(path.join(runtime, "final-answer.txt"), "utf8"),
      ).toBe(GATEWAY_FAILURE);
      await expect(
        stat(path.join(runtime, "turn-complete.failed")),
      ).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves a blocked plain prompt for the print-mode driver to report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = path.join(root, "runtime");
      await mkdir(runtime);
      await writeFile(
        path.join(runtime, "kimi-gateway-state.json"),
        JSON.stringify({ state: "failed" }),
      );
      const result = await runHook(
        root,
        "UserPromptSubmit",
        { session_id: "s-1" },
        { ARCHESTRA_AGENT_RUNTIME_PLAIN: "1" },
      );
      expect(result.code).toBe(2);
      await expect(
        stat(path.join(runtime, "kimi-gateway-blocked")),
      ).resolves.toBeTruthy();
      await expect(stat(path.join(runtime, "turn.failure"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kimi Code turn hooks", () => {
  // Payloads and session records as Kimi Code 2.3.3 writes them.
  test.each([
    // Kimi awaits the Stop hook before it records turn.ended, so these
    // records end at the last step (measured, review round 1).
    {
      name: "a completed turn",
      event: "Stop",
      payload: { stop_hook_active: false },
      ending: stepEnded("end_turn"),
      answer: "The tests pass.\n",
      failure: undefined,
    },
    {
      name: "a turn cut off by the output limit",
      event: "Stop",
      payload: { stop_hook_active: false },
      ending: stepEnded("max_tokens"),
      answer: "Kimi Code stopped because the model reached its output limit.\n",
      failure: "kimi_turn_failed",
    },
    {
      name: "a provider error",
      event: "StopFailure",
      payload: {
        error_type: "APIStatusError",
        error_message: "400 synthetic upstream failure",
      },
      ending: failedTurn("provider.api_error", 400),
      answer:
        "The model provider refused the request. Check the configured provider credential and the selected model, then start the task again.\n",
      failure: "kimi_turn_failed",
    },
    {
      name: "a response the provider filtered",
      event: "StopFailure",
      payload: {
        error_type: "ProviderFilteredError",
        error_message: "Provider safety policy blocked the response.",
      },
      ending: failedTurn("provider.filtered"),
      answer:
        "The model provider blocked the response, so the turn did not complete.\n",
      failure: "kimi_turn_failed",
    },
    {
      name: "a cancelled turn",
      event: "Interrupt",
      payload: { reason: "cancelled" },
      ending: [{ type: "turn.ended", reason: "cancelled" }],
      answer: "The Kimi Code turn was cancelled before it completed.\n",
      failure: "kimi_turn_failed",
    },
  ])("settles a delegated terminal turn after $name", async ({
    event,
    payload,
    ending,
    answer,
    failure,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = await sessionWithAnswer(root, "s-1", ending);
      const result = await runHook(root, event, {
        session_id: "s-1",
        ...payload,
      });

      expect(result.code).toBe(0);
      expect(
        await readFile(path.join(runtime, "final-answer.txt"), "utf8"),
      ).toBe(answer);
      await expect(
        stat(path.join(runtime, "turn-complete")),
      ).resolves.toBeTruthy();
      const transcript = JSON.parse(
        await readFile(path.join(runtime, "readable-transcript.json"), "utf8"),
      );
      expect(transcript.entries.at(-1).text).toBe("The tests pass.");
      if (failure) {
        expect(
          JSON.parse(
            await readFile(path.join(runtime, "turn.failure"), "utf8"),
          ),
        ).toMatchObject({ version: 1, code: failure });
        await expect(
          stat(path.join(runtime, "turn-complete.failed")),
        ).resolves.toBeTruthy();
      } else {
        await expect(
          stat(path.join(runtime, "turn-complete.failed")),
        ).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    { code: "provider.api_error", status: 503, failure: "kimi_unavailable" },
    { code: "provider.api_error", status: null, failure: "kimi_unavailable" },
    {
      code: "provider.connection_error",
      status: null,
      failure: "kimi_unavailable",
    },
    { code: "provider.rate_limit", status: 429, failure: "kimi_unavailable" },
    { code: "provider.overloaded", status: 529, failure: "kimi_unavailable" },
    { code: "provider.auth_error", status: 401, failure: "kimi_turn_failed" },
    { code: "context.overflow", status: null, failure: "kimi_turn_failed" },
    {
      code: "loop.max_steps_exceeded",
      status: null,
      failure: "kimi_turn_failed",
    },
  ])("classifies a failed turn's $code ($status) as $failure", async ({
    code,
    status,
    failure,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = await sessionWithAnswer(
        root,
        "s-1",
        failedTurn(code, status),
      );
      // Every coded Kimi error carries the same generic name.
      await runHook(root, "StopFailure", {
        session_id: "s-1",
        error_type: "Error2",
      });
      expect(
        JSON.parse(await readFile(path.join(runtime, "turn.failure"), "utf8")),
      ).toMatchObject({ version: 1, code: failure });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("waits for the turn's recorded end before classifying a failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      // Kimi fires StopFailure first and records turn.ended a moment later.
      const runtime = await sessionWithAnswer(root, "s-1", []);
      const hook = runHook(root, "StopFailure", {
        session_id: "s-1",
        error_type: "Error2",
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await writeSession(root, "s-1", [
        ...answeredTurn(),
        ...failedTurn("context.overflow"),
      ]);
      await hook;
      expect(
        await readFile(path.join(runtime, "final-answer.txt"), "utf8"),
      ).toBe(
        "Kimi Code stopped because the conversation exceeded the model's context window.\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      event: "PermissionRequest",
      payload: {},
      attention: "set Permission needed",
    },
    {
      event: "PreToolUse",
      payload: { tool_name: "AskUserQuestion" },
      attention: "set Input requested",
    },
    { event: "PermissionResult", payload: {}, attention: "clear" },
    { event: "TurnStarted", payload: {}, attention: "clear" },
    { event: "StopFailure", payload: {}, attention: "set Waiting for input" },
  ])("reports $event to Agent Runtime in an interactive session", async ({
    event,
    payload,
    attention,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = await sessionWithAnswer(
        root,
        "s-1",
        completedTurn("end_turn"),
      );
      const recorder = await attentionRecorder(root, runtime);
      await runHook(
        root,
        event,
        { session_id: "s-1", ...payload },
        {
          ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
          ARCHESTRA_AGENT_ATTENTION_COMMAND: recorder,
        },
      );
      expect(await readFile(path.join(runtime, "attention.log"), "utf8")).toBe(
        `${attention}\n`,
      );
      // An interactive turn stays open for the person in the terminal.
      await expect(stat(path.join(runtime, "turn-complete"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "another session", sessionId: "other", plain: "0" },
    {
      name: "a plain run, which the print-mode driver settles",
      sessionId: "s-1",
      plain: "1",
    },
  ])("leaves the turn alone for $name", async ({ sessionId, plain }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = await sessionWithAnswer(
        root,
        "s-1",
        completedTurn("end_turn"),
      );
      await runHook(
        root,
        "Stop",
        { session_id: sessionId },
        { ARCHESTRA_AGENT_RUNTIME_PLAIN: plain },
      );
      for (const file of [
        "turn-complete",
        "final-answer.txt",
        "readable-transcript.json",
      ]) {
        await expect(stat(path.join(runtime, file))).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records only the first session as the run's main session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = path.join(root, "runtime");
      await mkdir(runtime);
      await runHook(root, "SessionStart", { session_id: "main" });
      await runHook(root, "SessionStart", { session_id: "later" });
      expect(
        await readFile(path.join(runtime, "kimi-main-session"), "utf8"),
      ).toBe("main\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kimi Code readable transcript", () => {
  test("keeps prompts, steers, text and gateway tool activity, not reasoning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const longTool = `github__${"search_".repeat(10)}issues`;
      const runtime = await writeSession(root, "s-1", [
        {
          type: "mcp.tools_discovered",
          serverName: "archestra",
          tools: [{ name: "archestra__get_remedy_plans" }, { name: longTool }],
        },
        {
          type: "turn.prompt",
          input: [{ type: "text", text: "Fix the build." }],
          origin: { kind: "user" },
          time: 1_793_000_000_000,
        },
        // Harness reminders are context, not something the person said.
        {
          type: "context.append_message",
          message: {
            role: "user",
            content: [{ type: "text", text: "<system-reminder>x" }],
          },
        },
        loopEvent({
          type: "content.part",
          part: { type: "think", think: "private" },
        }),
        loopEvent({
          type: "content.part",
          part: { type: "text", text: "Checking " },
        }),
        loopEvent({
          type: "content.part",
          part: { type: "text", text: "the plans." },
        }),
        loopEvent({
          type: "tool.call",
          toolCallId: "call-1",
          name: "mcp__archestra__archestra_get_remedy_plans",
          args: { tool: "Bash" },
        }),
        loopEvent({
          type: "tool.result",
          toolCallId: "call-1",
          result: { output: "No plan.", isError: true },
        }),
        {
          type: "turn.steer",
          input: [{ type: "text", text: "Also update the docs." }],
          origin: { kind: "user", inTurn: true },
        },
        loopEvent({
          type: "tool.call",
          toolCallId: "call-2",
          // Kimi shortens a qualified name past 64 characters with a hash;
          // computed by Kimi's own qualifyMcpToolName for this tool.
          name: "mcp__archestra__github_search_search_search_search_sea_-43bc94f6",
          args: {},
        }),
        loopEvent({
          type: "tool.result",
          toolCallId: "call-2",
          result: { output: { items: [] } },
        }),
        loopEvent({
          type: "content.part",
          part: { type: "text", text: "Done." },
        }),
        ...completedTurn("end_turn"),
      ]);
      const answer = path.join(root, "answer.txt");
      const { stdout } = await exec(
        "python3",
        [
          path.join(IMAGE_BIN, "archestra-kimi-transcript"),
          "s-1",
          "--answer",
          answer,
          "--outcome",
        ],
        { env: transcriptEnv(root) },
      );

      expect(stdout).toBe("completed end_turn\n");
      expect(await readFile(answer, "utf8")).toBe("Done.\n");
      const transcript = JSON.parse(
        await readFile(path.join(runtime, "readable-transcript.json"), "utf8"),
      );
      expect(transcript).toMatchObject({ version: 1, provider: "kimi" });
      expect(transcript.entries).toEqual([
        {
          type: "message",
          role: "user",
          text: "Fix the build.",
          timestamp: "2026-10-26T07:33:20.000Z",
        },
        { type: "message", role: "assistant", text: "Checking the plans." },
        {
          type: "tool_call",
          name: "archestra__get_remedy_plans",
          toolCallId: "call-1",
          input: '{"tool":"Bash"}',
        },
        {
          type: "tool_result",
          text: "No plan.",
          toolCallId: "call-1",
          isError: true,
        },
        { type: "message", role: "user", text: "Also update the docs." },
        {
          type: "tool_call",
          name: longTool,
          toolCallId: "call-2",
          input: "{}",
        },
        { type: "tool_result", text: '{"items":[]}', toolCallId: "call-2" },
        { type: "message", role: "assistant", text: "Done." },
      ]);
      expect(JSON.stringify(transcript)).not.toContain("private");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes a placeholder answer and the outcome of the last turn only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      await writeSession(root, "s-1", [
        {
          type: "turn.prompt",
          input: [{ type: "text", text: "First." }],
          origin: { kind: "user" },
        },
        loopEvent({
          type: "content.part",
          part: { type: "text", text: "One." },
        }),
        ...failedTurn("provider.api_error"),
        {
          type: "turn.prompt",
          input: [{ type: "text", text: "Second." }],
          origin: { kind: "user" },
        },
        loopEvent({
          type: "tool.call",
          toolCallId: "c",
          name: "Bash",
          args: {},
        }),
        loopEvent({
          type: "tool.result",
          toolCallId: "c",
          result: { output: "" },
        }),
        ...completedTurn("end_turn"),
      ]);
      const answer = path.join(root, "answer.txt");
      const { stdout } = await exec(
        "python3",
        [
          path.join(IMAGE_BIN, "archestra-kimi-transcript"),
          "s-1",
          "--answer",
          answer,
          "--outcome",
        ],
        { env: transcriptEnv(root) },
      );
      expect(stdout).toBe("completed end_turn\n");
      expect(await readFile(answer, "utf8")).toBe(
        "The session ended without producing a final message.\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kimi Code print-mode driver", () => {
  test.each([
    {
      name: "a completed turn",
      exit: 0,
      ending: completedTurn("end_turn"),
      status: 0,
      failure: undefined,
    },
    {
      name: "a rejected credential",
      exit: 1,
      ending: failedTurn("provider.auth_error", 401),
      status: 1,
      failure: "kimi_turn_failed",
    },
    {
      name: "a rate-limited provider",
      exit: 1,
      ending: failedTurn("provider.rate_limit", 429),
      status: 1,
      failure: "kimi_unavailable",
    },
    {
      name: "an overflowing context",
      exit: 1,
      ending: failedTurn("context.overflow"),
      status: 1,
      failure: "kimi_turn_failed",
    },
    {
      name: "a turn cut off by the output limit",
      exit: 0,
      ending: completedTurn("max_tokens"),
      status: 1,
      failure: "kimi_turn_failed",
    },
  ])("settles $name", async ({ exit, ending, status, failure }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = path.join(root, "runtime");
      await fakeKimi(root, { exit, ending });
      const result = await runPrint(root);

      expect(result.code).toBe(status);
      // The session comes from Kimi's own stream when no hook recorded it.
      expect(
        await readFile(path.join(runtime, "kimi-main-session"), "utf8"),
      ).toBe("s-1\n");
      expect(
        JSON.parse(
          await readFile(path.join(runtime, "fake-kimi-args.json"), "utf8"),
        ),
      ).toEqual([
        "--session",
        "s-0",
        "-p",
        "Fix the failing test.",
        "--output-format",
        "stream-json",
      ]);
      if (failure) {
        expect(
          JSON.parse(
            await readFile(path.join(runtime, "turn.failure"), "utf8"),
          ),
        ).toMatchObject({ version: 1, code: failure });
        return;
      }
      expect(result.stdout).toContain(
        "===ARCHESTRA-FINAL-ANSWER===\nThe tests pass.\n===ARCHESTRA-FINAL-ANSWER-END===",
      );
      await expect(
        stat(path.join(runtime, "turn-complete")),
      ).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a prompt the gateway gate blocked as a startup failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = path.join(root, "runtime");
      await fakeKimi(root, {
        exit: 1,
        ending: [],
        blocked: true,
      });
      const result = await runPrint(root);
      expect(result.code).toBe(1);
      expect(
        JSON.parse(await readFile(path.join(runtime, "turn.failure"), "utf8")),
      ).toMatchObject({ version: 1, code: "mcp_startup" });
      expect(
        await readFile(path.join(runtime, "final-answer.txt"), "utf8"),
      ).toBe(GATEWAY_FAILURE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kimi Code session lookup", () => {
  test.each([
    "s-*",
    "s-?",
    "s-[1]",
    "../s-1",
    "a/b",
  ])("refuses the session id %s without touching any session", async (sessionId) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = await sessionWithAnswer(
        root,
        "s-1",
        stepEnded("end_turn"),
      );
      const result = await exec(
        "python3",
        [
          path.join(IMAGE_BIN, "archestra-kimi-transcript"),
          sessionId,
          "--outcome",
        ],
        { env: transcriptEnv(root) },
      ).catch((error) => error);
      expect(result.code).toBe(65);
      await expect(
        stat(path.join(runtime, "readable-transcript.json")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("finds the session under whichever project directory holds it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      await writeSession(root, "s-1", [
        ...answeredTurn(),
        ...completedTurn("end_turn"),
      ]);
      // Another project's session whose id starts the same way.
      const other = path.join(
        root,
        "runtime",
        "kimi",
        "sessions",
        "wd_other_9",
        "s-10",
        "agents",
        "main",
      );
      await mkdir(other, { recursive: true });
      await writeFile(
        path.join(other, "wire.jsonl"),
        JSON.stringify(failedTurn("provider.auth_error")[0]),
      );
      const { stdout } = await exec(
        "python3",
        [
          path.join(IMAGE_BIN, "archestra-kimi-transcript"),
          "s-1",
          "--outcome",
          "--failure",
          "end",
        ],
        { env: transcriptEnv(root) },
      );
      expect(stdout).toBe("completed end_turn\nnone\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kimi Code MCP gateway bridge lifetime", () => {
  test("answers discovery while tool calls wait, and exits when Kimi disconnects", async () => {
    const held: (() => void)[] = [];
    const gateway = await startGateway(
      (body) =>
        body.method === "tools/call"
          ? { hold: true }
          : body.method === "ping"
            ? {}
            : { tools: [] },
      [],
      held,
    );
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const bridge = startBridge(root, gateway.url);
      // Eight gateway calls wait on a person's review.
      for (let index = 0; index < 8; index++) {
        void bridge.request({
          method: "tools/call",
          params: { name: "archestra__ask_user", arguments: {} },
        });
      }
      await waitFor(() => held.length === 8);
      const ping = await bridge.request({ method: "ping" });
      expect(ping.result).toEqual({});

      bridge.close();
      const started = Date.now();
      const [code] = await once(bridge.child, "exit");
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      for (const release of held) release();
      await gateway.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kimi Code terminal starter", () => {
  test.each([
    { mode: "one_shot", running: true, steers: true },
    { mode: "one_shot", running: false, steers: false },
    { mode: "interactive", running: true, steers: false },
  ])("steers queued messages in $mode mode (turn running: $running)", async ({
    mode,
    running,
    steers,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-kimi-"));
    try {
      const runtime = path.join(root, "runtime");
      const shims = path.join(root, "shims");
      await mkdir(runtime);
      await mkdir(shims);
      if (running) await writeFile(path.join(runtime, "kimi-turn-running"), "");
      // tmux shows the queued-message hint; every call is recorded.
      await writeFile(
        path.join(shims, "tmux"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${runtime}/tmux.log"\n[ "$1" = capture-pane ] && printf '%s\\n' '│ > STEER' '  ↑ to edit · ctrl-s to steer immediately'\nexit 0\n`,
      );
      await writeFile(path.join(shims, "kimi"), "#!/bin/sh\nsleep 2\n");
      await chmod(path.join(shims, "tmux"), 0o755);
      await chmod(path.join(shims, "kimi"), 0o755);
      await exec(
        "python3",
        [path.join(IMAGE_BIN, "archestra-kimi-tui-start"), "kimi"],
        {
          env: {
            PATH: `${shims}${path.delimiter}${process.env.PATH}`,
            TMUX_PANE: "%1",
            ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
            ARCHESTRA_AGENT_RUNTIME_MODE: mode,
            // A restore without a task: only the watcher touches the pane.
            ARCHESTRA_AGENT_RUNTIME_TASK: "",
          },
        },
      );
      const calls = (
        await readFile(path.join(runtime, "tmux.log"), "utf8").catch(() => "")
      )
        .split("\n")
        .filter(Boolean);
      expect(calls.some((call) => call === "send-keys -t %1 C-s")).toBe(steers);
      if (!running) expect(calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Helpers
// =============================================================================

type JsonRpc = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: unknown;
};

/** The launcher with its native client stages replaced by recorders. */
async function prepare(root: string) {
  const bin = path.join(root, "bin");
  const runtime = path.join(root, "runtime");
  const state = path.join(root, "state");
  await Promise.all([mkdir(bin), mkdir(runtime), mkdir(state)]);
  for (const script of [
    "archestra-kimi",
    "archestra-kimi-hook",
    "archestra-kimi-mcp",
    "archestra-kimi-turn-failure",
    "archestra-agent-failure",
    "archestra-agent-instructions",
  ]) {
    await symlink(path.join(IMAGE_BIN, script), path.join(bin, script));
  }
  for (const stage of [
    "archestra-kimi-print",
    "archestra-kimi-tui-start",
    "archestra-tui-run",
  ]) {
    await writeFile(
      path.join(bin, stage),
      [
        "#!/bin/sh",
        `printf '%s\\n' "${stage}" "$@" > "$ARCHESTRA_AGENT_RUNTIME_DIR/started"`,
        // The environment the native client inherits from the launcher.
        `env | grep -E '^KIMI_CODE_(CUSTOM_HEADERS|TRUST_WORKSPACE|NO_AUTO_UPDATE|HOME)=' | LC_ALL=C sort > "$ARCHESTRA_AGENT_RUNTIME_DIR/env"`,
        "",
      ].join("\n"),
    );
    await chmod(path.join(bin, stage), 0o755);
  }
  // The launcher refuses to start without the kimi CLI on PATH.
  const native = path.join(root, "native");
  await mkdir(native);
  await writeFile(path.join(native, "kimi"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(native, "kimi"), 0o755);
  return { bin, runtime, state };
}

function runtimeEnv(
  params: { root: string; mode: string } & Record<string, string>,
) {
  const { root, mode, ...overrides } = params;
  return {
    PATH: `${path.join(root, "native")}${path.delimiter}${process.env.PATH}`,
    HOME: root,
    ...SECRETS,
    ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_chat",
    ARCHESTRA_AGENT_RUNTIME_DIR: path.join(root, "runtime"),
    ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(root, "runtime", "turn"),
    ARCHESTRA_AGENT_RUNTIME_MODE: mode,
    ARCHESTRA_AGENT_RUNTIME_OPENAPPA: "1",
    ARCHESTRA_AGENT_RUNTIME_TASK: "Fix the failing test.",
    ARCHESTRA_AGENT_RUNTIME_TASK_ID: "task-1",
    ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID: "workspace-1",
    ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "k3.1-pro",
    ARCHESTRA_MCP_GATEWAY_URL: "http://platform:9000/v1/mcp/agent",
    OPENAI_BASE_URL: "http://platform:9000/v1/model-router/agent",
    ...overrides,
  };
}

async function readToml(file: string): Promise<Record<string, unknown>> {
  const { stdout } = await exec("python3", [
    "-c",
    [
      "import json, sys, tomllib",
      "with open(sys.argv[1], 'rb') as file:",
      "    print(json.dumps(tomllib.load(file)))",
    ].join("\n"),
    file,
  ]);
  return JSON.parse(stdout);
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(full) : [full];
    }),
  );
  return nested.flat();
}

/** A synthetic MCP gateway; `answer` returns a result, an error, or a raw HTTP reply. */
async function startGateway(
  answer: (body: JsonRpc) => Record<string, unknown>,
  requests: { headers: IncomingHttpHeaders; body: JsonRpc }[],
  held: (() => void)[] = [],
) {
  const server = createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(data) as JsonRpc;
      requests.push({ headers: request.headers, body });
      const reply = answer(body);
      if (reply.hold) {
        // Never answers until the test releases it.
        held.push(() => response.destroy());
        return;
      }
      if (typeof reply.status === "number") {
        response.writeHead(reply.status, {
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify(reply.body));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          ...("error" in reply ? { error: reply.error } : { result: reply }),
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function startBridge(root: string, gatewayUrl: string) {
  const child = spawn("python3", [path.join(IMAGE_BIN, "archestra-kimi-mcp")], {
    env: {
      PATH: process.env.PATH,
      ...SECRETS,
      ARCHESTRA_MCP_GATEWAY_URL: gatewayUrl,
      ARCHESTRA_AGENT_RUNTIME_TASK_ID: "task-1",
      ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID: "workspace-1",
      ARCHESTRA_KIMI_GATEWAY_STATE: path.join(root, "state.json"),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map<number, (message: JsonRpc) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as JsonRpc;
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let nextId = 0;
  return {
    request(message: JsonRpc) {
      const id = ++nextId;
      return new Promise<JsonRpc>((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, ...message })}\n`,
        );
      });
    },
    close() {
      child.stdin.end();
    },
    child,
  };
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(condition()).toBe(true);
}

async function gatewayState(root: string) {
  // The bridge records the outcome just after Kimi receives the answer.
  for (let attempt = 0; attempt < 20; attempt++) {
    const { stdout } = await exec(
      "python3",
      [path.join(IMAGE_BIN, "archestra-kimi-gateway-state")],
      {
        env: {
          PATH: process.env.PATH,
          ARCHESTRA_KIMI_GATEWAY_STATE: path.join(root, "state.json"),
        },
      },
    );
    if (stdout.trim() !== "pending" || attempt === 19) return stdout.trim();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "pending";
}

function loopEvent(event: Record<string, unknown>) {
  return { type: "context.append_loop_event", agentId: "main", event };
}

function completedTurn(finishReason: string) {
  return [
    loopEvent({ type: "step.end", finishReason }),
    { type: "turn.ended", agentId: "main", reason: "completed" },
  ];
}

/** A turn's last step, as Kimi has recorded it when it runs the Stop hook. */
function stepEnded(finishReason: string) {
  return [
    loopEvent({ type: "step.end", finishReason }),
    { type: "agent.turn.ended", turnId: 0, outcome: "done" },
  ];
}

function failedTurn(code: string, statusCode: number | null = null) {
  return [
    {
      type: "turn.ended",
      agentId: "main",
      reason: "failed",
      error: {
        code,
        message: "synthetic",
        name: "Error2",
        details: { statusCode },
      },
    },
  ];
}

function answeredTurn() {
  return [
    {
      type: "turn.prompt",
      input: [{ type: "text", text: "Run the tests." }],
      origin: { kind: "user" },
    },
    loopEvent({
      type: "content.part",
      part: { type: "text", text: "The tests pass." },
    }),
  ];
}

/** Writes a session's main-agent record where Kimi keeps it. */
async function writeSession(
  root: string,
  sessionId: string,
  records: Record<string, unknown>[],
) {
  const runtime = path.join(root, "runtime");
  const agent = path.join(
    runtime,
    "kimi",
    "sessions",
    "wd_work_1234",
    sessionId,
    "agents",
    "main",
  );
  await mkdir(agent, { recursive: true });
  await writeFile(
    path.join(agent, "wire.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  return runtime;
}

/** A one_shot runtime whose recorded main session ended with an answer. */
async function sessionWithAnswer(
  root: string,
  sessionId: string,
  ending: Record<string, unknown>[],
) {
  const runtime = await writeSession(root, sessionId, [
    {
      type: "turn.prompt",
      input: [{ type: "text", text: "Run the tests." }],
      origin: { kind: "user" },
    },
    loopEvent({
      type: "content.part",
      part: { type: "text", text: "The tests pass." },
    }),
    ...ending,
  ]);
  await writeFile(path.join(runtime, "kimi-main-session"), `${sessionId}\n`);
  return runtime;
}

async function attentionRecorder(root: string, runtime: string) {
  const recorder = path.join(root, "attention");
  await writeFile(
    recorder,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${runtime}/attention.log"\n`,
  );
  await chmod(recorder, 0o755);
  return recorder;
}

function transcriptEnv(root: string) {
  return {
    PATH: process.env.PATH,
    KIMI_CODE_HOME: path.join(root, "runtime", "kimi"),
    ARCHESTRA_AGENT_RUNTIME_DIR: path.join(root, "runtime"),
  };
}

async function runHook(
  root: string,
  event: string,
  payload: Record<string, unknown>,
  overrides: Record<string, string> = {},
) {
  const runtime = path.join(root, "runtime");
  const child = execFile(
    "bash",
    [path.join(IMAGE_BIN, "archestra-kimi-hook"), event],
    {
      env: {
        PATH: process.env.PATH,
        KIMI_CODE_HOME: path.join(runtime, "kimi"),
        ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
        ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(runtime, "turn"),
        ARCHESTRA_AGENT_RUNTIME_MODE: "one_shot",
        ARCHESTRA_AGENT_ATTENTION_COMMAND: "true",
        ...overrides,
      },
    },
  );
  child.stdin?.end(JSON.stringify(payload));
  const [code] = await once(child, "exit");
  return { code: code as number };
}

/**
 * A `kimi` that streams print-mode output, records its session like the real
 * CLI, and exits with the given status. `blocked` stands in for the prompt
 * hook refusing the task.
 */
async function fakeKimi(
  root: string,
  params: {
    exit: number;
    ending: Record<string, unknown>[];
    blocked?: boolean;
  },
) {
  const runtime = path.join(root, "runtime");
  await mkdir(runtime, { recursive: true });
  // A follow-up resumes the session the launcher passes on.
  const native = path.join(root, "native");
  await mkdir(native, { recursive: true });
  const records = [
    {
      type: "turn.prompt",
      input: [{ type: "text", text: "Fix the failing test." }],
      origin: { kind: "user" },
    },
    loopEvent({
      type: "content.part",
      part: { type: "text", text: "The tests pass." },
    }),
    ...params.ending,
  ];
  const wire = path.join(
    runtime,
    "kimi",
    "sessions",
    "wd_work_1234",
    "s-1",
    "agents",
    "main",
  );
  await mkdir(wire, { recursive: true });
  await writeFile(
    path.join(native, "kimi"),
    [
      "#!/usr/bin/env python3",
      "import json, os, sys",
      "runtime = os.environ['ARCHESTRA_AGENT_RUNTIME_DIR']",
      "open(os.path.join(runtime, 'fake-kimi-args.json'), 'w').write(json.dumps(sys.argv[1:]))",
      params.blocked
        ? "open(os.path.join(runtime, 'kimi-gateway-blocked'), 'w').close()"
        : `open(${JSON.stringify(path.join(wire, "wire.jsonl"))}, 'w').write(${JSON.stringify(records.map((record) => JSON.stringify(record)).join("\n"))})`,
      "print(json.dumps({'role': 'meta', 'type': 'system.version', 'version': '2.3.3'}))",
      "print(json.dumps({'role': 'assistant', 'content': 'The tests pass.'}))",
      "print(json.dumps({'role': 'meta', 'type': 'session.resume_hint', 'session_id': 's-1'}))",
      `sys.exit(${params.exit})`,
      "",
    ].join("\n"),
  );
  await chmod(path.join(native, "kimi"), 0o755);
}

async function runPrint(root: string) {
  const runtime = path.join(root, "runtime");
  return await exec(
    "python3",
    [path.join(IMAGE_BIN, "archestra-kimi-print"), "--session", "s-0"],
    {
      cwd: root,
      env: {
        PATH: `${path.join(root, "native")}${path.delimiter}${process.env.PATH}`,
        KIMI_CODE_HOME: path.join(runtime, "kimi"),
        ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
        ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(runtime, "turn"),
        ARCHESTRA_AGENT_RUNTIME_MODE: "one_shot",
        ARCHESTRA_AGENT_RUNTIME_PLAIN: "1",
        ARCHESTRA_AGENT_RUNTIME_TASK: "Fix the failing test.",
        ARCHESTRA_AGENT_ATTENTION_COMMAND: "true",
      },
    },
  )
    .then((result) => ({ code: 0, stdout: result.stdout }))
    .catch((error) => ({ code: error.code as number, stdout: error.stdout }));
}
