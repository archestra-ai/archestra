import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createApp } from "./server.js";

test("exchanges an ID-JAG for an MCP-server access token", async () => {
  const { baseUrl, close } = await startTestServer();

  try {
    const assertion = await mintIdJag(baseUrl);
    const accessToken = await exchangeAssertion(baseUrl, assertion);
    assert.notEqual(accessToken, assertion);
    assert.match(accessToken, /^mcp-server-at-/);

    const result = await callWhoami(baseUrl, accessToken);
    assert.equal(result.bearerToken, accessToken);
    assert.equal(result.accessToken.tokenKind, "mcp_server_access_token");
    assert.equal(result.accessToken.obtainedVia, "id_jag_jwt_bearer");
    assert.equal(result.user.email, "admin@example.com");
  } finally {
    await close();
  }
});

test("does not allow the original ID-JAG as an MCP bearer token", async () => {
  const { baseUrl, close } = await startTestServer();

  try {
    const assertion = await mintIdJag(baseUrl);
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${assertion}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });

    assert.equal(response.status, 401);
  } finally {
    await close();
  }
});

test("compiled server entrypoint starts cleanly", async () => {
  await runCommand("npx", ["tsc", "-p", "tsconfig.json"]);

  const child = spawn("node", ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "3461",
      BASE_URL: "http://127.0.0.1:3461",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exitPromise = once(child, "exit");

  try {
    assert.equal(await waitForPort(3461, 5_000), true);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
});

async function startTestServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await createApp({ baseUrl, port });
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function mintIdJag(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/demo-idp/mint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sub: "admin",
      email: "admin@example.com",
      name: "Admin User",
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { assertion: string };
  return body.assertion;
}

async function exchangeAssertion(
  baseUrl: string,
  assertion: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("id-jag-resource-client:id-jag-resource-secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

async function callWhoami(baseUrl: string, accessToken: string) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "whoami",
        arguments: {},
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  return JSON.parse(body.result.content[0]?.text) as {
    user: { email: string };
    authorizationHeader: string;
    bearerToken: string;
    accessToken: {
      tokenKind: string;
      obtainedVia: string;
    };
  };
}

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return false;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [exitCode, stdout, stderr] = (await Promise.all([
    once(child, "exit"),
    readStream(child.stdout),
    readStream(child.stderr),
  ])) as [[number | null], string, string];

  assert.equal(
    exitCode[0],
    0,
    `Command failed: ${command} ${args.join(" ")}\n${stdout}\n${stderr}`,
  );
}

async function readStream(
  stream: NodeJS.ReadableStream | null,
): Promise<string> {
  if (!stream) {
    return "";
  }

  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk.toString());
  }
  return chunks.join("");
}
