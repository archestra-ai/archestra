import { Duplex, PassThrough, Writable } from "node:stream";
import type * as k8s from "@kubernetes/client-node";
import { Agent } from "undici";

// === Public API ===

/**
 * An HTTP dispatcher whose every connection is a port-forward stream to one
 * pod port, opened through that pod's cluster API server.
 *
 * It lets the platform speak plain HTTP to a pod in a cluster whose pod and
 * Service network it cannot reach: the only thing dialed is the API server.
 * The request URL's host is never resolved or connected to. Each connection is
 * its own port-forward stream, so a long-lived response stream and concurrent
 * requests do not wait on each other.
 *
 * The caller owns the agent and must `destroy()` it; that closes every stream.
 */
export function createPodTunnelAgent(params: {
  portForward: k8s.PortForward;
  namespace: string;
  port: number;
  /**
   * The pod a new connection goes to. Called once per connection, so a caller
   * that follows a deployment can return whichever pod is ready now.
   */
  resolvePodName: () => Promise<string>;
}): Agent {
  return new Agent({
    // One request at a time per connection: a response stream that stays open
    // must not hold back the next request.
    pipelining: 1,
    connect: (_options, callback) => {
      openPodTunnelSocket(params).then(
        // undici types the connection as a net.Socket; it only uses the
        // stream surface and the socket-option methods the tunnel provides.
        (socket) => callback(null, socket as never),
        (error: unknown) =>
          callback(
            error instanceof Error ? error : new Error(String(error)),
            null,
          ),
      );
    },
  });
}

// === Internal helpers ===

async function openPodTunnelSocket(params: {
  portForward: k8s.PortForward;
  namespace: string;
  port: number;
  resolvePodName: () => Promise<string>;
}): Promise<Duplex> {
  const podName = await params.resolvePodName();
  // The Kubernetes client reads what goes to the pod from one stream and
  // writes what comes back to another; the HTTP client wants one socket.
  const toPod = new PassThrough();
  const forwardErrors = new PassThrough();
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      toPod.write(chunk, encoding, callback);
    },
    final(callback) {
      toPod.end();
      callback();
    },
  });
  const fromPod = new Writable({
    write(chunk, _encoding, callback) {
      socket.push(chunk);
      callback();
    },
  });
  // undici sets TCP options on what it assumes is a net.Socket. None apply to
  // a stream carried inside a WebSocket.
  Object.assign(socket, {
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
    setTimeout: () => socket,
    ref: () => socket,
    unref: () => socket,
  });

  // The API server reports a failed forward (nothing listening on the port,
  // pod gone) as text on the stream's error channel.
  forwardErrors.on("data", (chunk: Buffer) => {
    socket.destroy(
      new Error(
        `Port-forward to pod ${params.namespace}/${podName}:${params.port} failed: ${chunk.toString("utf8").trim()}`,
      ),
    );
  });

  const webSocket = await params.portForward.portForward(
    params.namespace,
    podName,
    [params.port],
    fromPod,
    forwardErrors,
    toPod,
  );
  // With no retry count the client returns the WebSocket itself.
  if (typeof webSocket === "function") {
    throw new Error("Unexpected restartable port-forward stream");
  }

  webSocket.on("close", () => {
    // End of the pod's side of the connection: let the HTTP client read what
    // is buffered, then see EOF.
    socket.push(null);
  });
  webSocket.on("error", (error: Error) => {
    socket.destroy(error);
  });
  socket.on("close", () => {
    webSocket.close();
  });

  return socket;
}
