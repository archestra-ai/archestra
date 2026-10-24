import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("web-cluster.mjs", import.meta.url));

test("four real workers share HTTP load, retain a total pool budget of 20 and stop together", {
  timeout: 15000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "proxy-workers-"));
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const entry = path.join(temp, "worker.mjs");
  const ready = path.join(temp, "ready.json");
  await writeFile(
    entry,
    `
    import http from 'node:http';
    const server = http.createServer((req,res) => {
      res.end(JSON.stringify({pid:process.pid,pool:process.env.ARCHESTRA_DATABASE_POOL_MAX,metrics:process.env.ARCHESTRA_METRICS_PORT}));
    });
    const startup = http.createServer((req,res) => {res.statusCode=503;res.end('starting');}).listen(${port}, '127.0.0.1');
    setTimeout(()=>startup.close(()=>server.listen(${port},'127.0.0.1',()=>process.send({type:'archestra.web.ready'}))),50);
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `,
  );
  const child = spawn(
    process.execPath,
    [launcher, entry, "4", "31000", ready],
    { stdio: "ignore" },
  );
  const exited = once(child, "exit");
  const pids = new Set();
  try {
    let state;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode != null)
        throw Error("Worker supervisor exited before readiness");
      try {
        state = JSON.parse(await readFile(ready, "utf8"));
      } catch {}
      if (state) break;
      await sleep(20);
    }
    assert.equal(state?.workers, 4);
    const records = await Promise.all(
      Array.from({ length: 32 }, async () => {
        const response = await fetch(`http://127.0.0.1:${port}`, {
          headers: { connection: "close" },
        });
        return response.json();
      }),
    );
    for (const record of records) {
      pids.add(record.pid);
      assert.equal(record.pool, "5");
    }
    assert.equal(pids.size, 4);
    assert.equal(new Set(records.map((r) => r.metrics)).size, 4);
  } finally {
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0);
    for (const pid of pids)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await rm(temp, { recursive: true, force: true });
  }
});
