import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { SessionSnapshot } from "./session-protocol.js";
import { SessionPublisher } from "./session-publisher.js";

test("streams only changed history while retaining a complete snapshot", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "session-publisher-"));
  const output: string[] = [];
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
  try {
    const publisher = new SessionPublisher(runtimeDir);
    const snapshot: SessionSnapshot = {
      version: 1,
      provider: "codex",
      session: { state: "working", requests: [] },
      entries: [
        {
          id: "1",
          type: "message",
          role: "user",
          text: "Earlier history ".repeat(1000),
        },
        { id: "2", type: "message", role: "assistant", text: "Partial" },
      ],
    };
    await publisher.publish(snapshot);
    snapshot.entries[1] = {
      id: "2",
      type: "message",
      role: "assistant",
      text: "Complete 🌱",
    };
    await publisher.publish(snapshot);
    snapshot.session.state = "idle";
    await publisher.publish(snapshot);
    const frames = output.map((frame) => {
      const encoded = frame.split("\x07")[1]?.split("\x1b")[0];
      if (!encoded) throw new Error("Missing protocol frame");
      return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    });
    expect(frames[1]).toMatchObject({
      replaceFrom: 1,
      entries: [snapshot.entries[1]],
    });
    expect(frames[2]).toMatchObject({
      replaceFrom: 2,
      entries: [],
      session: { state: "idle" },
    });
    const [first, second] = output;
    if (!first || !second) throw new Error("Missing output frames");
    expect(second.length).toBeLessThan(first.length / 10);
    expect(
      JSON.parse(
        await readFile(join(runtimeDir, "readable-transcript.json"), "utf8"),
      ),
    ).toEqual(snapshot);
  } finally {
    stdout.mockRestore();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
