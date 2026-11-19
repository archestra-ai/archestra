import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { expect, test } from "vitest";
import type { SetupScriptContext } from "../types";
import { grokSetup } from "./grok";

test("generated installer and native launcher refresh Automatic from current verified availability, while explicit models skip discovery", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "grok live discovery 日本語 "));
  const ordinaryHome = path.join(home, ".grok");
  const ordinaryConfig = path.join(ordinaryHome, "config.toml");
  const managedConfig = path.join(home, ".archestra/grok/native/config.toml");
  const originalConfig = 'default_model = "grok-personal"\n';
  mkdirSync(ordinaryHome);
  writeFileSync(ordinaryConfig, originalConfig);
  let recommendation = "grok-4.7";
  let available = ["grok-4.7", "grok-4.6"];
  let offline = false;
  const observed: { model: string; callerKey: boolean }[] = [];
  let discoveryRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith("/chat/completions")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      observed.push({
        model: body.model,
        callerKey:
          request.headers.authorization === "Bearer synthetic-local-key",
      });
      response.setHeader("Content-Type", "text/event-stream");
      response.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic response." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (request.url?.startsWith("/developers/")) discoveryRequests++;
    if (offline) {
      response.writeHead(503);
      response.end("synthetic-local-key must never be logged");
      return;
    }
    if (request.url === "/developers/models.md") {
      expect(request.headers.authorization).toBeUndefined();
      response.end(
        `### Text API Pricing\n${available.map((model) => `| ${model} | text |`).join("\n")}\n### Other\nCode: [Recommended](/developers/models/${recommendation})\n`,
      );
    } else if (request.url === "/v1/xai/models") {
      expect(request.headers.authorization).toBe("Bearer synthetic-local-key");
      response.end(
        JSON.stringify({
          data: available.map((id, index) => ({ id, created: 200 - index })),
        }),
      );
    } else {
      const name = request.url?.split("/").at(-1)?.replace(/\.md$/, "");
      response.end(
        `**Model name:** \`${name}\`\n**Modalities:** text, image → text\n**Function calling:** Yes\n`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const preload = path.join(home, "network-fixture.cjs");
  writeFileSync(
    preload,
    `const original=global.fetch;global.fetch=(url,options)=>original(String(url).startsWith('https://docs.x.ai/') ? ${JSON.stringify(base)}+new URL(url).pathname : url,options);`,
  );
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  if (process.env.ARCHESTRA_GROK_TEST_BINARY)
    symlinkSync(process.env.ARCHESTRA_GROK_TEST_BINARY, path.join(bin, "grok"));
  const env = {
    ...process.env,
    HOME: home,
    GROK_HOME: path.join(home, ".grok"),
    XAI_API_KEY: "synthetic-local-key",
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
    PATH: bin + path.delimiter + process.env.PATH,
    GROK_DISABLE_AUTOUPDATER: "1",
  };
  const run = (args: string[], input?: string) =>
    new Promise<{ status: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, args, {
          env,
          cwd: home,
          stdio: "pipe",
          timeout: 30000,
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.stdout.resume();
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stderr }));
        child.stdin.end(input);
      },
    );
  const context = {
    clientId: "grok-build",
    platform: "windows",
    appName: "Fixture",
    skills: null,
    mcp: null,
    proxy: {
      provider: "xai",
      providerLabel: "xAI",
      authMode: "provider-key",
      baseUrl: base,
      url: `${base}/v1/xai`,
      proxyName: "fixture",
      virtualKey: null,
      virtualKeyName: null,
      passthroughVirtualKey: null,
      model: null,
    },
  } satisfies SetupScriptContext;
  const install = (model: string | null = null) =>
    run(
      ["-"],
      grokSetup.bash
        .sections({ ...context, proxy: { ...context.proxy, model } })[0]
        .replace(/^node - <<'ARCHESTRA_NODE_SETUP'\n/, "")
        .replace(/\nARCHESTRA_NODE_SETUP$/, ""),
    );
  const configured = () =>
    parse(readFileSync(managedConfig, "utf8")).model as {
      archestra: { model: string };
    };
  try {
    let result = await install();
    expect(result.status, result.stderr).toBe(0);
    expect(configured().archestra.model).toBe("grok-4.7");
    expect(readFileSync(ordinaryConfig, "utf8")).toBe(originalConfig);
    recommendation = "grok-5";
    available = ["grok-5", "grok-4.7"];
    const launcher = path.join(home, ".archestra/grok/launch.cjs");
    if (process.env.ARCHESTRA_GROK_TEST_BINARY) {
      result = await run([
        launcher,
        "--no-subagents",
        "-p",
        "Reply with a short sentence.",
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(observed.at(-1)).toEqual({ model: "grok-5", callerKey: true });
      expect(configured().archestra.model).toBe("grok-5");
    }
    available = ["grok-4.7"];
    result = await install();
    expect(result.status, result.stderr).toBe(0);
    expect(configured().archestra.model).toBe("grok-4.7");
    offline = true;
    const before = readFileSync(managedConfig, "utf8");
    result = await install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("synthetic-local-key");
    expect(readFileSync(managedConfig, "utf8")).toBe(before);
    if (process.env.ARCHESTRA_GROK_TEST_BINARY) {
      const inferenceCount = observed.length;
      result = await run([launcher, "--no-subagents", "-p", "Reply briefly."]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain("synthetic-local-key");
      expect(observed).toHaveLength(inferenceCount);
      expect(readFileSync(managedConfig, "utf8")).toBe(before);
    }
    const count = discoveryRequests;
    result = await install("explicit-deployment-model");
    expect(result.status, result.stderr).toBe(0);
    expect(discoveryRequests).toBe(count);
    expect(configured().archestra.model).toBe("explicit-deployment-model");
    if (process.env.ARCHESTRA_GROK_TEST_BINARY) {
      result = await run([launcher, "--no-subagents", "-p", "Reply briefly."]);
      expect(result.status, result.stderr).toBe(0);
      expect(observed.at(-1)).toEqual({
        model: "explicit-deployment-model",
        callerKey: true,
      });
      expect(discoveryRequests).toBe(count);
    }
    expect(readFileSync(ordinaryConfig, "utf8")).toBe(originalConfig);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}, 60000);
