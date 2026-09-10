import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SessionMailbox } from "./session-mailbox.js";

test("claims input before delivery, acknowledges errors, and ignores already claimed commands", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "session-mailbox-"));
  const directory = join(runtimeDir, "turns/task-1.controls");
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const accepted: string[] = [];
  const mailbox = new SessionMailbox({
    runtimeDir,
    taskId: "task-1",
    control: async (control) => {
      if (control.type === "message") accepted.push(control.text);
      await wait;
    },
  });
  const running = mailbox.start();
  try {
    await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]));
    await writeFile(
      join(directory, "a.json"),
      JSON.stringify({ type: "message", text: "hello" }),
    );
    await vi.waitFor(() => expect(accepted).toEqual(["hello"]));
    expect(await readdir(directory)).toContain("a.json.processing");
    expect(await readdir(directory)).not.toContain("a.json");
    release();
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(join(directory, "a.json.result"), "utf8")),
      ).toEqual({}),
    );
    await writeFile(
      join(directory, "b.json.processing"),
      JSON.stringify({ type: "message", text: "never replay" }),
    );
    await writeFile(
      join(directory, "c.json"),
      JSON.stringify({ type: "message", text: " " }),
    );
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(join(directory, "c.json.result"), "utf8"))
          .error,
      ).toBeTruthy(),
    );
    expect(accepted).toEqual(["hello"]);
  } finally {
    release();
    mailbox.stop();
    await running;
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
