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

describe("Grok Build image entrypoint", () => {
  test("writes a credential-free Grok config and runs delegated work in the native TUI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const { bin, runtime, state } = await prepare(root);
      await exec("bash", [path.join(bin, "archestra-grok")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_STATE_DIR: state,
          ARCHESTRA_AGENT_RUNTIME_MODEL_CONTEXT_LENGTH: "2000000",
          ARCHESTRA_AGENT_RUNTIME_MODEL_OUTPUT_LENGTH: "65536",
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
        path.join(bin, "archestra-grok-tui-start"),
        "grok",
        "--trust",
        "--always-approve",
        "",
      ]);
      const grokHome = path.join(state, "grok");
      const config = await readFile(path.join(grokHome, "config.toml"), "utf8");
      expect(
        (await stat(path.join(grokHome, "config.toml"))).mode & 0o777,
      ).toBe(0o600);
      expect(config).toContain('default = "archestra"');
      expect(config).toContain('session_summary = "archestra"');
      expect(config).toContain('model = "grok-4.7"');
      // Grok talks to the wire adapter on loopback; the adapter alone knows
      // the proxy URL, and it listens before the config names its port.
      const port = (
        await readFile(path.join(runtime, "grok-llm.port"), "utf8")
      ).trim();
      expect(port).toMatch(/^\d+$/);
      expect(config).toContain(`base_url = "http://127.0.0.1:${port}"\n`);
      expect(config).not.toContain("model-router");
      expect(config).toContain("max_output_bytes = 200000");
      expect(config).toContain('env_key = "OPENAI_API_KEY"');
      expect(config).toContain('api_backend = "chat_completions"');
      expect(config).toContain("context_window = 2000000");
      expect(config).toContain("max_completion_tokens = 65536");
      expect(config).toContain(
        'extra_headers = { "X-Archestra-Run-Id" = "task-1", "X-Archestra-Session-Id" = "workspace-1", "X-Appa-Session-ID" = "workspace-1" }',
      );
      expect(config).toContain(
        'env_http_headers = { "X-Archestra-Runtime-Binding" = "ARCHESTRA_AGENT_RUNTIME_BINDING" }',
      );
      expect(config).toContain(
        `command = ${JSON.stringify(path.join(bin, "archestra-grok-mcp"))}`,
      );
      expect(config).toContain("telemetry = false");
      expect(config).toContain("[[hooks.PermissionDenied]]");
      expect(config).toContain('follow_up_behavior = "steer"');
      // The working directory is trusted, so Grok runs the launcher's hooks.
      expect(
        await readFile(path.join(grokHome, "trusted_folders.toml"), "utf8"),
      ).toContain(`[folders.${JSON.stringify(root)}]\ntrusted = true\n`);
      expect(config).toContain("auto_update = false");
      expect(
        await readFile(
          path.join(grokHome, "rules", "archestra-runtime.md"),
          "utf8",
        ),
      ).toContain("Follow the team rules.");

      // No credential reaches a file Grok or the workspace can read later.
      for (const file of await filesUnder(grokHome)) {
        const content = await readFile(file, "utf8");
        for (const secret of Object.values(SECRETS)) {
          expect(content, file).not.toContain(secret);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes non-ASCII config values as literal TOML text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const { bin, state } = await prepare(root);
      const model = "grök 🚀";
      await exec("bash", [path.join(bin, "archestra-grok")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_STATE_DIR: state,
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: model,
        }),
      });
      const configPath = path.join(state, "grok", "config.toml");
      // JSON would write the emoji as a UTF-16 surrogate pair, which TOML
      // rejects; the value must survive a TOML parser unchanged.
      expect(await readFile(configPath, "utf8")).toContain(
        `model = "${model}"`,
      );
      const { stdout } = await exec("python3", [
        "-c",
        [
          "import json, sys, tomllib",
          "with open(sys.argv[1], 'rb') as file:",
          "    config = tomllib.load(file)",
          "print(json.dumps(config['model']['archestra']['model']))",
        ].join("\n"),
        configPath,
      ]);
      expect(JSON.parse(stdout)).toBe(model);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drives plain delegated work over ACP, without a terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const { bin, runtime } = await prepare(root);
      await exec("bash", [path.join(bin, "archestra-grok")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_PLAIN: "1",
        }),
      });
      expect(await readFile(path.join(runtime, "started"), "utf8")).toBe(
        "archestra-grok-acp\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a missing grok CLI before starting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const { bin, runtime } = await prepare(root);
      const result = await exec("bash", [path.join(bin, "archestra-grok")], {
        cwd: root,
        env: {
          ...runtimeEnv({ root, mode: "one_shot" }),
          PATH: process.env.PATH,
        },
      }).catch((error) => error);
      expect(result.code).toBe(78);
      expect(
        JSON.parse(await readFile(path.join(runtime, "turn.failure"), "utf8")),
      ).toMatchObject({ version: 1, code: "grok_missing" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("omits model limits the platform does not know", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const { bin, runtime } = await prepare(root);
      await exec("bash", [path.join(bin, "archestra-grok")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_OPENAPPA: "0",
          ARCHESTRA_AGENT_RUNTIME_BINDING: "",
        }),
      });
      const config = await readFile(
        path.join(runtime, "grok", "config.toml"),
        "utf8",
      );
      expect(config).not.toContain("context_window");
      expect(config).not.toContain("max_completion_tokens");
      expect(config).not.toContain("X-Archestra-Runtime-Binding");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    "present",
    "missing",
  ])("resumes only the recorded interactive session (%s marker)", async (state) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const { bin, runtime } = await prepare(root);
      if (state === "present") {
        await writeFile(path.join(runtime, "grok-main-session"), "session-1\n");
      }
      const result = await exec("bash", [path.join(bin, "archestra-grok")], {
        cwd: root,
        env: runtimeEnv({
          root,
          mode: "interactive",
          ARCHESTRA_AGENT_RUNTIME_CONTINUE: "1",
          ARCHESTRA_AGENT_RUNTIME_TASK: "",
        }),
      }).catch((error) => error);

      if (state === "present") {
        expect(
          (await readFile(path.join(runtime, "started"), "utf8")).split("\n"),
        ).toEqual([
          "archestra-grok-tui-start",
          "grok",
          "--trust",
          "--always-approve",
          "--resume",
          "session-1",
          "",
        ]);
      } else {
        expect(result.code).toBe(78);
        expect(result.stderr).toContain(
          "Cannot resume the saved Grok Build session",
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

describe("Grok Build MCP gateway bridge", () => {
  test("lists gateway tools under names Grok accepts and calls them by their gateway names", async () => {
    const requests: {
      body: Record<string, unknown>;
      headers: IncomingHttpHeaders;
    }[] = [];
    const listedTools = [
      { name: "archestra__get_remedy_plans", inputSchema: {} },
      { name: "github__list_repos", inputSchema: {} },
    ];
    const server = createServer((request, response) => {
      let data = "";
      request.on("data", (chunk) => {
        data += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(data);
        requests.push({ body, headers: request.headers });
        const result =
          body.method === "tools/list"
            ? { tools: [...listedTools] }
            : {
                content: [{ type: "text", text: `called ${body.params.name}` }],
              };
        // The gateway may answer as a server-sent event stream.
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    const catalog = path.join(root, "grok-gateway-tools.json");
    const bridge = spawn(
      "python3",
      [path.join(IMAGE_BIN, "archestra-grok-mcp")],
      {
        env: {
          PATH: process.env.PATH,
          ARCHESTRA_MCP_GATEWAY_URL: `http://127.0.0.1:${port}/v1/mcp/agent`,
          ARCHESTRA_MCP_GATEWAY_TOKEN: SECRETS.ARCHESTRA_MCP_GATEWAY_TOKEN,
          ARCHESTRA_AGENT_RUNTIME_BINDING:
            SECRETS.ARCHESTRA_AGENT_RUNTIME_BINDING,
          ARCHESTRA_AGENT_RUNTIME_TASK_ID: "task-1",
          ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID: "workspace-1",
          ARCHESTRA_GROK_GATEWAY_CATALOG: catalog,
        },
      },
    );
    const lines = createInterface({ input: bridge.stdout })[
      Symbol.asyncIterator
    ]();
    const call = async (message: Record<string, unknown>) => {
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      const { value } = await lines.next();
      return JSON.parse(String(value));
    };
    try {
      const listed = await call({ id: 1, method: "tools/list", params: {} });
      expect(
        listed.result.tools.map((tool: { name: string }) => tool.name),
      ).toEqual(["archestra--get_remedy_plans", "github--list_repos"]);
      // The wire adapter declares the gateway's own tools to the model from
      // this file, written before Grok hears of the renamed list.
      expect(JSON.parse(await readFile(catalog, "utf8"))).toEqual({
        server: "archestra",
        tools: [
          { name: "archestra__get_remedy_plans", inputSchema: {} },
          { name: "github__list_repos", inputSchema: {} },
        ],
        names: {
          "archestra--get_remedy_plans": "archestra__get_remedy_plans",
          "github--list_repos": "github__list_repos",
        },
      });
      expect((await stat(catalog)).mode & 0o777).toBe(0o600);

      const called = await call({
        id: 2,
        method: "tools/call",
        params: { name: "github--list_repos", arguments: { owner: "acme" } },
      });
      expect(called.result.content[0].text).toBe("called github__list_repos");
      expect(requests[1].body.params).toEqual({
        name: "github__list_repos",
        arguments: { owner: "acme" },
      });
      for (const { headers } of requests) {
        expect(headers).toMatchObject({
          authorization: `Bearer ${SECRETS.ARCHESTRA_MCP_GATEWAY_TOKEN}`,
          "x-archestra-run-id": "task-1",
          "x-archestra-session-id": "workspace-1",
          "x-appa-session-id": "workspace-1",
          "x-archestra-runtime-binding":
            SECRETS.ARCHESTRA_AGENT_RUNTIME_BINDING,
        });
      }
      // A fresh list replaces the catalog: a tool the gateway dropped is gone.
      listedTools.splice(1, 1);
      await call({ id: 3, method: "tools/list", params: {} });
      expect(JSON.parse(await readFile(catalog, "utf8"))).toEqual({
        server: "archestra",
        tools: [{ name: "archestra__get_remedy_plans", inputSchema: {} }],
        names: { "archestra--get_remedy_plans": "archestra__get_remedy_plans" },
      });
    } finally {
      bridge.kill();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Grok Build LLM wire adapter", () => {
  const GATEWAY_TOOLS = [
    {
      name: "archestra__get_remedy_plans",
      description: "Read why a call was blocked. [marker:AAA]",
      inputSchema: { type: "object", properties: { tool: { type: "string" } } },
    },
    {
      name: "github__list_repos",
      description: "List repositories.",
      inputSchema: { type: "object", properties: { org: { type: "string" } } },
    },
  ];
  const GROK_TOOLS = [
    { type: "function", function: { name: "read_file", parameters: {} } },
    { type: "function", function: { name: "search_tool", parameters: {} } },
    { type: "function", function: { name: "use_tool", parameters: {} } },
  ];
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
  ) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  test("declares the gateway tools to the model and runs its calls through use_tool", async () => {
    const upstream = await fakeUpstream(() => {
      // The proxy streams a gateway call with its arguments in fragments,
      // and a Grok tool call next to it.
      const args = JSON.stringify({ org: "archestra-ai", limit: 2 });
      return {
        contentType: "text/event-stream",
        body:
          chunk({ role: "assistant", content: "Listing." }) +
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "github__list_repos", arguments: "" },
              },
            ],
          }) +
          [args.slice(0, 9), args.slice(9, 20), args.slice(20)]
            .map((part) =>
              chunk({
                tool_calls: [{ index: 0, function: { arguments: part } }],
              }),
            )
            .join("") +
          chunk({
            tool_calls: [
              {
                index: 1,
                id: "call_2",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a"}' },
              },
            ],
          }) +
          chunk({}, "tool_calls") +
          "data: [DONE]\n\n",
        headers: { "x-request-id": "req-1" },
      };
    });
    const adapter = await startAdapter(upstream.url, GATEWAY_TOOLS);
    try {
      const response = await fetch(
        `http://127.0.0.1:${adapter.port}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer synthetic-virtual-key",
            "X-Archestra-Run-Id": "task-1",
          },
          body: JSON.stringify({
            model: "grok-4.7",
            stream: true,
            tools: GROK_TOOLS,
            messages: [
              { role: "user", content: "List the repos." },
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_0",
                    type: "function",
                    function: {
                      name: "use_tool",
                      arguments: JSON.stringify({
                        tool_name: "archestra__archestra--get_remedy_plans",
                        tool_input: { tool: "read_file" },
                      }),
                    },
                  },
                ],
              },
              { role: "tool", tool_call_id: "call_0", content: "ruling" },
            ],
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      expect(response.headers.get("x-request-id")).toBe("req-1");
      const events = (await response.text())
        .split("\n\n")
        .filter((event) => event.startsWith("data: "))
        .map((event) => event.slice(6));
      expect(events.at(-1)).toBe("[DONE]");
      const calls = new Map<number, { name?: string; arguments: string }>();
      for (const event of events.slice(0, -1)) {
        for (const call of JSON.parse(event).choices[0].delta.tool_calls ??
          []) {
          const entry = calls.get(call.index) ?? { arguments: "" };
          if (call.function.name) entry.name = call.function.name;
          entry.arguments += call.function.arguments ?? "";
          calls.set(call.index, entry);
        }
      }
      // The gateway call reaches Grok as the use_tool call it knows how to run.
      expect(calls.get(0)?.name).toBe("use_tool");
      expect(JSON.parse(calls.get(0)?.arguments ?? "")).toEqual({
        tool_name: "archestra__github--list_repos",
        tool_input: { org: "archestra-ai", limit: 2 },
      });
      expect(calls.get(1)).toEqual({
        name: "read_file",
        arguments: '{"path":"a"}',
      });

      // The proxy saw the gateway tools declared as the gateway sent them,
      // neither dispatcher, and the earlier use_tool call as the gateway call.
      const [seen] = upstream.requests as {
        url: string;
        body: {
          tools: unknown;
          messages: {
            tool_calls: { function: { name: string; arguments: string } }[];
          }[];
        };
        headers: IncomingHttpHeaders;
      }[];
      // The proxy's own route (the Agent's model-router path) leads the way.
      expect(seen.url).toBe("/v1/model-router/agent-1/chat/completions");
      expect(seen.headers.authorization).toBe("Bearer synthetic-virtual-key");
      expect(seen.headers["x-archestra-run-id"]).toBe("task-1");
      expect(seen.headers["accept-encoding"]).toBe("identity");
      expect(seen.body.tools).toEqual([
        GROK_TOOLS[0],
        ...GATEWAY_TOOLS.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      ]);
      const [replayed] = seen.body.messages[1].tool_calls;
      expect(replayed).toMatchObject({
        id: "call_0",
        type: "function",
        function: { name: "archestra__get_remedy_plans" },
      });
      expect(JSON.parse(replayed.function.arguments)).toEqual({
        tool: "read_file",
      });
      expect(seen.body.messages[2]).toEqual({
        role: "tool",
        tool_call_id: "call_0",
        content: "ruling",
      });
    } finally {
      await adapter.stop();
      upstream.close();
    }
  });

  test("closes a wrapped call whose last fragment shares the finishing chunk", async () => {
    const upstream = await fakeUpstream(() => ({
      contentType: "text/event-stream",
      // One event spread over two data lines, then a chunk that carries the
      // final fragment and the finish reason together.
      body:
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "github__list_repos",
                      arguments: '{"org":',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }).replace('"choices"', '\ndata: "choices"')}\n\n` +
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n` +
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage: { total_tokens: 3 } })}\n\n` +
        "data: [DONE]\n\n",
    }));
    const adapter = await startAdapter(upstream.url, GATEWAY_TOOLS);
    try {
      const response = await fetch(
        `http://127.0.0.1:${adapter.port}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "grok-4.7",
            stream: true,
            tools: GROK_TOOLS,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      const events = (await response.text())
        .split("\n\n")
        .filter((event) => event.startsWith("data: "))
        .map((event) => event.slice(6));
      expect(events.at(-1)).toBe("[DONE]");
      const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
      // The arguments arrive whole, before the finish, and the usage chunk
      // still follows.
      expect(
        chunks.map((chunk) => {
          const call = chunk.choices[0]?.delta?.tool_calls?.[0]?.function;
          return [
            call?.name ?? null,
            call?.arguments
              ? JSON.parse(call.arguments)
              : (call?.arguments ?? null),
            chunk.choices[0]?.finish_reason ?? null,
            chunk.usage ?? null,
          ];
        }),
      ).toEqual([
        ["use_tool", "", null, null],
        [
          null,
          {
            tool_name: "archestra__github--list_repos",
            tool_input: { org: "x" },
          },
          null,
          null,
        ],
        [null, null, "tool_calls", null],
        [null, null, null, { total_tokens: 3 }],
      ]);
    } finally {
      await adapter.stop();
      upstream.close();
    }
  });

  test("wraps a complete reply and an argument-less call the same way", async () => {
    const upstream = await fakeUpstream(() => ({
      contentType: "application/json",
      body: JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "archestra__get_remedy_plans",
                    arguments: "",
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    }));
    const adapter = await startAdapter(upstream.url, GATEWAY_TOOLS);
    try {
      // A chunked request body is read whole too.
      const body = JSON.stringify({
        model: "grok-4.7",
        tools: GROK_TOOLS,
        messages: [{ role: "user", content: "hi" }],
      });
      const response = await fetch(
        `http://127.0.0.1:${adapter.port}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body.slice(0, 20)));
              controller.enqueue(new TextEncoder().encode(body.slice(20)));
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit,
      );
      expect(upstream.requests[0].headers["transfer-encoding"]).toBeUndefined();
      expect(upstream.requests[0].body.messages).toEqual([
        { role: "user", content: "hi" },
      ]);
      const call = (await response.json()).choices[0].message.tool_calls[0];
      expect(call.function.name).toBe("use_tool");
      expect(JSON.parse(call.function.arguments)).toEqual({
        tool_name: "archestra__archestra--get_remedy_plans",
        tool_input: {},
      });
    } finally {
      await adapter.stop();
      upstream.close();
    }
  });

  test.each([
    {
      case: "truncated JSON stays as written",
      arguments: '{"dry_run":true,',
      wrapped: '{"dry_run":true,',
    },
    {
      case: "a value that is not an object is wrapped as it is",
      arguments: "null",
      wrapped: { tool_name: "archestra__github--list_repos", tool_input: null },
    },
  ])("never runs a gateway tool with arguments the model did not write ($case)", async ({
    arguments: written,
    wrapped,
  }) => {
    const call = (name: string, args: string) => ({
      id: "call_1",
      type: "function",
      function: { name, arguments: args },
    });
    const upstream = await fakeUpstream((body) =>
      body.stream
        ? {
            contentType: "text/event-stream",
            body:
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    ...call("github__list_repos", written.slice(0, 5)),
                  },
                ],
              }) +
              chunk({
                tool_calls: [
                  { index: 0, function: { arguments: written.slice(5) } },
                ],
              }) +
              chunk({}, "tool_calls") +
              "data: [DONE]\n\n",
          }
        : {
            contentType: "application/json",
            body: JSON.stringify({
              id: "chatcmpl-1",
              object: "chat.completion",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [call("github__list_repos", written)],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          },
    );
    const adapter = await startAdapter(upstream.url, GATEWAY_TOOLS);
    try {
      const request = (stream: boolean) =>
        fetch(`http://127.0.0.1:${adapter.port}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "grok-4.7",
            stream,
            tools: GROK_TOOLS,
            messages: [{ role: "user", content: "hi" }],
          }),
        });
      // Grok parses the arguments; their spelling is the adapter's own.
      const received = (args: string) =>
        typeof wrapped === "string" ? args : JSON.parse(args);
      const complete = (await (await request(false)).json()).choices[0].message
        .tool_calls[0];
      expect(complete.function.name).toBe("use_tool");
      expect(received(complete.function.arguments)).toEqual(wrapped);

      const events = (await (await request(true)).text())
        .split("\n\n")
        .filter((event) => event.startsWith("data: {"))
        .map((event) => JSON.parse(event.slice(6)));
      const streamed = events
        .flatMap((event) => event.choices[0].delta.tool_calls ?? [])
        .reduce(
          (entry, part) => ({
            name: part.function.name ?? entry.name,
            arguments: entry.arguments + (part.function.arguments ?? ""),
          }),
          { name: "", arguments: "" },
        );
      expect(streamed.name).toBe("use_tool");
      expect(received(streamed.arguments)).toEqual(wrapped);
    } finally {
      await adapter.stop();
      await upstream.close();
    }
  });

  test("refuses a request that declares the dispatcher before the gateway is listed", async () => {
    const upstream = await fakeUpstream(() => ({
      contentType: "application/json",
      body: "{}",
    }));
    const adapter = await startAdapter(upstream.url, undefined);
    try {
      const response = await fetch(
        `http://127.0.0.1:${adapter.port}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "grok-4.7",
            tools: GROK_TOOLS,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error.type).toBe(
        "archestra_gateway_not_ready",
      );
      expect(upstream.requests).toHaveLength(0);

      // A side call without the dispatcher needs no catalog.
      const side = await fetch(
        `http://127.0.0.1:${adapter.port}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "grok-4.7",
            tools: [{ type: "function", function: { name: "session_title" } }],
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      expect(side.status).toBe(200);
      expect(upstream.requests[0].body.tools).toEqual([
        { type: "function", function: { name: "session_title" } },
      ]);
    } finally {
      await adapter.stop();
      upstream.close();
    }
  });

  test("exits with the launcher that started it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const portFile = path.join(root, "port");
      const pidFile = path.join(root, "pid");
      // A launcher that backgrounds the adapter and then ends; the adapter
      // notices its parent is gone.
      const launcher = path.join(root, "launcher");
      await writeFile(
        launcher,
        '#!/bin/sh\n"$1" & echo $! > "$2"\nfor _ in $(seq 50); do [ -s "$3" ] && exit 0; sleep 0.1; done\nexit 1\n',
      );
      await chmod(launcher, 0o755);
      await exec(
        launcher,
        [path.join(IMAGE_BIN, "archestra-grok-llm"), pidFile, portFile],
        {
          env: {
            PATH: process.env.PATH,
            ARCHESTRA_GROK_UPSTREAM_URL: "http://127.0.0.1:9/v1",
            ARCHESTRA_GROK_LLM_PORT_FILE: portFile,
            ARCHESTRA_GROK_GATEWAY_CATALOG: path.join(root, "none.json"),
          },
        },
      );
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fakeUpstream(
  reply: (body: Record<string, unknown>) => {
    contentType: string;
    body: string;
    headers?: Record<string, string>;
  },
) {
  const requests: {
    url: string;
    body: Record<string, unknown>;
    headers: IncomingHttpHeaders;
  }[] = [];
  const server = createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(data);
      requests.push({ url: request.url ?? "", body, headers: request.headers });
      const answer = reply(body);
      response.writeHead(200, {
        "Content-Type": answer.contentType,
        ...answer.headers,
      });
      response.end(answer.body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  // The proxy URL the platform gives a run: the Agent's model-router route.
  return {
    url: `http://127.0.0.1:${port}/v1/model-router/agent-1`,
    requests,
    close: () => server.close(),
  };
}

async function startAdapter(
  upstreamUrl: string,
  tools: Record<string, unknown>[] | undefined,
) {
  const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
  const catalog = path.join(root, "grok-gateway-tools.json");
  if (tools) {
    await writeFile(
      catalog,
      JSON.stringify({
        server: "archestra",
        tools,
        names: Object.fromEntries(
          tools.map((tool) => [
            String(tool.name).replaceAll("__", "--"),
            tool.name,
          ]),
        ),
      }),
    );
  }
  const portFile = path.join(root, "grok-llm.port");
  const adapter = spawn(
    "python3",
    [path.join(IMAGE_BIN, "archestra-grok-llm")],
    {
      env: {
        PATH: process.env.PATH,
        ARCHESTRA_GROK_UPSTREAM_URL: upstreamUrl,
        ARCHESTRA_GROK_LLM_PORT_FILE: portFile,
        ARCHESTRA_GROK_GATEWAY_CATALOG: catalog,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  let port = "";
  for (let attempt = 0; attempt < 50 && !port; attempt++) {
    port = await readFile(portFile, "utf8").then(
      (text) => text.trim(),
      () => "",
    );
    if (!port) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) {
    adapter.kill();
    await rm(root, { recursive: true, force: true });
    throw new Error("the wire adapter did not start");
  }
  return {
    port: Number(port),
    stop: async () => {
      adapter.kill();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Grok Build MCP gateway bridge errors", () => {
  test("answers a request the gateway rejects without a JSON-RPC reply at once", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const bridge = spawn(
      "python3",
      [path.join(IMAGE_BIN, "archestra-grok-mcp")],
      {
        env: {
          PATH: process.env.PATH,
          ARCHESTRA_MCP_GATEWAY_URL: `http://127.0.0.1:${port}/v1/mcp/agent`,
          ARCHESTRA_MCP_GATEWAY_TOKEN: "rejected-token",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID: "task-1",
        },
      },
    );
    const lines = createInterface({ input: bridge.stdout })[
      Symbol.asyncIterator
    ]();
    try {
      bridge.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
      );
      const { value } = await lines.next();
      const reply = JSON.parse(String(value));
      expect(reply).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32603,
          message: "MCP gateway request failed: HTTP 401",
        },
      });
    } finally {
      bridge.kill();
      server.close();
    }
  });

  test("decodes a reply that one server-sent event spreads over several data lines", async () => {
    const server = createServer((request, response) => {
      let data = "";
      request.on("data", (chunk) => {
        data += chunk;
      });
      request.on("end", () => {
        const { id } = JSON.parse(data);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          `event: message\ndata: {"jsonrpc": "2.0", "id": ${id},\ndata:  "result": {"tools": []}}\n\n`,
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const bridge = spawn(
      "python3",
      [path.join(IMAGE_BIN, "archestra-grok-mcp")],
      {
        env: {
          PATH: process.env.PATH,
          ARCHESTRA_MCP_GATEWAY_URL: `http://127.0.0.1:${port}/v1/mcp/agent`,
          ARCHESTRA_MCP_GATEWAY_TOKEN: "token",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID: "task-1",
        },
      },
    );
    const lines = createInterface({ input: bridge.stdout })[
      Symbol.asyncIterator
    ]();
    try {
      bridge.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} })}\n`,
      );
      const { value } = await lines.next();
      expect(JSON.parse(String(value))).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: { tools: [] },
      });
    } finally {
      bridge.kill();
      server.close();
    }
  });
});

describe("Grok Build turn hooks", () => {
  // Payloads as Grok 1.0.67 sends them (evidence/r2-stop-payloads.txt);
  // reasons Grok documents but a synthetic model cannot trigger are covered
  // the same way.
  test.each([
    {
      event: "Stop",
      payload: { reason: "end_turn" },
      answer: "The tests pass.\n",
      failure: undefined,
    },
    {
      event: "StopFailure",
      payload: { error: "server_error" },
      answer:
        "Grok Build could not complete the turn because the model provider did not answer. Check the configured provider credential, model availability, and network access, then retry.\n",
      failure: "grok_unavailable",
    },
    {
      event: "StopFailure",
      payload: { error: "max_output_tokens" },
      answer:
        "Grok Build stopped because the model reached its output limit.\n",
      failure: "grok_turn_failed",
    },
    {
      event: "StopCancelled",
      payload: { reason: "max_turns", cancelledBy: "runtime" },
      answer:
        "Grok Build stopped because the turn reached its request limit.\n",
      failure: "grok_turn_failed",
    },
    {
      event: "Stop",
      payload: { reason: "refusal" },
      answer: "The model refused to complete the turn.\n",
      failure: "grok_turn_failed",
    },
  ])("settles a delegated terminal turn on $event $payload", async ({
    event,
    payload,
    answer,
    failure,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const runtime = await sessionWithAnswer(root, "s-1");
      await runHook(root, event, { sessionId: "s-1", ...payload });

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

  test("publishes a placeholder answer when a delegated turn ends without a closing message", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const runtime = path.join(root, "runtime");
      const session = path.join(runtime, "grok", "sessions", "%2Fwork", "s-1");
      await mkdir(session, { recursive: true });
      await writeFile(path.join(runtime, "grok-main-session"), "s-1\n");
      const update = (value: Record<string, unknown>, index: number) =>
        JSON.stringify({
          timestamp: 1_790_000_000 + index,
          method: "session/update",
          params: { sessionId: "s-1", update: value },
        });
      await writeFile(
        path.join(session, "updates.jsonl"),
        [
          update(
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "Run the tests." },
            },
            0,
          ),
          update(
            {
              sessionUpdate: "tool_call",
              toolCallId: "call-1",
              title: "use_tool",
              rawInput: {
                tool_name: "archestra__archestra--yell",
                tool_input: {},
              },
            },
            1,
          ),
          update(
            {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-1",
              status: "completed",
              rawOutput: { type: "MCP", output: { OkayOutput: "ok" } },
            },
            2,
          ),
        ].join("\n"),
      );
      await runHook(root, "Stop", { sessionId: "s-1", reason: "end_turn" });

      expect(
        await readFile(path.join(runtime, "final-answer.txt"), "utf8"),
      ).toBe("The session ended without producing a final message.\n");
      await expect(
        stat(path.join(runtime, "turn-complete")),
      ).resolves.toBeTruthy();
      await expect(
        stat(path.join(runtime, "turn-complete.failed")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stops asking for attention once a permission is denied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const runtime = await sessionWithAnswer(root, "s-1");
      const attention = path.join(root, "attention");
      await writeFile(
        attention,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${runtime}/attention.log"\n`,
      );
      await chmod(attention, 0o755);
      await runHook(
        root,
        "PermissionDenied",
        { sessionId: "s-1", toolName: "run_terminal_command" },
        {
          ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
          ARCHESTRA_AGENT_ATTENTION_COMMAND: attention,
        },
      );
      expect(await readFile(path.join(runtime, "attention.log"), "utf8")).toBe(
        "clear\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("waits for input after an interactive turn fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const runtime = await sessionWithAnswer(root, "s-1");
      const attention = path.join(root, "attention");
      await writeFile(
        attention,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${runtime}/attention.log"\n`,
      );
      await chmod(attention, 0o755);
      await runHook(
        root,
        "StopFailure",
        { sessionId: "s-1", error: "max_output_tokens" },
        {
          ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
          ARCHESTRA_AGENT_ATTENTION_COMMAND: attention,
        },
      );
      expect(await readFile(path.join(runtime, "attention.log"), "utf8")).toBe(
        "set Waiting for input\n",
      );
      await expect(stat(path.join(runtime, "turn-complete"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "the session-end Stop",
      sessionId: "s-1",
      plain: "0",
      reason: "shutdown",
    },
    {
      name: "another session",
      sessionId: "subagent",
      plain: "0",
      reason: "end_turn",
    },
    {
      name: "a plain run, which the ACP driver settles",
      sessionId: "s-1",
      plain: "1",
      reason: "end_turn",
    },
  ])("leaves the turn alone for $name", async ({
    sessionId,
    plain,
    reason,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const runtime = await sessionWithAnswer(root, "s-1");
      await runHook(
        root,
        "Stop",
        { sessionId, reason },
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
});

describe("Grok Build readable transcript", () => {
  test("keeps messages and gateway tool activity, not reasoning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const session = path.join(root, "grok", "sessions", "%2Fwork", "s-1");
      await mkdir(session, { recursive: true });
      const update = (value: Record<string, unknown>, ms: number) =>
        JSON.stringify({
          timestamp: Math.floor(ms / 1000),
          method: "session/update",
          params: {
            sessionId: "s-1",
            update: value,
            _meta: { agentTimestampMs: ms },
          },
        });
      await writeFile(
        path.join(session, "updates.jsonl"),
        [
          update(
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "List the repositories." },
            },
            1_790_000_000_000,
          ),
          update(
            {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Private reasoning." },
            },
            1_790_000_000_100,
          ),
          update(
            {
              sessionUpdate: "tool_call",
              toolCallId: "call-1",
              title: "use_tool",
              rawInput: {
                tool_name: "archestra__github--list_repos",
                tool_input: { owner: "acme" },
              },
            },
            1_790_000_000_200,
          ),
          update(
            {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-1",
              status: "completed",
              rawOutput: {
                type: "MCP",
                output: { OkayOutput: "acme/app" },
              },
            },
            1_790_000_000_300,
          ),
          update(
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "One repository: " },
            },
            1_790_000_000_400,
          ),
          update(
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "acme/app." },
            },
            1_790_000_000_500,
          ),
        ].join("\n"),
      );
      await exec(
        "python3",
        [path.join(IMAGE_BIN, "archestra-grok-transcript"), "s-1"],
        {
          env: {
            PATH: process.env.PATH,
            GROK_HOME: path.join(root, "grok"),
            ARCHESTRA_AGENT_RUNTIME_DIR: root,
          },
        },
      );
      const transcript = JSON.parse(
        await readFile(path.join(root, "readable-transcript.json"), "utf8"),
      );
      expect(transcript).toEqual({
        version: 1,
        provider: "grok",
        entries: [
          {
            type: "message",
            role: "user",
            text: "List the repositories.",
            timestamp: "2026-09-21T14:13:20.000Z",
          },
          {
            type: "tool_call",
            name: "github__list_repos",
            input: '{"owner":"acme"}',
            toolCallId: "call-1",
            timestamp: "2026-09-21T14:13:20.200Z",
          },
          {
            type: "tool_result",
            text: "acme/app",
            toolCallId: "call-1",
            timestamp: "2026-09-21T14:13:20.300Z",
          },
          {
            type: "message",
            role: "assistant",
            text: "One repository: acme/app.",
            timestamp: "2026-09-21T14:13:20.400Z",
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unpacks an MCP result envelope that carries extra keys", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const session = path.join(root, "grok", "sessions", "%2Fwork", "s-1");
      await mkdir(session, { recursive: true });
      const update = (value: Record<string, unknown>) =>
        JSON.stringify({
          method: "session/update",
          params: { sessionId: "s-1", update: value },
        });
      await writeFile(
        path.join(session, "updates.jsonl"),
        [
          update({
            sessionUpdate: "tool_call",
            toolCallId: "c-1",
            title: "github__list_repos",
          }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "c-1",
            status: "completed",
            rawOutput: {
              type: "MCP",
              output: { OkayOutput: "acme/app", meta: { elapsedMs: 12 } },
            },
          }),
        ].join("\n"),
      );
      await exec(
        "python3",
        [path.join(IMAGE_BIN, "archestra-grok-transcript"), "s-1"],
        {
          env: {
            PATH: process.env.PATH,
            GROK_HOME: path.join(root, "grok"),
            ARCHESTRA_AGENT_RUNTIME_DIR: root,
          },
        },
      );
      expect(
        JSON.parse(
          await readFile(path.join(root, "readable-transcript.json"), "utf8"),
        ).entries,
      ).toEqual([
        { type: "tool_call", name: "github__list_repos", toolCallId: "c-1" },
        { type: "tool_result", text: "acme/app", toolCallId: "c-1" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps one result when a call reports its end twice", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const session = path.join(root, "grok", "sessions", "%2Fwork", "s-1");
      await mkdir(session, { recursive: true });
      const update = (value: Record<string, unknown>) =>
        JSON.stringify({
          method: "session/update",
          params: { sessionId: "s-1", update: value },
        });
      await writeFile(
        path.join(session, "updates.jsonl"),
        [
          update({
            sessionUpdate: "tool_call",
            toolCallId: "c-1",
            title: "read_file",
          }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "c-1",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "partial" } },
            ],
          }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "c-1",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "final" } },
            ],
          }),
        ].join("\n"),
      );
      await exec(
        "python3",
        [path.join(IMAGE_BIN, "archestra-grok-transcript"), "s-1"],
        {
          env: {
            PATH: process.env.PATH,
            GROK_HOME: path.join(root, "grok"),
            ARCHESTRA_AGENT_RUNTIME_DIR: root,
          },
        },
      );
      expect(
        JSON.parse(
          await readFile(path.join(root, "readable-transcript.json"), "utf8"),
        ).entries,
      ).toEqual([
        { type: "tool_call", name: "read_file", toolCallId: "c-1" },
        { type: "tool_result", text: "final", toolCallId: "c-1" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops a timestamp it cannot read instead of the transcript", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-grok-"));
    try {
      const session = path.join(root, "grok", "sessions", "%2Fwork", "s-1");
      await mkdir(session, { recursive: true });
      await writeFile(
        path.join(session, "updates.jsonl"),
        JSON.stringify({
          timestamp: 1e20,
          method: "session/update",
          params: {
            sessionId: "s-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Done." },
            },
          },
        }),
      );
      await exec(
        "python3",
        [path.join(IMAGE_BIN, "archestra-grok-transcript"), "s-1"],
        {
          env: {
            PATH: process.env.PATH,
            GROK_HOME: path.join(root, "grok"),
            ARCHESTRA_AGENT_RUNTIME_DIR: root,
          },
        },
      );
      expect(
        JSON.parse(
          await readFile(path.join(root, "readable-transcript.json"), "utf8"),
        ).entries,
      ).toEqual([{ type: "message", role: "assistant", text: "Done." }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** The launcher with its native client stages replaced by recorders. */
async function prepare(root: string) {
  const bin = path.join(root, "bin");
  const runtime = path.join(root, "runtime");
  const state = path.join(root, "state");
  await Promise.all([mkdir(bin), mkdir(runtime), mkdir(state)]);
  for (const script of [
    "archestra-grok",
    "archestra-grok-hook",
    "archestra-grok-llm",
    "archestra-grok-mcp",
    "archestra-grok-turn-failure",
    "archestra-agent-failure",
    "archestra-agent-instructions",
  ]) {
    await symlink(path.join(IMAGE_BIN, script), path.join(bin, script));
  }
  for (const stage of [
    "archestra-grok-acp",
    "archestra-grok-tui-start",
    "archestra-tui-run",
  ]) {
    await writeFile(
      path.join(bin, stage),
      `#!/bin/sh\nprintf '%s\\n' "${stage}" "$@" > "$ARCHESTRA_AGENT_RUNTIME_DIR/started"\n`,
    );
    await chmod(path.join(bin, stage), 0o755);
  }
  // The launcher refuses to start without the grok CLI on PATH.
  const native = path.join(root, "native");
  await mkdir(native);
  await writeFile(path.join(native, "grok"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(native, "grok"), 0o755);
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
    ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "grok-4.7",
    ARCHESTRA_MCP_GATEWAY_URL: "http://platform:9000/v1/mcp/agent",
    OPENAI_BASE_URL: "http://platform:9000/v1/model-router/agent",
    ...overrides,
  };
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

/** A one_shot runtime whose recorded main session ended with an answer. */
async function sessionWithAnswer(root: string, sessionId: string) {
  const runtime = path.join(root, "runtime");
  const session = path.join(runtime, "grok", "sessions", "%2Fwork", sessionId);
  await mkdir(session, { recursive: true });
  await writeFile(path.join(runtime, "grok-main-session"), `${sessionId}\n`);
  await writeFile(
    path.join(session, "updates.jsonl"),
    ["Run the tests.", "The tests pass."]
      .map((text, index) =>
        JSON.stringify({
          timestamp: 1_790_000_000 + index,
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: index
                ? "agent_message_chunk"
                : "user_message_chunk",
              content: { type: "text", text },
            },
          },
        }),
      )
      .join("\n"),
  );
  return runtime;
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
    [path.join(IMAGE_BIN, "archestra-grok-hook"), event],
    {
      env: {
        PATH: process.env.PATH,
        GROK_HOME: path.join(runtime, "grok"),
        ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
        ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(runtime, "turn"),
        ARCHESTRA_AGENT_RUNTIME_MODE: "one_shot",
        ARCHESTRA_AGENT_ATTENTION_COMMAND: "true",
        ...overrides,
      },
    },
  );
  child.stdin?.end(JSON.stringify(payload));
  await once(child, "exit");
}
