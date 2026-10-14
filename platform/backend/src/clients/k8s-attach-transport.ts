import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import type { Attach } from "@kubernetes/client-node";
import {
  deserializeMessage,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  type JSONRPCMessage,
  type ProgressToken,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type WebSocket from "ws";
import logger from "@/logging";

interface K8sAttachTransportParams {
  k8sAttach: Attach;
  namespace: string;
  podName: string;
  containerName: string;
  /** Bound on the k8s attach handshake; a pod that never answers fails start(). */
  startTimeoutMs: number;
}

/**
 * MCP Transport that uses Kubernetes attach to communicate with pods via stdio
 * This allows us to use the MCP SDK Client with stdio-based MCP servers running in K8s
 *
 * Every conversation and every replica opens its own attach to the same pod,
 * and the container runtime copies the pod's stdout to all of them. Each SDK
 * client numbers its requests from 0, so a bare id would let one attach accept
 * another's reply. The transport therefore gives each instance its own
 * request-id space: outgoing request ids (and the progress tokens and
 * cancellations that refer to them) are rewritten to ids unique to this
 * instance, and only replies carrying those ids are delivered, under the
 * original id. Server-to-client requests and other server notifications are
 * not ours to attribute and still reach every attach.
 */
export class K8sAttachTransport implements Transport {
  private ws?: WebSocket;
  private stdinStream?: Readable;
  private lineReader = new StdoutLineReader();
  private isStarted = false;
  private closed = false;
  private readonly idPrefix = `archestra-${randomUUID()}-`;
  private nextWireId = 0;
  // Our in-flight requests, by the id the pod sees.
  private pending = new Map<
    string,
    { id: RequestId; progressToken?: { wire: string; original: ProgressToken } }
  >();
  private wireIdByOriginal = new Map<RequestId, string>();
  private progressTokens = new Map<string, ProgressToken>();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private params: K8sAttachTransportParams) {}

  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }
    // The transport is single-use: callers construct a fresh instance per
    // connection, so starting after close() is a bug, not a restart.
    if (this.closed) {
      throw new Error("Transport closed before attach completed");
    }

    const { k8sAttach, namespace, podName, containerName } = this.params;

    return new Promise((resolve, reject) => {
      // Without a bound, an attach the API server never answers parks start()
      // forever, and every call queued behind this connection with it.
      const startTimer = setTimeout(() => {
        this.closed = true;
        reject(
          new Error(
            `Timed out after ${this.params.startTimeoutMs}ms attaching to MCP server pod ${podName}`,
          ),
        );
      }, this.params.startTimeoutMs);

      // Create stdin stream that stays open for continuous communication
      this.stdinStream = new Readable({
        read() {
          // No-op - we'll push data manually via send()
        },
      });

      // Create stdout stream that processes JSON-RPC responses continuously
      const stdoutStream = new Writable({
        write: (chunk, _encoding, callback) => {
          for (const line of this.lineReader.append(chunk)) {
            if (line.kind === "oversized") {
              this.failOversizedReply(line.id);
              continue;
            }
            // Parse each line on its own: one bad line must not hold back the
            // complete replies behind it in the same chunk.
            try {
              const message = this.claimIncoming(deserializeMessage(line.text));
              if (message) this.onmessage?.(message);
            } catch (error) {
              // The MCP server might output non-JSON lines (startup messages,
              // debug output, etc.) between JSON-RPC messages.
              logger.debug(
                {
                  err: error,
                  podName: this.params.podName,
                  containerName: this.params.containerName,
                },
                "Failed to parse message from MCP server stdout - skipping invalid line",
              );
            }
          }

          callback();
        },
      });

      // Handle stream errors
      stdoutStream.on("error", (error) => {
        logger.error({ err: error }, "K8sAttachTransport stdout error");
        this.onerror?.(error);
      });

      this.stdinStream.on("error", (error) => {
        logger.error({ err: error }, "K8sAttachTransport stdin error");
        this.onerror?.(error);
      });

      // Attach to pod with persistent connection
      k8sAttach
        .attach(
          namespace,
          podName,
          containerName,
          stdoutStream,
          null, // stderr - not needed for JSON-RPC
          this.stdinStream,
          false /* tty */,
        )
        .then((ws) => {
          clearTimeout(startTimer);
          // close() or the start timeout may have run while attach was in
          // flight — the just-arrived websocket has no owner then, so shut it
          // down instead of adopting it, and fail the start: callers must not
          // treat a canceled transport as successfully started.
          if (this.closed) {
            ws.close();
            reject(new Error("Transport closed before attach completed"));
            return;
          }

          this.ws = ws;
          this.isStarted = true;

          // Handle WebSocket close
          ws.on("close", () => {
            logger.debug(
              { podName, containerName },
              "K8sAttachTransport WebSocket closed",
            );
            this.isStarted = false;
            this.onclose?.();
          });

          // Handle WebSocket errors
          ws.on("error", (error: Error) => {
            logger.error(
              { err: error, podName, containerName },
              "K8sAttachTransport WebSocket error",
            );
            this.onerror?.(error);
          });

          resolve();
        })
        .catch((error) => {
          clearTimeout(startTimer);
          logger.error(
            { err: error, podName, containerName },
            "Failed to attach to pod",
          );
          reject(error);
        });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.isStarted || !this.stdinStream) {
      throw new Error("Transport not started");
    }

    const serialized = serializeMessage(this.toWire(message));
    this.stdinStream.push(serialized);
  }

  async close(): Promise<void> {
    this.closed = true;

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    if (this.stdinStream) {
      this.stdinStream.push(null); // Signal EOF
      this.stdinStream = undefined;
    }

    this.isStarted = false;
    this.lineReader.clear();
    this.pending.clear();
    this.wireIdByOriginal.clear();
    this.progressTokens.clear();
    this.onclose?.();
  }

  /**
   * A reply over the size cap is dropped rather than buffered. Answer its
   * request with an error so only that call fails, at once, instead of the
   * caller waiting out its timeout.
   */
  private failOversizedReply(wireId: string | number | undefined): void {
    const { podName, containerName } = this.params;
    // Every attach sees the line; only the one that sent the request answers.
    const request =
      typeof wireId === "string" ? this.releaseRequest(wireId) : undefined;
    if (!request) {
      logger.debug(
        { podName, containerName },
        "Discarded an oversized MCP server stdout line that is not a reply to this connection",
      );
      return;
    }
    logger.warn(
      {
        podName,
        containerName,
        id: request.id,
        maxBytes: STDIO_DEFAULT_MAX_BUFFER_SIZE,
      },
      "Dropped an MCP server stdout message over the size limit",
    );
    this.onmessage?.({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: ErrorCode.InternalError,
        message: `The MCP server's reply was larger than ${STDIO_DEFAULT_MAX_BUFFER_SIZE / (1024 * 1024)} MB, so this tool call was stopped. Ask for less data, for example with a filter or a limit.`,
      },
    });
  }

  /** Move an outgoing message into this instance's id space. */
  private toWire(message: JSONRPCMessage): JSONRPCMessage {
    if ("method" in message && "id" in message) {
      const wireId = `${this.idPrefix}${this.nextWireId++}`;
      const progressToken = message.params?._meta?.progressToken;
      const progress =
        progressToken === undefined
          ? undefined
          : { wire: `${wireId}:progress`, original: progressToken };
      this.pending.set(wireId, { id: message.id, progressToken: progress });
      this.wireIdByOriginal.set(message.id, wireId);
      if (progress) this.progressTokens.set(progress.wire, progress.original);
      return {
        ...message,
        id: wireId,
        ...(progress && {
          params: {
            ...message.params,
            _meta: { ...message.params?._meta, progressToken: progress.wire },
          },
        }),
      };
    }
    if (
      "method" in message &&
      message.method === "notifications/cancelled" &&
      message.params?.requestId !== undefined
    ) {
      const wireId = this.wireIdByOriginal.get(
        message.params.requestId as RequestId,
      );
      if (wireId === undefined) return message;
      // The SDK has given up on the request; a late reply is dropped.
      this.releaseRequest(wireId);
      return { ...message, params: { ...message.params, requestId: wireId } };
    }
    return message;
  }

  /**
   * Restore an incoming message to the SDK's ids, or drop it when it answers a
   * request this instance did not send.
   */
  private claimIncoming(message: JSONRPCMessage): JSONRPCMessage | undefined {
    const { podName, containerName } = this.params;
    if (!("method" in message)) {
      const request =
        typeof message.id === "string"
          ? this.releaseRequest(message.id)
          : undefined;
      if (!request) {
        // A reply to another attach's request, or an error with a null id
        // that cannot be attributed to anyone.
        logger.debug(
          { podName, containerName },
          "Dropped an MCP server reply that is not for this connection",
        );
        return undefined;
      }
      return { ...message, id: request.id } as JSONRPCMessage;
    }
    if (message.method === "notifications/progress" && !("id" in message)) {
      const token = message.params?.progressToken;
      const original =
        typeof token === "string" ? this.progressTokens.get(token) : undefined;
      if (original === undefined) {
        logger.debug(
          { podName, containerName },
          "Dropped an MCP server progress notification that is not for this connection",
        );
        return undefined;
      }
      return {
        ...message,
        params: { ...message.params, progressToken: original },
      };
    }
    return message;
  }

  private releaseRequest(wireId: string) {
    const request = this.pending.get(wireId);
    if (!request) return undefined;
    this.pending.delete(wireId);
    this.wireIdByOriginal.delete(request.id);
    if (request.progressToken) {
      this.progressTokens.delete(request.progressToken.wire);
    }
    return request;
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

type StdoutLine =
  | { kind: "line"; text: string }
  | { kind: "oversized"; id: string | number | undefined };

/**
 * Splits MCP server stdout into lines, like the SDK's ReadBuffer, but never
 * holds more than the size cap: once a line outgrows it, the rest of that line
 * is discarded as it arrives and only its start and end are kept, to recover
 * the request id. The SDK buffer throws instead, which here escaped the stream
 * callback and took the process down.
 */
class StdoutLineReader {
  private buffer?: Buffer;
  private oversized?: { head: Buffer; tail: Buffer };

  append(chunk: Buffer): StdoutLine[] {
    const lines: StdoutLine[] = [];
    let data = chunk;
    while (data.length > 0) {
      const newline = data.indexOf(0x0a);
      const piece = newline === -1 ? data : data.subarray(0, newline);

      if (this.oversized) {
        this.oversized.tail = keepTail(
          Buffer.concat([this.oversized.tail, keepTail(piece)]),
        );
        if (newline === -1) return lines;
        lines.push({ kind: "oversized", id: findMessageId(this.oversized) });
        this.oversized = undefined;
      } else {
        const line = this.buffer ? Buffer.concat([this.buffer, piece]) : piece;
        this.buffer = undefined;
        if (line.length > STDIO_DEFAULT_MAX_BUFFER_SIZE) {
          const ends = {
            head: Buffer.from(line.subarray(0, ID_PROBE_BYTES)),
            tail: Buffer.from(keepTail(line)),
          };
          if (newline === -1) {
            this.oversized = ends;
            return lines;
          }
          lines.push({ kind: "oversized", id: findMessageId(ends) });
        } else if (newline === -1) {
          // Copy a bare view so a held partial line does not pin the chunk.
          this.buffer = line === piece ? Buffer.from(piece) : line;
          return lines;
        } else {
          const text = line.toString("utf8").replace(/\r$/, "");
          if (text.trim()) lines.push({ kind: "line", text });
        }
      }
      data = data.subarray(newline + 1);
    }
    return lines;
  }

  clear(): void {
    this.buffer = undefined;
    this.oversized = undefined;
  }
}

const ID_PROBE_BYTES = 4096;
const HEAD_ID =
  /^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")/;
const TAIL_ID = /[{,]\s*"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")\s*\}\s*$/;

function keepTail(buffer: Buffer): Buffer {
  return buffer.length > ID_PROBE_BYTES
    ? buffer.subarray(buffer.length - ID_PROBE_BYTES)
    : buffer;
}

/**
 * Serializers put a response's top-level `id` either first (after `jsonrpc`)
 * or last, so look only there: an `id` anywhere else may belong to the payload.
 * Both patterns are anchored (to the line's start, and to its closing brace),
 * so a nested `id` never matches.
 */
function findMessageId(ends: {
  head: Buffer;
  tail: Buffer;
}): string | number | undefined {
  const match =
    ends.head.toString("utf8").match(HEAD_ID) ??
    ends.tail.toString("utf8").match(TAIL_ID);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as string | number;
  } catch {
    return undefined;
  }
}
