import { createServer } from "node:http";
import { Exec, KubeConfig } from "@kubernetes/client-node";
import { stdSerializers } from "pino";
import { expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { execAgentRuntimeCommand, streamAgentRuntimeCommand } from "./exec";

for (const streaming of [false, true]) {
  test.for([
    401, 403, 429, 500, 503,
  ])(`reports HTTP %i from a real ${streaming ? "streaming" : "buffered"} exec handshake`, async (status) => {
    const server = createServer((_request, response) => {
      response.writeHead(status);
      response.end("synthetic-private-response");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const options = connectionOptions(server);
      const execute = () => {
        if (!streaming) return execAgentRuntimeCommand(options);
        const result = streamAgentRuntimeCommand(options);
        result.stdout.on("error", () => {});
        return result.completed;
      };
      const error = await execute().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected an Error");
      const serialized = stdSerializers.err(error);
      expect(serialized.message).toBe(
        `Agent Runtime exec connection failed (HTTP ${status})`,
      );
      expect(JSON.stringify(serialized)).not.toContain(
        "synthetic-private-response",
      );
      expect(JSON.stringify(serialized)).not.toContain("synthetic-token");
      // Diagnostics must not silently opt denied access or server failures
      // into the completion monitor's existing retry policy.
      expect(error).not.toHaveProperty("code");
      expect(error.constructor).toBe(Error);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("reports a real socket reset without including connection details", async () => {
  const server = createServer();
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await expect(
      execAgentRuntimeCommand(connectionOptions(server)),
    ).rejects.toThrow(/^Agent Runtime exec connection failed \(ECONNRESET\)$/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("still reads output and exit status through the real SDK", async () => {
  const server = createServer();
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (socket) => {
    socket.send(Buffer.concat([Buffer.from([1]), Buffer.from("finished")]));
    socket.send(
      Buffer.concat([
        Buffer.from([3]),
        Buffer.from(JSON.stringify({ status: "Success" })),
      ]),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await expect(
      execAgentRuntimeCommand(connectionOptions(server)),
    ).resolves.toBe("finished");
  } finally {
    websocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function connectionOptions(server: ReturnType<typeof createServer>) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing loopback listener");
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [
      {
        name: "synthetic",
        server: `http://127.0.0.1:${address.port}`,
        skipTLSVerify: true,
      },
    ],
    users: [{ name: "synthetic", token: "synthetic-token" }],
    contexts: [{ name: "synthetic", cluster: "synthetic", user: "synthetic" }],
    currentContext: "synthetic",
  });
  return {
    exec: new Exec(config),
    namespace: "synthetic",
    podName: "synthetic",
    container: "agent-runtime",
    command: ["true"],
    timeoutMs: 3_000,
  };
}
