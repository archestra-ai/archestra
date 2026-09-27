import type { Attach } from "@kubernetes/client-node";
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
    });

    await transport.start();
    await transport.send({ jsonrpc: "2.0", method: "ping", id: 1 });
    // stdin is a Readable in flowing-ish setup; drain microtasks so 'data' fires.
    await new Promise((resolve) => setImmediate(resolve));
    expect(pushed.length).toBe(1);

    await transport.close();
    expect(fakeWs.close).toHaveBeenCalled();
  });
});
