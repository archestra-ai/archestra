import { EventEmitter } from "node:events";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Readable, Writable } from "node:stream";
import type * as k8s from "@kubernetes/client-node";
import { type Agent, fetch } from "undici";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createPodTunnelAgent } from "./pod-tunnel";

/**
 * Stands in for the API server's port-forward endpoint: each stream is a TCP
 * connection to a local "pod" HTTP server. Only the Kubernetes client is
 * faked; undici and the HTTP exchange are real.
 */
class FakePortForward {
  readonly streams: Array<{
    namespace: string;
    podName: string;
    port: number;
    webSocket: EventEmitter & { close: () => void; closed: boolean };
  }> = [];
  failWith: string | null = null;

  constructor(private readonly podServerPort: () => number) {}

  async portForward(
    namespace: string,
    podName: string,
    targetPorts: number[],
    output: Writable,
    err: Writable | null,
    input: Readable,
  ) {
    const webSocket = Object.assign(new EventEmitter(), {
      closed: false,
      close: () => {
        if (webSocket.closed) return;
        webSocket.closed = true;
        podConnection?.destroy();
        webSocket.emit("close");
      },
    });
    let podConnection: net.Socket | undefined;
    this.streams.push({ namespace, podName, port: targetPorts[0], webSocket });

    if (this.failWith) {
      const message = this.failWith;
      setImmediate(() => err?.write(message));
      return webSocket as never;
    }

    podConnection = net.connect(this.podServerPort(), "127.0.0.1");
    podConnection.on("data", (chunk) => output.write(chunk));
    podConnection.on("close", () => webSocket.close());
    input.on("data", (chunk) => podConnection?.write(chunk));
    return webSocket as never;
  }
}

describe("createPodTunnelAgent", () => {
  let podServer: http.Server;
  let portForward: FakePortForward;
  let agent: Agent;
  let releaseStream: (() => void) | undefined;

  beforeEach(async () => {
    podServer = http.createServer((request, response) => {
      if (request.url === "/stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        releaseStream = () => response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          path: request.url,
          authorization: request.headers.authorization ?? null,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      podServer.listen(0, "127.0.0.1", resolve),
    );
    portForward = new FakePortForward(
      () => (podServer.address() as AddressInfo).port,
    );
    agent = createPodTunnelAgent({
      portForward: portForward as unknown as k8s.PortForward,
      namespace: "team-a",
      port: 8080,
      resolvePodName: async () => "mcp-server-abc",
    });
  });

  afterEach(async () => {
    releaseStream?.();
    releaseStream = undefined;
    await agent.destroy();
    await new Promise((resolve) => podServer.close(resolve));
  });

  test("sends the request to the pod through a port-forward stream, with its headers", async () => {
    const response = await fetch(
      "http://mcp-server.team-a.svc.cluster.invalid:8080/mcp",
      { dispatcher: agent, headers: { authorization: "Bearer server-token" } },
    );

    expect(await response.json()).toEqual({
      path: "/mcp",
      authorization: "Bearer server-token",
    });
    expect(portForward.streams).toHaveLength(1);
    expect(portForward.streams[0]).toMatchObject({
      namespace: "team-a",
      podName: "mcp-server-abc",
      port: 8080,
    });
  });

  test("serves a request while a response stream is still open", async () => {
    const stream = await fetch("http://pod.invalid:8080/stream", {
      dispatcher: agent,
    });
    const reader = stream.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("data: first\n\n");

    const response = await fetch("http://pod.invalid:8080/mcp", {
      dispatcher: agent,
    });

    expect(response.status).toBe(200);
    expect(portForward.streams).toHaveLength(2);
    await reader?.cancel();
  });

  test("fails the request with the API server's forward error", async () => {
    portForward.failWith =
      "an error occurred forwarding 8080 -> 8080: connection refused";

    await expect(
      fetch("http://pod.invalid:8080/mcp", { dispatcher: agent }),
    ).rejects.toMatchObject({
      cause: {
        message: expect.stringContaining(
          "Port-forward to pod team-a/mcp-server-abc:8080 failed: an error occurred forwarding 8080 -> 8080: connection refused",
        ),
      },
    });
  });

  test("fails the request when no pod can be chosen", async () => {
    const noPodAgent = createPodTunnelAgent({
      portForward: portForward as unknown as k8s.PortForward,
      namespace: "team-a",
      port: 8080,
      resolvePodName: async () => {
        throw new Error("No running pod for this MCP server");
      },
    });

    await expect(
      fetch("http://pod.invalid:8080/mcp", { dispatcher: noPodAgent }),
    ).rejects.toMatchObject({
      cause: { message: "No running pod for this MCP server" },
    });
    expect(portForward.streams).toHaveLength(0);
    await noPodAgent.destroy();
  });

  test("closes its port-forward streams when destroyed", async () => {
    const stream = await fetch("http://pod.invalid:8080/stream", {
      dispatcher: agent,
    });
    await stream.body?.getReader().read();
    expect(portForward.streams[0].webSocket.closed).toBe(false);

    await agent.destroy();

    expect(portForward.streams[0].webSocket.closed).toBe(true);
  });
});
