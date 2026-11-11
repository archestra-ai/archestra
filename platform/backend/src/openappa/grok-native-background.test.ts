// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { collectAndStripChildReturns } from "./child-return";

// The real CLI supplies the batch framing; only its model and login are
// synthetic. Durable return admission is covered by grok-native-subagents.
test.skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)(
  "official Grok batched background retrieval preserves both child IDs and exact values",
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "grok-native-batch-"));
    const authPath = path.join(home, "synthetic-auth.json");
    await mkdir(path.join(home, "native"));
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
    let root: string | undefined;
    let stage = 0;
    const ids: string[] = [];
    const completions: { childNativeId?: string; value: string }[] = [];
    const failures: unknown[] = [];
    let running: ReturnType<typeof spawn> | undefined;
    const message = (text: string) => ({
      type: "message",
      id: "msg_synthetic",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
    const call = (id: string, name: string, args: object) => ({
      type: "function_call",
      id: `fc_${id}`,
      call_id: id,
      name,
      arguments: JSON.stringify(args),
      status: "completed",
    });
    const server = createServer(async (request, response) => {
      try {
        response.setHeader("Content-Type", "application/json");
        if (request.method === "GET") {
          response.end(
            JSON.stringify({
              data: [
                {
                  id: "synthetic",
                  model: "synthetic",
                  api_backend: "responses",
                  context_window: 200000,
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
        const sid = String(request.headers["x-grok-session-id"] ?? "");
        if (sid) root ??= sid;
        const primary = !String(
          request.headers["x-grok-conv-id"] ?? "",
        ).startsWith("turn-summary-");
        let output: object[] = [message("Complete.")];
        if (primary && sid && sid === root) {
          for (const item of body.input ?? []) {
            if (
              item.type === "function_call_output" &&
              ["spawn-a", "spawn-b"].includes(item.call_id) &&
              typeof item.output === "string"
            ) {
              const id = item.output.match(/subagent_id: ([0-9a-f-]{36})/)?.[1];
              if (id && !ids.includes(id)) ids.push(id);
            }
          }
          const collected = collectAndStripChildReturns(body, {
            grokSubagentReturns: true,
          });
          completions.push(
            ...collected.completions.map(({ childNativeId, value }) => ({
              childNativeId,
              value,
            })),
          );
          if (stage < 2) {
            const letter = stage++ === 0 ? "A" : "B";
            output = [
              call(`spawn-${letter.toLowerCase()}`, "spawn_subagent", {
                prompt: `Reply exactly CHILD_BG_${letter}. Use no tools.`,
                description: `Synthetic ${letter}`,
                background: true,
              }),
            ];
          } else if (stage === 2) {
            stage++;
            expect(ids).toHaveLength(2);
            output = [
              call("wait-both", "get_command_or_subagent_output", {
                task_ids: ids,
                timeout_ms: 10000,
              }),
            ];
          }
        } else if (primary && sid) {
          output = [
            message(
              JSON.stringify(body.input).includes("CHILD_BG_A")
                ? "CHILD_BG_A"
                : "CHILD_BG_B",
            ),
          ];
        }
        response.setHeader("Content-Type", "text/event-stream");
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
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(GROK_|XAI_)/.test(key),
        ),
      );
      Object.assign(env, {
        HOME: home,
        GROK_HOME: path.join(home, "native"),
        GROK_AUTH_PATH: authPath,
        GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
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
              "Synthetic two background children.",
              "--output-format=json",
              "--max-turns",
              "6",
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
      expect(ids).toHaveLength(2);
      expect(completions).toEqual([
        { childNativeId: ids[0], value: "CHILD_BG_A" },
        { childNativeId: ids[1], value: "CHILD_BG_B" },
      ]);
    } finally {
      running?.kill("SIGTERM");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
