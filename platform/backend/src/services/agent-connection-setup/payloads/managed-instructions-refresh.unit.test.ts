import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { MANAGED_INSTRUCTIONS_REFRESH } from "./managed-instructions-refresh";
import { MANAGED_INSTRUCTIONS_REFRESH_WINDOWS } from "./managed-instructions-refresh.windows";

const exec = promisify(execFile);
let server: Server | undefined;
let home: string | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (home) await rm(home, { recursive: true, force: true });
});

const runtimes = [
  "python",
  ...(process.env.INSTRUCTIONS_TEST_PWSH || process.platform === "win32"
    ? ["powershell"]
    : []),
];
test.each(
  runtimes,
)("%s refresh replaces its own files, preserves user rules, handles disable and re-enable, and retains the last valid copy on failures", async (runtime) => {
  home = await mkdtemp(path.join(tmpdir(), "managed instructions "));
  const helper = path.join(
    home,
    runtime === "python" ? "refresh.py" : "refresh.ps1",
  );
  const source = path.join(home, "source.json");
  const prompt = path.join(home, "prompt.md");
  const copilot = path.join(home, "instructions", "AGENTS.md");
  const userRules = path.join(home, "AGENTS.md");
  await writeFile(
    helper,
    runtime === "python"
      ? MANAGED_INSTRUCTIONS_REFRESH
      : MANAGED_INSTRUCTIONS_REFRESH_WINDOWS,
  );
  await writeFile(userRules, "Keep my project rules.");
  let status = 200;
  let stall = false;
  let body = JSON.stringify({ instructions: "First instructions" });
  let authorization: string | undefined;
  server = createServer((req, res) => {
    authorization = req.headers.authorization;
    if (stall) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No server address");
  await writeFile(
    source,
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}/instructions`,
      token: "read-only-credential",
    }),
  );
  const refresh = () =>
    runtime === "python"
      ? exec("python3", [helper, source, prompt, copilot])
      : exec(process.env.INSTRUCTIONS_TEST_PWSH || "powershell.exe", [
          "-NoProfile",
          "-File",
          helper,
          source,
          prompt,
          copilot,
        ]);
  await refresh();
  expect(authorization).toBe("Bearer read-only-credential");
  expect(await readFile(prompt, "utf8")).toBe("First instructions");
  if (runtime === "python")
    expect((await stat(prompt)).mode & 0o777).toBe(0o600);
  const mtime = (await stat(prompt)).mtimeMs;
  await refresh();
  expect((await stat(prompt)).mtimeMs).toBe(mtime);
  body = JSON.stringify({ instructions: 'Updated\n"quoted" $HOME 雪' });
  await refresh();
  expect(await readFile(prompt, "utf8")).toBe('Updated\n"quoted" $HOME 雪');
  expect(await readFile(copilot, "utf8")).toBe('Updated\n"quoted" $HOME 雪');
  expect(await readFile(userRules, "utf8")).toBe("Keep my project rules.");
  for (const bad of [
    "not json",
    "{}",
    '{"instructions":42}',
    JSON.stringify({ instructions: "x".repeat(20001) }),
  ]) {
    body = bad;
    await refresh();
    expect(await readFile(prompt, "utf8")).toBe('Updated\n"quoted" $HOME 雪');
  }
  stall = true;
  const started = Date.now();
  await refresh();
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await readFile(prompt, "utf8")).toBe('Updated\n"quoted" $HOME 雪');
  stall = false;
  status = 503;
  await refresh();
  expect(await readFile(prompt, "utf8")).toBe('Updated\n"quoted" $HOME 雪');
  status = 200;
  body = JSON.stringify({ instructions: null });
  await refresh();
  await expect(readFile(prompt)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(copilot)).rejects.toMatchObject({ code: "ENOENT" });
  body = JSON.stringify({ instructions: "Re-enabled" });
  await refresh();
  expect(await readFile(prompt, "utf8")).toBe("Re-enabled");
  status = 403;
  await refresh();
  await expect(readFile(prompt)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(userRules, "utf8")).toBe("Keep my project rules.");
});
