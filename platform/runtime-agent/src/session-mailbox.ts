import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  type SessionControl,
  SessionControlSchema,
} from "./session-protocol.js";

/** Atomic, run-scoped commands survive a browser reconnect without being replayed. */
export class SessionMailbox {
  private stopped = false;
  constructor(
    private readonly params: {
      runtimeDir: string;
      taskId: string;
      control: (control: SessionControl) => Promise<void>;
    },
  ) {}

  async start(): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(this.params.taskId))
      throw new Error("Invalid task ID");
    const mailbox = `${this.params.runtimeDir}/turns/${this.params.taskId}.controls`;
    await mkdir(mailbox, { recursive: true, mode: 0o700 });
    while (!this.stopped) {
      for (const file of (await readdir(mailbox))
        .filter((file) => /^[a-f0-9-]+\.json$/.test(file))
        .sort()) {
        const path = `${mailbox}/${file}`;
        // Claim before delivery: even a crash after a side effect must not replay it.
        await rename(path, `${path}.processing`);
        let response: { error?: string } = {};
        try {
          const command = SessionControlSchema.parse(
            JSON.parse(await readFile(`${path}.processing`, "utf8")),
          );
          await this.params.control(command);
        } catch {
          response = {
            error:
              "The session cannot accept this input. It may be busy, stopped, or already answered.",
          };
        }
        await writeFile(`${path}.result.tmp`, JSON.stringify(response), {
          mode: 0o600,
        });
        await rename(`${path}.result.tmp`, `${path}.result`);
        await unlink(`${path}.processing`);
      }
      await delay(100);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
