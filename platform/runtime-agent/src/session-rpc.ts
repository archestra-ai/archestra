import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type RpcObject = Record<string, unknown>;
export interface RpcMessage extends RpcObject {
  id?: string | number;
  method?: string;
  params?: RpcObject;
  result?: RpcObject;
  error?: { message: string };
}

/** One child process per agent session. Closing a browser never closes this pipe. */
export class SessionRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: RpcObject) => void;
      reject: (error: Error) => void;
      timer?: NodeJS.Timeout;
    }
  >();
  private closed = false;

  constructor(params: {
    command: string[];
    onMessage: (message: RpcMessage) => void;
    onExit: (error: Error) => void;
  }) {
    const [command, ...args] = params.command;
    if (!command) throw new Error("Missing agent command");
    this.child = spawn(command, args, { stdio: "pipe" });
    const decoder = new StringDecoder("utf8");
    let pending = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      if (Buffer.byteLength(pending) > 16 * 1024 * 1024) {
        this.fail(
          new Error("Agent protocol message exceeded its size limit"),
          params.onExit,
        );
        this.close();
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        if (!line.trim()) continue;
        let message: RpcMessage;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!message || typeof message !== "object") continue;
        const request =
          typeof message.id === "number" && !message.method
            ? this.pending.get(message.id)
            : undefined;
        if (request) {
          this.pending.delete(message.id as number);
          clearTimeout(request.timer);
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result ?? {});
        } else params.onMessage(message);
      }
    });
    // Drain stderr without forwarding provider diagnostics (which may contain credentials).
    this.child.stderr.resume();
    this.child.on("error", (error) => this.fail(error, params.onExit));
    this.child.on("exit", (code, signal) =>
      this.fail(
        new Error(`Agent process exited (${signal ?? code})`),
        params.onExit,
      ),
    );
    this.child.stdin.on("error", (error) => this.fail(error, params.onExit));
  }

  request(
    method: string,
    params: RpcObject,
    timeoutMs = 30_000,
  ): Promise<RpcObject> {
    if (this.closed)
      return Promise.reject(new Error("Agent connection closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Agent did not respond to ${method}`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  send(message: RpcObject): void {
    if (this.closed) throw new Error("Agent connection closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGTERM");
    const child = this.child;
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3_000);
    timer.unref();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Agent connection closed"));
    }
    this.pending.clear();
  }

  private fail(error: Error, onExit: (error: Error) => void): void {
    if (this.closed) return;
    this.close();
    onExit(error);
  }
}
