import { PassThrough, type Readable } from "node:stream";
import type { Exec } from "@kubernetes/client-node";
import type WebSocket from "ws";

/** Bound control-plane commands, including when a custom runtime never exits. */
export function execAgentRuntimeCommand(params: {
  exec: Pick<Exec, "exec">;
  namespace: string;
  podName: string;
  container: string;
  command: string[];
  stdin?: Readable;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let socket: WebSocket | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.terminate();
      params.stdin?.destroy();
      stdout.destroy();
      stderr.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(
      () => finish(new Error("Agent Runtime command timed out")),
      params.timeoutMs ?? 30_000,
    );
    const consume = (chunk: Buffer, retain: boolean) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > (params.maxOutputBytes ?? 6 * 1024 * 1024)) {
        finish(new Error("Agent Runtime command exceeded its output limit"));
      } else if (retain) chunks.push(Buffer.from(chunk));
    };
    stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    stdout.on("error", finish);
    stderr.on("error", finish);
    // Do not include arbitrary runtime stderr in API errors: it can contain
    // credentials, file contents, or unbounded custom-image diagnostics.
    params.exec
      .exec(
        params.namespace,
        params.podName,
        params.container,
        params.command,
        stdout,
        stderr,
        params.stdin ?? null,
        false,
        (status) =>
          finish(
            status.status === "Success"
              ? undefined
              : new Error("Command in Agent Runtime pod failed"),
          ),
      )
      .then((connected) => {
        socket = connected;
        if (settled) {
          connected.terminate();
          return;
        }
        connected.on("error", finish);
        connected.on("close", () =>
          finish(
            new Error("Agent Runtime command disconnected before completion"),
          ),
        );
      })
      .catch(finish);
  });
}
