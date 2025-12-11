import { Readable, Writable } from "node:stream";
import type { Attach } from "@kubernetes/client-node";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type WebSocket from "ws";
import logger from "@/logging";

export interface K8sAttachTransportParams {
  k8sAttach: Attach;
  namespace: string;
  podName: string;
  containerName: string;
}

/**
 * MCP Transport that uses Kubernetes attach to communicate with pods via stdio
 * This allows us to use the MCP SDK Client with stdio-based MCP servers running in K8s
 */
export class K8sAttachTransport implements Transport {
  private ws?: WebSocket;
  private stdinStream?: Readable;
  private readBuffer = new ReadBuffer();
  private isStarted = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private params: K8sAttachTransportParams) {}

  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    const { k8sAttach, namespace, podName, containerName } = this.params;

    return new Promise((resolve, reject) => {
      // Create stdin stream that stays open for continuous communication
      this.stdinStream = new Readable({
        read() {
          // No-op - we'll push data manually via send()
        },
      });

      // Create stdout stream that processes JSON-RPC responses continuously
      const stdoutStream = new Writable({
        write: (chunk, _encoding, callback) => {
          this.readBuffer.append(chunk);

          // Process all complete messages in the buffer
          try {
            let message = this.readBuffer.readMessage();
            while (message !== null) {
              this.onmessage?.(message);
              message = this.readBuffer.readMessage();
            }
          } catch (error) {
            // Log JSON parsing errors but don't crash - the MCP server might output
            // non-JSON lines (startup messages, debug output, etc.) before JSON-RPC messages
            logger.debug(
              {
                err: error,
                podName: this.params.podName,
                containerName: this.params.containerName,
              },
              "Failed to parse message from MCP server stdout - skipping invalid line",
            );
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

    const serialized = serializeMessage(message);
    this.stdinStream.push(serialized);
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    if (this.stdinStream) {
      this.stdinStream.push(null); // Signal EOF
      this.stdinStream = undefined;
    }

    this.isStarted = false;
    this.readBuffer.clear();
    this.onclose?.();
  }
}
