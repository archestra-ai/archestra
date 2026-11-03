import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Requires the native bindings used by the server; never connects to a live DB.
for (const mode of ["web", "worker"]) {
  test(`${mode} exits unsuccessfully before serving with an undersized imported budget`, () => {
    const home = mkdtempSync(join(tmpdir(), "shutdown-startup-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/server.ts"],
        {
          encoding: "utf8",
          timeout: 45000,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: process.env.TMPDIR,
            NODE_ENV: "test",
            TSX_TSCONFIG_PATH: "standalone-scripts.tsconfig.json",
            ARCHESTRA_DATABASE_URL:
              "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
            ARCHESTRA_PROCESS_TYPE: mode,
            ARCHESTRA_SERVER_POD_GRACE_SECONDS: "120",
            ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_SHUTDOWN_TIMEOUT_SECONDS: "90",
            ARCHESTRA_ANALYTICS: "disabled",
            ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
          },
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(
        result.stdout + result.stderr,
        /resolved shutdown durations require at least 150s/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
