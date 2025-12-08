import type { Duplex } from "node:stream";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type Dockerode from "dockerode";
import logger from "@/logging";

export interface DockerAttachTransportParams {
  docker: Dockerode;
  containerId: string;
  containerName: string;
}

/**
 * MCP Transport that uses Docker attach to communicate with containers via stdio.
 * This allows using the MCP SDK Client with stdio-based MCP servers running in Docker.
 */
export class DockerAttachTransport implements Transport {
  private stream?: Duplex;
  private readBuffer = new ReadBuffer();
  private isStarted = false;
  private isClosing = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private params: DockerAttachTransportParams) {}

  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    const { docker, containerId, containerName } = this.params;

    try {
      const container = docker.getContainer(containerId);

      this.stream = (await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      })) as Duplex;

      this.isStarted = true;

      this.stream.on("data", (chunk: Buffer) => {
        if (this.isClosing) {
          return;
        }

        const payload = this.demultiplexDockerStream(chunk);
        if (payload.length === 0) {
          return;
        }

        this.readBuffer.append(payload);

        try {
          let message = this.readBuffer.readMessage();
          while (message !== null) {
            this.onmessage?.(message);
            message = this.readBuffer.readMessage();
          }
        } catch (error) {
          logger.debug(
            { err: error, containerName },
            "Failed to parse message from MCP server stdout - skipping invalid line",
          );
        }
      });

      this.stream.on("close", () => {
        logger.debug({ containerName }, "DockerAttachTransport stream closed");
        this.isStarted = false;
        this.onclose?.();
      });

      this.stream.on("error", (error: Error) => {
        logger.error(
          { err: error, containerName },
          "DockerAttachTransport stream error",
        );
        this.onerror?.(error);
      });
    } catch (error) {
      logger.error(
        { err: error, containerName },
        "Failed to attach to container",
      );
      throw error;
    }
  }

  /**
   * Demultiplex Docker stream format.
   * Docker uses an 8-byte header: [STREAM_TYPE, 0, 0, 0, SIZE1, SIZE2, SIZE3, SIZE4]
   * STREAM_TYPE: 0=stdin, 1=stdout, 2=stderr
   */
  private demultiplexDockerStream(chunk: Buffer): Buffer {
    const payloads: Buffer[] = [];
    let offset = 0;

    while (offset < chunk.length) {
      if (offset + 8 > chunk.length) {
        payloads.push(chunk.slice(offset));
        break;
      }

      const streamType = chunk[offset];

      if (streamType > 2) {
        payloads.push(chunk.slice(offset));
        break;
      }

      const size = chunk.readUInt32BE(offset + 4);
      offset += 8;

      if (size > 10 * 1024 * 1024) {
        payloads.push(chunk.slice(offset - 8));
        break;
      }

      if (offset + size > chunk.length) {
        payloads.push(chunk.slice(offset));
        break;
      }

      if (streamType === 1) {
        payloads.push(chunk.slice(offset, offset + size));
      }

      offset += size;
    }

    return Buffer.concat(payloads);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.isStarted || !this.stream) {
      throw new Error("Transport not started");
    }

    const serialized = serializeMessage(message);

    return new Promise((resolve, reject) => {
      if (!this.stream) {
        reject(new Error("Transport not started"));
        return;
      }
      this.stream.write(serialized, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    this.isClosing = true;

    if (this.stream) {
      this.stream.end();
      this.stream = undefined;
    }

    this.isStarted = false;
    this.readBuffer.clear();
    this.onclose?.();
  }
}
