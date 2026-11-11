// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import { grokToolName } from "@/routes/mcp-gateway/grok-tool-names";
import { extractGatewayToolDeclarations } from "./gateway-tool-declarations";
import { resolveGatewayToolIdentity } from "./gateway-tool-names";
import { GrokDeferredTools } from "./grok-deferred-tools";

test.skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY).each([false, true])(
  "official Grok child discovers remedy and review controls (remembered=%s) before executing their exact arguments",
  async (remembered) => {
    const home = await mkdtemp(path.join(tmpdir(), "grok-child-controls-"));
    const nativeHome = path.join(home, "native");
    await mkdir(nativeHome);
    const authPath = path.join(home, "synthetic-auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
          key: "synthetic-access",
          auth_mode: "oidc",
          oidc_issuer: "https://auth.x.ai",
          oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
          user_id: "synthetic",
          expires_at: "2099-01-01T00:00:00Z",
          create_time: new Date().toISOString(),
        },
      }),
    );
    const organizationId = randomUUID();
    const gatewayId = randomUUID();
    const controls = [
      {
        name: "archestra__execute_remedy_plan",
        args: {
          offer_id: "synthetic-child-offer",
          plan: "Submit for approval",
        },
        description: "Apply a remedy plan offered by guardrails.",
      },
      {
        name: "archestra__ask_user",
        args: {
          question: "Review the held call",
          options: [{ label: "Approve" }, { label: "Deny" }],
          remedy_offer_ids: ["synthetic-child-offer"],
        },
        description: "Ask the user to decide an offer-bound guardrails review.",
      },
    ];
    let parentId: string | undefined;
    let parentStarted = false;
    let childStage = 0;
    const received: { name: string; arguments: unknown }[] = [];
    const searches: string[] = [];
    const failures: unknown[] = [];
    let running: ReturnType<typeof spawn> | undefined;
    const message = (text: string) => ({
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
    const server = createServer(async (request, response) => {
      try {
        response.setHeader("content-type", "application/json");
        if (request.method !== "POST") {
          response.end(
            JSON.stringify({
              data: [
                {
                  id: "synthetic",
                  model: "synthetic",
                  api_backend: "responses",
                },
              ],
              default_model: "synthetic",
            }),
          );
          return;
        }
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        if (body.jsonrpc === "2.0") {
          if (body.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          let result: object = {};
          if (body.method === "initialize")
            result = {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic", version: "1" },
            };
          else if (body.method === "tools/list")
            result = {
              tools: [
                ...controls,
                {
                  name: "archestra__get_remedy_plans",
                  description:
                    "Read the ruling and remedy plans for a held call.",
                },
              ].map((control) => ({
                name: grokToolName(control.name),
                description: attestToolDescription({
                  organizationId,
                  gatewayId,
                  advertisedName: control.name,
                  kind: "b",
                  description: control.description,
                }),
                inputSchema: { type: "object", properties: {} },
              })),
            };
          else if (body.method === "tools/call") {
            received.push({
              name: body.params.name,
              arguments: body.params.arguments,
            });
            result = {
              content: [{ type: "text", text: "SYNTHETIC_CONTROL_RECEIVED" }],
            };
          }
          response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
          return;
        }
        const sid = String(request.headers["x-grok-session-id"] ?? "");
        let output: object[] = [message("Synthetic auxiliary request.")];
        if (
          sid &&
          !String(request.headers["x-grok-conv-id"] ?? "").startsWith(
            "turn-summary-",
          )
        ) {
          parentId ??= sid;
          let call: { id: string; name: string; arguments: string } | undefined;
          if (sid === parentId && !parentStarted) {
            parentStarted = true;
            call = {
              id: "spawn",
              name: "spawn_subagent",
              arguments: JSON.stringify({
                description: "Synthetic child control discovery",
                prompt: "Run the synthetic control test.",
                background: false,
              }),
            };
          } else if (sid !== parentId && received.length < controls.length) {
            const control = controls[received.length];
            const bridge = new GrokDeferredTools(body);
            const declarations = extractGatewayToolDeclarations(body);
            declarations.push(
              ...bridge.prepare({
                organizationId,
                interactionType: "xai:responses",
                body,
              }),
            );
            bridge.bindIdentity(
              await resolveGatewayToolIdentity({
                organizationId,
                declarations,
                internalChat: false,
              }),
            );
            const [repaired] = bridge.wrapCalls(
              bridge.unwrapCalls([
                {
                  id: `child-control-${childStage++}`,
                  name: "use_tool",
                  arguments: JSON.stringify({
                    tool_name: remembered
                      ? `archestra__${grokToolName(control.name)}`
                      : control.name,
                    tool_input: control.args,
                  }),
                },
              ]),
            );
            expect(repaired).toBeDefined();
            expect(childStage).toBeLessThanOrEqual(4);
            call = repaired;
            if (call.name === "search_tool")
              searches.push(JSON.parse(call.arguments).query);
          } else output = [message("SYNTHETIC_CHILD_CONTROLS_COMPLETE")];
          if (call)
            output = [
              {
                type: "function_call",
                id: `fc_${call.id}`,
                call_id: call.id,
                name: call.name,
                arguments: call.arguments,
                status: "completed",
              },
            ];
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
      } catch (error) {
        failures.push(error);
        running?.kill("SIGTERM");
        response.writeHead(502).end("Synthetic fixture failed.");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await writeFile(
        path.join(nativeHome, "config.toml"),
        `[mcp_servers.archestra]\nurl = "${base}/mcp"\n`,
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(GROK_|XAI_)/.test(key),
        ),
      );
      Object.assign(env, {
        HOME: home,
        GROK_HOME: nativeHome,
        GROK_AUTH_PATH: authPath,
        GROK_CLI_CHAT_PROXY_BASE_URL: base,
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_TELEMETRY_ENABLED: "0",
        GROK_DISABLE_API_KEY_AUTH: "1",
        NO_PROXY: "127.0.0.1",
      });
      const result = await new Promise<{ code: number | null; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.env.ARCHESTRA_GROK_TEST_BINARY as string,
            [
              "--permission-mode=bypassPermissions",
              "-m",
              "synthetic",
              "-p",
              "Run one synthetic child control test.",
              "--output-format=json",
              "--max-turns",
              "4",
            ],
            { cwd: home, env, stdio: ["ignore", "ignore", "pipe"] },
          );
          running = child;
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
          child.once("error", reject);
          child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stderr });
          });
        },
      );
      expect(failures).toEqual([]);
      expect(result.code, result.stderr.slice(-1500)).toBe(0);
      expect(received).toEqual(
        controls.map(({ name, args }) => ({
          name: grokToolName(name),
          arguments: args,
        })),
      );
      expect(searches).toEqual(["archestra execute_remedy_plan"]);
      expect(childStage).toBe(3);
    } finally {
      running?.kill("SIGTERM");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
