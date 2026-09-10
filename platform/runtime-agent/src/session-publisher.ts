import { rename, writeFile } from "node:fs/promises";
import type { SessionSnapshot } from "./session-protocol.js";

/** Persist a complete snapshot, but stream only the changed suffix of history. */
export class SessionPublisher {
  private previous: string[] = [];
  constructor(private readonly runtimeDir: string) {}

  async publish(snapshot: SessionSnapshot): Promise<void> {
    const content = JSON.stringify(snapshot);
    if (Buffer.byteLength(content) > 16 * 1024 * 1024)
      throw new Error("Conversation exceeded its storage limit");
    const entries = snapshot.entries.map((entry) => JSON.stringify(entry));
    let replaceFrom = 0;
    while (
      replaceFrom < entries.length &&
      entries[replaceFrom] === this.previous[replaceFrom]
    )
      replaceFrom++;
    const frame = JSON.stringify({
      ...snapshot,
      replaceFrom,
      entries: snapshot.entries.slice(replaceFrom),
    });
    await writeFile(
      `${this.runtimeDir}/readable-transcript.session.tmp`,
      content,
      { mode: 0o600 },
    );
    await rename(
      `${this.runtimeDir}/readable-transcript.session.tmp`,
      `${this.runtimeDir}/readable-transcript.json`,
    );
    process.stdout.write(
      `\x1b]777;archestra-readable-transcript=base64\x07${Buffer.from(frame).toString("base64")}\x1b]777;archestra-readable-transcript=end\x07\n`,
    );
    this.previous = entries;
  }
}
