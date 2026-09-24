import { spawn } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildAtomicFileWriteCommand } from "./atomic-file-write";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("overlapping credential publishers succeed without publishing partial or mixed content", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime publish "));
  directories.push(directory);
  const destination = path.join(directory, "current.json");
  await writeFile(destination, '{"value":"previous"}', { mode: 0o600 });
  const first = startWriter(destination);
  const second = startWriter(destination);
  try {
    first.process.stdin.write('{"value":"first');
    await waitForStaged(directory, '{"value":"first');
    second.process.stdin.write('{"value":"second');
    await waitForStaged(directory, '{"value":"second');
    expect(await readFile(destination, "utf8")).toBe('{"value":"previous"}');
    first.process.stdin.end('"}');
    expect(await first.done).toEqual({ code: 0, stderr: "" });
    expect(await readFile(destination, "utf8")).toBe('{"value":"first"}');
    second.process.stdin.end('"}');
    expect(await second.done).toEqual({ code: 0, stderr: "" });
    expect(await readFile(destination, "utf8")).toBe('{"value":"second"}');
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["current.json"]);
  } finally {
    first.process.stdin.end();
    second.process.stdin.end();
    first.process.kill();
    second.process.kill();
    await Promise.all([first.done, second.done]);
  }
});

test("failed input transfer preserves the destination and removes private temporary files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-publish-"));
  directories.push(directory);
  const destination = path.join(directory, "current.json");
  await writeFile(destination, "previous", { mode: 0o600 });
  await writeFile(
    path.join(directory, "cat"),
    "#!/bin/sh\nprintf partial\nexit 17\n",
    { mode: 0o700 },
  );
  const writer = startWriter(destination, {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
  });
  writer.process.stdin.end();
  expect((await writer.done).code).toBe(17);
  expect(await readFile(destination, "utf8")).toBe("previous");
  expect((await readdir(directory)).sort()).toEqual(["cat", "current.json"]);
});

function startWriter(destination: string, env = process.env) {
  const [command, ...args] = buildAtomicFileWriteCommand(destination);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  const done = new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    },
  );
  return { process: child, done };
}

async function waitForStaged(directory: string, content: string) {
  await expect
    .poll(async () => {
      const files = (await readdir(directory)).filter(
        (name) => name !== "current.json",
      );
      const contents = await Promise.all(
        files.map((name) => readFile(path.join(directory, name), "utf8")),
      );
      return contents.includes(content);
    })
    .toBe(true);
}
