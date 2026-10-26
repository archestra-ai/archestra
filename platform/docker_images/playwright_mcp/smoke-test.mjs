import assert from "node:assert/strict";
import { extractRunCodeResult } from "../../backend/src/features/browser-stream/services/run-code-result.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const image = process.argv[2];
if (!image) throw new Error("Usage: node smoke-test.mjs IMAGE");
const expected = JSON.parse(
  readFileSync(new URL("./versions.json", import.meta.url)),
);
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
let container;
let endpoint;
let session;
let id = 0;
async function rpc(method, params, notification = false) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(notification ? {} : { id: ++id }),
      method,
      params,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(response.ok, `${method}: HTTP ${response.status}`);
  session = response.headers.get("mcp-session-id") || session;
  if (notification) return;
  const text = await response.text();
  const message = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? JSON.parse(
        text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6),
      )
    : JSON.parse(text);
  assert.ok(!message.error, JSON.stringify(message.error));
  assert.ok(!message.result?.isError, JSON.stringify(message.result));
  return message.result;
}
try {
  const runtime = JSON.parse(
    docker(
      "run",
      "--rm",
      "--entrypoint",
      "node",
      image,
      "-e",
      'console.log(JSON.stringify({node:process.versions.node,arch:process.arch,mcp:require("/app/package.json").version,playwright:require("/app/node_modules/playwright-core/package.json").version}))',
    ),
  );
  assert.equal(runtime.node, expected.nodeVersion);
  assert.equal(runtime.mcp, expected.mcpVersion);
  assert.equal(runtime.playwright, expected.playwrightVersion);
  console.log(JSON.stringify(runtime));
  // Exactly the platform seed's explicit command, path and flags. Bind locally;
  // no production resources, credentials or external pages are used.
  container = docker(
    "run",
    "--rm",
    "--init",
    "-d",
    "--entrypoint",
    "node",
    "-p",
    "127.0.0.1::8080",
    image,
    "/app/cli.js",
    "--headless",
    "--browser",
    "chromium",
    "--no-sandbox",
    "--host",
    "0.0.0.0",
    "--port",
    "8080",
    "--allowed-hosts",
    "*",
    "--isolated",
  );
  const port = JSON.parse(docker("inspect", container))[0].NetworkSettings
    .Ports["8080/tcp"][0].HostPort;
  endpoint = `http://127.0.0.1:${port}/mcp`;
  for (let attempt = 0; ; attempt++) {
    try {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "archestra-image-smoke", version: "1" },
      });
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await rpc("notifications/initialized", {}, true);
  const list = await rpc("tools/list", {});
  console.log(list.tools.map((tool) => tool.name).join(", "));
  for (const name of [
    "browser_navigate",
    "browser_take_screenshot",
    "browser_close",
  ])
    assert.ok(
      list.tools.some((tool) => tool.name === name),
      `Missing ${name}`,
    );
  await rpc("tools/call", {
    name: "browser_navigate",
    arguments: { url: "about:blank" },
  });
  const runCode = list.tools.find((tool) =>
    tool.name.includes("browser_run_code"),
  );
  assert.ok(runCode, "Missing browser_run_code tool");
  const result = await rpc("tools/call", {
    name: runCode.name,
    arguments: {
      code: 'async (page) => { await page.setContent("<title>Archestra image smoke</title>"); return { title: await page.title(), chromium: page.context().browser().version() }; }',
    },
  });
  assert.ok(JSON.stringify(result).includes("Archestra image smoke"));
  console.log(JSON.stringify(result));
  const screenshot = await rpc("tools/call", {
    name: "browser_take_screenshot",
    arguments: { type: "png" },
  });
  assert.ok(
    screenshot.content.some(
      (item) => item.type === "image" && item.data.length > 0,
    ),
    "No browser screenshot",
  );
  const settled = await rpc("tools/call", {
    name: runCode.name,
    arguments: {
      code: 'async (page) => ({ url: page.url(), screenshot: (await page.screenshot({ type: "jpeg", quality: 70, caret: "initial", timeout: 5000 })).toString("base64") })',
    },
  });
  const frame = JSON.parse(
    extractRunCodeResult(
      settled.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
    ),
  );
  assert.equal(frame.url, "about:blank");
  assert.ok(
    frame.screenshot.length > 0,
    "Backend could not decode settled screenshot output",
  );
  const originalSession = session;
  session = undefined;
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "archestra-isolation-smoke", version: "1" },
  });
  assert.notEqual(session, originalSession);
  await rpc("notifications/initialized", {}, true);
  await rpc("tools/call", {
    name: "browser_navigate",
    arguments: { url: "about:blank" },
  });
  const isolated = await rpc("tools/call", {
    name: "browser_evaluate",
    arguments: { function: "() => document.title" },
  });
  assert.ok(
    !JSON.stringify(isolated).includes("Archestra image smoke"),
    "Browser state leaked between MCP sessions",
  );
  await rpc("tools/call", { name: "browser_close", arguments: {} });
  session = originalSession;
  const restored = await rpc("tools/call", {
    name: "browser_evaluate",
    arguments: { function: "() => document.title" },
  });
  assert.ok(
    JSON.stringify(restored).includes("Archestra image smoke"),
    "Second session changed the first session's page",
  );
  await rpc("tools/call", { name: "browser_close", arguments: {} });
  console.log(
    "MCP initialize/list, Chromium navigation/evaluation/screenshots, backend output parsing, session isolation and close passed",
  );
} catch (error) {
  if (container) console.error(docker("logs", container));
  throw error;
} finally {
  if (container) docker("rm", "-f", container);
}
