import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

it("rejects excessive response encodings without terminating the process", () => {
  // Isolate the client because CVE-2026-109869 raises an unhandled stream error
  // after fetch has already rejected. Catching the promise alone is insufficient.
  const script = String.raw`
    const assert = require("node:assert/strict");
    const { createServer } = require("node:net");
    const { setTimeout: waitForStreamError } = require("node:timers/promises");
    const { fetch, getGlobalDispatcher } = require(process.argv[1]);
    const server = createServer(socket => {
      socket.once("data", () => socket.end(
        "HTTP/1.1 200 OK\r\n" +
        "Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\n" +
        "Content-Length: 100\r\nConnection: close\r\n\r\n"
      ));
    });
    (async () => {
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        await assert.rejects(fetch("http://127.0.0.1:" + server.address().port),
          error => /too many content-encodings/.test(error.cause?.message));
        await waitForStreamError(50);
        console.log("FETCH_REJECTED_AND_PROCESS_SURVIVED");
      } finally {
        await getGlobalDispatcher().close();
        await new Promise(resolve => server.close(resolve));
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const require = createRequire(import.meta.url);
  const result = spawnSync(
    process.execPath,
    ["-e", script, require.resolve("undici")],
    { encoding: "utf8", timeout: 5_000 },
  );

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("FETCH_REJECTED_AND_PROCESS_SURVIVED");
});
