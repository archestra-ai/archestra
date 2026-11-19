import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = new URL("./update-copilot-api-version.mjs", import.meta.url)
  .pathname;

const source = (apiVersion) => `const GITHUB_COPILOT_TOKEN_EXCHANGE_API_VERSION = "2025-04-01";
const GITHUB_COPILOT_API_VERSION = "${apiVersion}";
`;

async function runUpdater(current, next) {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-api-version-"));
  const sourcePath = path.join(directory, "github-copilot-token.ts");
  try {
    await writeFile(sourcePath, source(current));
    await execute(process.execPath, [script, next, sourcePath]);
    return await readFile(sourcePath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("raises the Copilot API version and leaves the token exchange version", async () => {
  assert.equal(await runUpdater("2026-08-01", "2026-11-02"), source("2026-11-02"));
});

test("never lowers the Copilot API version", async () => {
  assert.equal(await runUpdater("2026-08-01", "2026-01-09"), source("2026-08-01"));
});

test("rejects a value that is not a date version", async () => {
  await assert.rejects(runUpdater("2026-08-01", "1.2.3"));
});
