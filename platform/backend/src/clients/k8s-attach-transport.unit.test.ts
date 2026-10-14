import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import type { Attach } from "@kubernetes/client-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { K8sAttachTransport } from "./k8s-attach-transport";

describe("K8sAttachTransport", () => {
  test("close() during a pending attach closes the late websocket and keeps the transport closed", async () => {
    const fakeWs = { close: vi.fn(), on: vi.fn() };
    let resolveAttach!: (ws: typeof fakeWs) => void;
    const attach = vi.fn(
      () =>
        new Promise<typeof fakeWs>((resolve) => {
          resolveAttach = resolve;
        }),
    );
    const transport = new K8sAttachTransport({
      k8sAttach: { attach } as unknown as Attach,
      namespace: "ns",
      podName: "pod",
      containerName: "container",
      startTimeoutMs: 5_000,
    });

    const startPromise = transport.start();
    // attach() is in flight; close the transport before it resolves.
    await transport.close();
    resolveAttach(fakeWs);
    // A canceled start must not look like a successful one.
    await expect(startPromise).rejects.toThrow(
      "Transport closed before attach completed",
    );

    // The late-arriving websocket must be closed, not adopted.
    expect(fakeWs.close).toHaveBeenCalled();
    // The transport must stay closed: sending is rejected.
    await expect(
      transport.send({ jsonrpc: "2.0", method: "ping", id: 1 }),
    ).rejects.toThrow("Transport not started");
  });

  test("normal start adopts the websocket and send() works", async () => {
    const pushed: unknown[] = [];
    const fakeWs = { close: vi.fn(), on: vi.fn() };
    const attach = vi.fn(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _stdout: unknown,
        _stderr: unknown,
        stdin: { on: (event: string, cb: (chunk: unknown) => void) => void },
      ) => {
        stdin.on("data", (chunk) => pushed.push(chunk));
        return Promise.resolve(fakeWs as unknown as WebSocket);
      },
    );
    const transport = new K8sAttachTransport({
      k8sAttach: { attach } as unknown as Attach,
      namespace: "ns",
      podName: "pod",
      containerName: "container",
      startTimeoutMs: 5_000,
    });

    await transport.start();
    await transport.send({ jsonrpc: "2.0", method: "ping", id: 1 });
    // stdin is a Readable in flowing-ish setup; drain microtasks so 'data' fires.
    await new Promise((resolve) => setImmediate(resolve));
    expect(pushed.length).toBe(1);

    await transport.close();
    expect(fakeWs.close).toHaveBeenCalled();
  });

  test("start() fails when the attach never completes, and the late websocket is closed", async () => {
    const fakeWs = { close: vi.fn(), on: vi.fn() };
    let resolveAttach!: (ws: typeof fakeWs) => void;
    const transport = new K8sAttachTransport({
      k8sAttach: {
        attach: () =>
          new Promise((resolve) => {
            resolveAttach = resolve;
          }),
      } as unknown as Attach,
      namespace: "ns",
      podName: "pod",
      containerName: "container",
      startTimeoutMs: 20,
    });

    await expect(transport.start()).rejects.toThrow("Timed out");
    resolveAttach(fakeWs);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakeWs.close).toHaveBeenCalled();
  });

  test("a closed attach fails the pending request at once", async () => {
    const ws = new EventEmitter() as EventEmitter & { close: () => void };
    ws.close = vi.fn();
    let stdout!: Writable;
    const transport = new K8sAttachTransport({
      k8sAttach: {
        attach: (
          _ns: string,
          _pod: string,
          _container: string,
          out: Writable,
          _err: unknown,
          stdin: EventEmitter,
        ) => {
          stdout = out;
          // Answer the handshake; leave every later request unanswered.
          stdin.on("data", (chunk: Buffer) => {
            const request = JSON.parse(chunk.toString());
            if (request.method !== "initialize") return;
            stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: {
                  protocolVersion: request.params.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: "pod", version: "1" },
                },
              })}\n`,
            );
          });
          return Promise.resolve(ws as unknown as WebSocket);
        },
      } as unknown as Attach,
      namespace: "ns",
      podName: "pod",
      containerName: "container",
      startTimeoutMs: 5_000,
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);

    const call = client.callTool({ name: "slow" }, undefined, {
      timeout: 60_000,
    });
    ws.emit("close");

    await expect(call).rejects.toThrow("Connection closed");
  });

  test("a stray non-JSON line does not hold back the reply written with it", async () => {
    const pod = fakePod();
    const conn = await pod.connect();

    const wireId = await conn.request(1);
    pod.stdout(`startup log line\n${reply(wireId)}\n`);

    expect(conn.received).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  test("connections sharing one pod stdout each get only their own reply", async () => {
    const pod = fakePod();
    const a = await pod.connect();
    const b = await pod.connect();

    // Both SDK clients number from 0, so their ids collide.
    const aWire = await a.request(2);
    const bWire = await b.request(2);
    expect(aWire).not.toBe(bWire);
    pod.stdout(`${reply(bWire, "B")}\n${reply(aWire, "A")}\n`);

    expect(a.received).toEqual([
      { jsonrpc: "2.0", id: 2, result: { tag: "A" } },
    ]);
    expect(b.received).toEqual([
      { jsonrpc: "2.0", id: 2, result: { tag: "B" } },
    ]);
  });

  test("replies this connection cannot claim are dropped", async () => {
    const pod = fakePod();
    const conn = await pod.connect();
    const wireId = await conn.request(3);

    pod.stdout(
      [
        // An error nobody owns, and the bare SDK id another client might use.
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
        reply(3, "foreign"),
        reply(wireId),
        // A second reply to an already answered request.
        reply(wireId),
        "",
      ].join("\n"),
    );

    expect(conn.received).toEqual([{ jsonrpc: "2.0", id: 3, result: {} }]);
  });

  test("cancellations and progress tokens use this connection's ids", async () => {
    const pod = fakePod();
    const conn = await pod.connect();

    const wireId = await conn.request(4, { progressToken: 4 });
    const sent = pod.sentBy(conn);
    const wireToken = (
      sent[0] as { params: { _meta: { progressToken: string } } }
    ).params._meta.progressToken;
    expect(wireToken).not.toBe(4);

    pod.stdout(
      `${progress(wireToken)}\n${progress(4)}\n${progress("someone-else")}\n`,
    );
    expect(conn.received).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: 4, progress: 1 },
      },
    ]);

    await conn.transport.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 4, reason: "timed out" },
    });
    expect(pod.sentBy(conn)[1]).toMatchObject({
      method: "notifications/cancelled",
      params: { requestId: wireId },
    });
    // The SDK gave up on the request, so a late reply is not delivered.
    pod.stdout(`${reply(wireId)}\n`);
    expect(conn.received).toHaveLength(1);
  });

  test("a reply over the size cap fails only its own request, without buffering it whole", async () => {
    const pod = fakePod();
    const conn = await pod.connect();
    const other = await pod.connect();
    const oversizedWire = await conn.request(7);
    const nextWire = await conn.request(8);
    const megabyte = "x".repeat(1024 * 1024);

    // 11 MB streamed in 1 MB chunks, the way an attach delivers it, to every
    // attach of the pod, followed by an ordinary reply in the same chunk as
    // the oversized line's end.
    pod.stdout(
      `{"jsonrpc":"2.0","id":"${oversizedWire}","result":{"content":"`,
    );
    for (let i = 0; i < 11; i++) pod.stdout(megabyte);
    pod.stdout(`"}}\n${reply(nextWire)}\n`);

    expect(conn.received).toEqual([
      {
        jsonrpc: "2.0",
        id: 7,
        error: expect.objectContaining({
          message: expect.stringContaining("larger than 10 MB"),
        }),
      },
      { jsonrpc: "2.0", id: 8, result: {} },
    ]);
    // The other attach saw the same line and discarded it without an error.
    expect(other.received).toEqual([]);
  });

  test("an oversized reply whose id comes last is still answered", async () => {
    const pod = fakePod();
    const conn = await pod.connect();
    const wireId = await conn.request(9);

    pod.stdout(
      `{"result":{"content":"${"y".repeat(11 * 1024 * 1024)}","nested":{"id":99}},"jsonrpc":"2.0","id":"${wireId}"}\n`,
    );

    expect(conn.received).toEqual([
      expect.objectContaining({ id: 9, error: expect.anything() }),
    ]);
  });
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * A stdio pod with any number of attaches: like the container runtime, it
 * copies stdout to every attach.
 */
function fakePod() {
  const stdouts: Writable[] = [];
  const sent = new Map<K8sAttachTransport, JSONRPCMessage[]>();
  return {
    stdout: (text: string) => {
      for (const stdout of stdouts) stdout.write(Buffer.from(text));
    },
    sentBy: (conn: { transport: K8sAttachTransport }) =>
      sent.get(conn.transport) ?? [],
    connect: async () => {
      const messages: JSONRPCMessage[] = [];
      const transport = new K8sAttachTransport({
        k8sAttach: {
          attach: (
            _ns: string,
            _pod: string,
            _container: string,
            out: Writable,
            _err: unknown,
            stdin: EventEmitter,
          ) => {
            stdouts.push(out);
            stdin.on("data", (chunk: Buffer) => {
              for (const line of chunk.toString().split("\n")) {
                if (line) messages.push(JSON.parse(line));
              }
            });
            return Promise.resolve({ close: vi.fn(), on: vi.fn() });
          },
        } as unknown as Attach,
        namespace: "ns",
        podName: "pod",
        containerName: "container",
        startTimeoutMs: 5_000,
      });
      sent.set(transport, messages);
      const received: JSONRPCMessage[] = [];
      transport.onmessage = (message) => received.push(message);
      await transport.start();
      return {
        transport,
        received,
        /** Send a request with the SDK's id; resolves to the id the pod saw. */
        request: async (id: number, meta?: { progressToken: number }) => {
          await transport.send({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "t", ...(meta && { _meta: meta }) },
          });
          await new Promise((resolve) => setImmediate(resolve));
          const last = messages.at(-1) as { id: string };
          return last.id;
        },
      };
    },
  };
}

function reply(id: string | number, tag?: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: tag ? { tag } : {},
  });
}

function progress(progressToken: string | number) {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken, progress: 1 },
  });
}
