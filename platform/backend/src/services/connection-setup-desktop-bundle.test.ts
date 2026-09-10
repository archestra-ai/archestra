import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { buildDesktopInstallerBundle } from "./connection-setup-desktop-bundle";

test("native MCP startup launches a reviewed setup only once across duplicate processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-bundle-test-"));
  try {
    const bundle = await JSZip.loadAsync(
      await buildDesktopInstallerBundle({
        origin: "https://proxy.example",
        rawToken: `archestra_con_${"B".repeat(32)}`,
        platform: process.platform === "win32" ? "windows" : "macos",
      }),
    );
    for (const [name, entry] of Object.entries(bundle.files)) {
      await writeFile(join(directory, name), await entry.async("nodebuffer"));
    }
    const bin = join(directory, "bin");
    await mkdir(bin);
    // Only the OS launch boundary is replaced. Both packaged MCP servers run normally.
    await writeFile(
      join(bin, "node"),
      '#!/bin/sh\nprintf x >> "$TMPDIR/launches"\n',
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      TMPDIR: directory,
      TMP: directory,
      TEMP: directory,
      PATH: bin,
    };
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [join(directory, "server.cjs")],
          { env, timeout: 10000 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        child.stdin?.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
        );
      });
    const responses = await Promise.all([run(), run()]);
    for (const response of responses) {
      expect(JSON.parse(response.trim())).toMatchObject({
        id: 1,
        result: { capabilities: { tools: {} } },
      });
    }
    expect(await readFile(join(directory, "launches"), "utf8")).toBe("x");
    // Installation startup must not turn into a retry whenever Desktop reconnects.
    await run();
    expect(await readFile(join(directory, "launches"), "utf8")).toBe("x");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
