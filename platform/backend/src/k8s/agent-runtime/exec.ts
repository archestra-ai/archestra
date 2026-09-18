import { PassThrough, type Readable } from "node:stream";
import type { Exec } from "@kubernetes/client-node";
import type WebSocket from "ws";

/** A transport failure does not establish whether the command completed. */
export class AgentRuntimeCommandTransportError extends Error {}

/** Stream a command's output instead of collecting it.
 *
 * File transfers are unbounded in size, so their bytes must never accumulate in
 * memory or in a tool payload. The caller consumes stdout as it arrives and
 * awaits completed for the exit status. timeoutMs is required: a transfer's
 * duration follows the file, so no shared default can be correct.
 *
 * Destroying the returned stream terminates the connection, so a client that
 * disconnects mid-download does not leave the exec session running.
 */
export function streamAgentRuntimeCommand(params: {
  exec: Pick<Exec, "exec">;
  namespace: string;
  podName: string;
  container: string;
  command: string[];
  stdin?: Readable;
  timeoutMs: number;
}): { stdout: Readable; completed: Promise<void> } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let settled = false;
  let socket: WebSocket | undefined;
  let finish: (error?: Error) => void = () => {};
  const completed = new Promise<void>((resolve, reject) => {
    finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.terminate();
      params.stdin?.destroy();
      stderr.destroy();
      if (error) {
        stdout.destroy(error);
        reject(error);
      } else {
        stdout.end();
        resolve();
      }
    };
  });
  const timer = setTimeout(
    () =>
      finish(
        new AgentRuntimeCommandTransportError("Agent Runtime command timed out"),
      ),
    params.timeoutMs,
  );
  // Do not include arbitrary runtime stderr in API errors: it can contain
  // credentials, file contents, or unbounded custom-image diagnostics.
  stderr.resume();
  stderr.on("error", () => {});
  // A consumer that stops reading, such as a disconnected download, closes the
  // stream. Settling is idempotent, so a normal end does not report a failure.
  stdout.on("close", () =>
    finish(
      new AgentRuntimeCommandTransportError(
        "Agent Runtime command disconnected before completion",
      ),
    ),
  );
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
          new AgentRuntimeCommandTransportError(
            "Agent Runtime command disconnected before completion",
          ),
        ),
      );
    })
    .catch(finish);
  return { stdout, completed };
}

/** Bound control-plane commands, including when a custom runtime never exits.
 * The 30-second default covers bounded file transfers and status reads, not
 * agent execution or Pod readiness. Callers that run a longer control-plane
 * operation must set timeoutMs explicitly; never leave custom commands unbounded.
 */
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
      () =>
        finish(
          new AgentRuntimeCommandTransportError(
            "Agent Runtime command timed out",
          ),
        ),
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
            new AgentRuntimeCommandTransportError(
              "Agent Runtime command disconnected before completion",
            ),
          ),
        );
      })
      .catch(finish);
  });
}
