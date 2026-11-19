import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
} from "@archestra/shared/archestra-mcp-server";
import { expect, test } from "vitest";
import { grokToolName } from "../../../routes/mcp-gateway/grok-tool-names";
import type { SetupScriptContext } from "../types";
import { grokSetup } from "./grok";

// This exercises the native client's permission matcher, not a replacement for
// that matcher. Ordinary installer tests run without an installed Grok binary.
test.skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)(
  "real Grok permits every managed guardrail helper without granting an ordinary gateway tool",
  { timeout: 60000 },
  async () => {
    const binary = process.env.ARCHESTRA_GROK_TEST_BINARY;
    if (!binary) throw new Error("Native Grok test binary is required");
    const home = mkdtempSync(path.join(tmpdir(), "grok-helper-permissions-"));
    const root = path.join(home, ".archestra/grok");
    const bin = path.join(home, "bin");
    mkdirSync(bin);
    symlinkSync(binary, path.join(bin, "grok"));
    const env = {
      ...process.env,
      HOME: home,
      GROK_HOME: path.join(home, ".grok"),
      GROK_AUTH_PATH: path.join(home, ".grok/auth.json"),
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      PATH: bin + path.delimiter + process.env.PATH,
    };
    const serverName = "review-gateway";
    const prefix = "custom__";
    const helpers = [
      ...REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
      TOOL_ASK_USER_SHORT_NAME,
    ];
    const names = [...helpers, "ordinary_probe"];
    let stage = 0;
    let calls: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: [
              {
                id: "grok-build",
                model: "grok-build",
                api_backend: "responses",
              },
            ],
            default_model: "grok-build",
          }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (body.jsonrpc === "2.0") {
        if (body.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        if (body.method === "tools/call") calls.push(body.params.name);
        const result =
          body.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "synthetic", version: "1" },
              }
            : body.method === "tools/list"
              ? {
                  tools: names.map((name) => ({
                    name: grokToolName(prefix + name),
                    description: "Synthetic permission fixture",
                    inputSchema: { type: "object", properties: {} },
                  })),
                }
              : {
                  content: [{ type: "text", text: "Synthetic helper result" }],
                  isError: false,
                };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        return;
      }
      let output: unknown[] = [
        {
          id: "msg_synthetic",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Synthetic permission check complete",
              annotations: [],
            },
          ],
        },
      ];
      if (
        body.tools?.some(
          (tool: { name?: string }) => tool.name === "search_tool",
        )
      ) {
        if (stage === 0) {
          stage++;
          output = [
            {
              id: "fc_discovery",
              call_id: "discovery",
              type: "function_call",
              name: "search_tool",
              arguments: JSON.stringify({ query: serverName, limit: 10 }),
              status: "completed",
            },
          ];
        } else if (stage === 1 || stage === 2) {
          const repeated = stage === 2;
          stage++;
          output = (repeated ? names : helpers).map((name) => ({
            id: `fc_${stage}_${name}`,
            call_id: `${stage}_${name}`,
            type: "function_call",
            name: "use_tool",
            status: "completed",
            arguments: JSON.stringify({
              tool_name: `${serverName}__${grokToolName(prefix + name)}`,
              tool_input: { synthetic: name, note: "Fixture arguments" },
            }),
          }));
        }
      }
      response.setHeader("content-type", "text/event-stream");
      response.end(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          sequence_number: 1,
          response: {
            id: "resp_synthetic",
            object: "response",
            created_at: 1,
            model: body.model,
            status: "completed",
            output,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        })}\n\n`,
      );
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected loopback fixture");
      const base = `http://127.0.0.1:${address.port}`;
      const context: SetupScriptContext = {
        clientId: "grok-build",
        platform: "linux",
        appName: "Synthetic Platform",
        skills: null,
        mcp: { serverName, toolPrefix: prefix, url: `${base}/mcp` },
        proxy: {
          authMode: "native-session",
          provider: "xai",
          providerLabel: "xAI",
          baseUrl: base,
          url: `${base}/native`,
          proxyName: "synthetic",
          virtualKey: null,
          virtualKeyName: "synthetic",
          passthroughVirtualKey: "synthetic-attribution-key",
          model: null,
        },
      };
      const setup = spawnSync("bash", ["-s"], {
        input: grokSetup.bash.sections(context).join("\n"),
        env,
        cwd: home,
        encoding: "utf8",
      });
      expect(setup.status, setup.stderr).toBe(0);
      writeFileSync(
        path.join(home, ".grok/auth.json"),
        JSON.stringify({
          "https://accounts.x.ai/sign-in": {
            key: "synthetic-native-session",
            auth_mode: "oidc",
            user_id: "synthetic-user",
            email: "synthetic@example.test",
            create_time: "2026-11-02T00:00:00Z",
            expire_time: "2099-01-01T00:00:00Z",
          },
        }),
      );
      const snapshot = path.join(root, "connection.json");
      const configured = JSON.parse(readFileSync(snapshot, "utf8"));
      for (const allowed of [false, true]) {
        stage = 0;
        calls = [];
        writeFileSync(
          snapshot,
          JSON.stringify({
            ...configured,
            guardrailToolAllowRules: allowed
              ? configured.guardrailToolAllowRules
              : [],
          }),
        );
        const result = await new Promise<{
          status: number | null;
          stderr: string;
        }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              path.join(root, "launch.cjs"),
              "--permission-mode=default",
              "--max-turns",
              "4",
              "-p",
              "Synthetic helper permission check",
              "--output-format=json",
            ],
            { env, cwd: home, stdio: ["ignore", "ignore", "pipe"] },
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
          child.on("error", reject);
          child.on("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stderr });
          });
        });
        expect(result.status, result.stderr).toBe(0);
        expect(stage).toBe(allowed ? 3 : 2);
        expect(calls.sort()).toEqual(
          allowed
            ? helpers
                .flatMap((name) => Array(2).fill(grokToolName(prefix + name)))
                .sort()
            : [],
        );
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  },
);
