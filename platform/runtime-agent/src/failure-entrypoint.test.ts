import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test.each([
  "configuration",
  "startup",
  "session_failed",
  "unwritable",
])("reports %s failures without forwarding diagnostics", async (kind) => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-failure-"));
  const server = createServer((request, response) => {
    if (kind === "session_failed" && request.url === "/mcp") {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const message = JSON.parse(body);
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "test-gateway", version: "1" },
              }
            : { tools: [] };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
        );
      });
      return;
    }
    response.writeHead(401, { "Content-Type": "text/plain" });
    response.end("synthetic-secret-do-not-forward");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server port");
    await writeFile(path.join(root, "steer"), "");
    const prefix = path.join(
      root,
      kind === "unwritable" ? "missing/turn" : "turn",
    );
    const result = await exec(
      process.execPath,
      ["--import", "tsx", path.join(import.meta.dirname, "index.ts")],
      {
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          ARCHESTRA_AGENT_RUNTIME_AGENT_ID: "test-agent",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID: "test-task",
          ARCHESTRA_AGENT_RUNTIME_TASK: "Complete the task.",
          ARCHESTRA_AGENT_RUNTIME_DIR: root,
          ARCHESTRA_AGENT_RUNTIME_STEER_FIFO: path.join(root, "steer"),
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: prefix,
          ARCHESTRA_AGENT_RUNTIME_MODE: "one_shot",
          ARCHESTRA_LLM_PROXY_URL: `http://127.0.0.1:${address.port}/v1`,
          ARCHESTRA_LLM_PROXY_PROTOCOL:
            kind === "startup" || kind === "session_failed"
              ? "openai_responses"
              : "invalid",
          ARCHESTRA_VIRTUAL_KEY: "test-key",
          ARCHESTRA_MCP_GATEWAY_URL: `http://127.0.0.1:${address.port}/mcp`,
          ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
        },
      },
    ).catch((error) => error);
    expect(result.code).toBe(
      kind === "startup" || kind === "session_failed" ? 1 : 78,
    );
    expect(result.stdout).not.toContain("synthetic-secret");
    if (kind !== "unwritable") {
      const failure = JSON.parse(await readFile(`${prefix}.failure`, "utf8"));
      expect(failure).toMatchObject({ version: 1, code: `archestra_${kind}` });
      expect(failure.message).toContain(
        kind === "startup"
          ? "MCP gateway"
          : kind === "session_failed"
            ? "provider credential"
            : "configuration",
      );
      expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
