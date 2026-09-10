import { execFile, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fileSystem from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, test } from "@/test";
import { CLIENT_CONNECTION_INSTALLER } from "./client-connection-installer";

let directory: string;
let server: Server;
let origin: string;
let status: "approved" | "denied" | "expired";
let downloads: number;
let polls: number;
let transientFailure: boolean;
let interval: number;
let startedAt: number;
let firstPollDelay: number;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "connect-installer-test-"));
  await writeFile(join(directory, "connect.cjs"), CLIENT_CONNECTION_INSTALLER);
  status = "approved";
  downloads = 0;
  polls = 0;
  transientFailure = false;
  interval = 1;
  startedAt = 0;
  firstPollDelay = 0;
  server = createServer((req, res) => {
    if (req.url === "/api/client-connections") {
      startedAt = Date.now();
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          interval,
          deviceCode: "A".repeat(43),
          userCode: "ABCD-1234",
          verificationPath: "/connection?connectRequest=test",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
    } else if (req.url === "/api/client-connections/poll") {
      polls++;
      if (polls === 1) firstPollDelay = Date.now() - startedAt;
      if (transientFailure && polls === 1) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status }));
    } else if (
      req.url ===
      `/api/connection-setups/script/archestra_con_${"A".repeat(43)}`
    ) {
      downloads++;
      res.setHeader("Content-Type", "text/plain");
      res.end(
        `#!/bin/bash\nprintf applied > '${join(directory, "applied")}'\n`,
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
function run(url = origin, clientId = "cursor") {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [
        join(directory, "connect.cjs"),
        "--url",
        url,
        "--client",
        clientId,
        "--no-open",
        "--desktop-terminal",
      ]);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    },
  );
}

test("downloads and executes the approved script without logging polling credentials", async () => {
  const result = await run();
  expect(result.code).toBe(0);
  expect(await readFile(join(directory, "applied"), "utf8")).toBe("applied");
  expect(downloads).toBe(1);
  expect(result.output).toContain("ABCD-1234");
  expect(result.output).not.toContain("A".repeat(43));
});

test("Desktop downloads and executes its approved setup through the same protocol", async () => {
  const result = await run(origin, "claude-desktop");
  expect(result.code).toBe(0);
  expect(await readFile(join(directory, "applied"), "utf8")).toBe("applied");
  expect(downloads).toBe(1);
  expect(result.output).not.toContain("A".repeat(43));
});

test("a downloaded Desktop setup redeems its reviewed ticket without another approval flow", async () => {
  const token = `archestra_con_${"A".repeat(43)}`;
  const result = await promisify(execFile)(process.execPath, [
    join(directory, "connect.cjs"),
    "--url",
    origin,
    "--client",
    "claude-desktop",
    "--desktop-terminal",
    "--setup-token",
    token,
  ]);
  expect(await readFile(join(directory, "applied"), "utf8")).toBe("applied");
  expect(downloads).toBe(1);
  expect(polls).toBe(0);
  expect(startedAt).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(token);
});

test.each([
  0, 1,
])("Desktop terminal handoff handles launcher exit %s", async (exitCode) => {
  let launcher = "";
  const opened = new Promise<void>((resolve, reject) => {
    runInNewContext(CLIENT_CONNECTION_INSTALLER, {
      __filename: join(directory, "connect.cjs"),
      process: {
        argv: [
          process.execPath,
          "connect.cjs",
          "--url",
          origin,
          "--client",
          "claude-desktop",
          "--no-open",
        ],
        platform: "darwin",
        execPath: process.execPath,
      },
      URL,
      fetch,
      setTimeout,
      clearTimeout,
      console: {
        log: () => resolve(),
        error: (message: string) => reject(new Error(message)),
      },
      require: (name: string) => {
        if (name === "node:fs/promises") return fileSystem;
        if (name === "node:path") return { join };
        if (name === "node:os") return { tmpdir: () => directory };
        if (name === "node:child_process")
          return {
            spawnSync,
            spawn: (command: string, args: string[]) => {
              expect(command).toBe("open");
              expect(args.slice(0, 2)).toEqual(["-a", "Terminal"]);
              launcher = args[2];
              const child = Object.assign(new EventEmitter(), {
                unref() {},
                stderr: Object.assign(new EventEmitter(), { destroy() {} }),
              });
              queueMicrotask(() => {
                child.stderr.emit(
                  "data",
                  Buffer.from("Terminal launch refused"),
                );
                child.emit("exit", exitCode);
              });
              return child;
            },
          };
        throw new Error(`Unexpected module ${name}`);
      },
    });
  });
  if (exitCode !== 0) {
    await expect(opened).rejects.toThrow("Terminal launch refused");
    expect(downloads).toBe(0);
    await expect(readFile(join(directory, "applied"))).rejects.toThrow();
    return;
  }
  await opened;
  expect(downloads).toBe(0);
  await promisify(execFile)("bash", [launcher]);
  expect(await readFile(join(directory, "applied"), "utf8")).toBe("applied");
  expect(downloads).toBe(1);
});

test.each([
  "denied",
  "expired",
] as const)("%s never downloads or executes a setup", async (state) => {
  status = state;
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.output).toContain(state);
  expect(downloads).toBe(0);
  await expect(readFile(join(directory, "applied"))).rejects.toThrow();
});

test("polling survives a temporary deployment outage", async () => {
  transientFailure = true;
  const result = await run();
  expect(result.code).toBe(0);
  expect(polls).toBe(2);
  expect(downloads).toBe(1);
}, 25_000);

test("refuses plaintext remote origins before requesting credentials", async () => {
  const result = await run("http://deployment.example");
  expect(result.code).toBe(1);
  expect(result.output).toContain("Use HTTPS");
  expect(downloads).toBe(0);
});

test("waits for the server-provided polling interval before requesting approval status", async () => {
  interval = 4;
  const result = await run();
  expect(result.code).toBe(0);
  expect(firstPollDelay).toBeGreaterThanOrEqual(4_000);
  expect(downloads).toBe(1);
});

test.each([
  0, -1, 0.5, 601,
])("rejects invalid polling interval %s without downloading setup", async (value) => {
  interval = value;
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.output).toContain("Invalid polling interval");
  expect(polls).toBe(0);
  expect(downloads).toBe(0);
});
