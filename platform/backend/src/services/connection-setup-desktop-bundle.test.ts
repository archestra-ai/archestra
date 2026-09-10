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
        appName: "Archestra",
        iconLogo: null,
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

test("packages white-label names and converts the configured SVG into a PNG icon", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>';
  const bundle = await JSZip.loadAsync(
    await buildDesktopInstallerBundle({
      origin: "https://proxy.example",
      rawToken: "test-ticket",
      platform: "macos",
      appName: "Acme Assistant",
      iconLogo: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    }),
  );
  const manifest = JSON.parse(
    (await bundle.file("manifest.json")?.async("string")) ?? "{}",
  );
  expect(manifest.display_name).toBe("Connect Acme Assistant");
  expect(manifest.author.name).toBe("Acme Assistant");
  expect(manifest.description).toContain(
    "Connect Claude Desktop to Acme Assistant (https://proxy.example)",
  );
  expect(manifest.description).toContain(
    "verifies inference through Acme Assistant",
  );
  const icon = await bundle.file(manifest.icon)?.async("nodebuffer");
  expect(icon?.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const setup = JSON.parse(
    (await bundle.file("setup.json")?.async("string")) ?? "{}",
  );
  expect(setup).toEqual({
    origin: "https://proxy.example",
    rawToken: "test-ticket",
    platform: "macos",
  });
});
