import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SetupScriptContext } from "../types";
import { piSetup } from "./pi";

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const context: SetupScriptContext = {
  clientId: "pi",
  platform: "linux",
  appName: "Test Platform",
  skills: null,
  mcp: {
    serverName: "gateway",
    toolPrefix: "archestra",
    url: "https://proxy.example/v1/mcp/gateway",
  },
  proxy: {
    authMode: "virtual-key",
    provider: "openai",
    providerLabel: "OpenAI",
    baseUrl: "https://proxy.example",
    url: "https://proxy.example/v1/openai/proxy",
    proxyName: "proxy",
    virtualKey: "test-private-key",
    virtualKeyName: "test",
    passthroughVirtualKey: null,
    model: "test-model",
  },
};
function fixture(version = "1.4.0", nodeVersion?: string) {
  const home = mkdtempSync(path.join(tmpdir(), "pi setup 日本語 "));
  homes.push(home);
  mkdirSync(path.join(home, "bin"));
  mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
  writeFileSync(
    path.join(home, ".pi/agent/mcp-auth.json"),
    JSON.stringify({
      [`mcp__${context.mcp?.serverName}|${context.mcp?.url}`]: {
        serverUrl: context.mcp?.url,
        tokens: { access_token: "test-oauth" },
      },
    }),
  );
  const network = path.join(home, "network.cjs");
  writeFileSync(
    network,
    `${nodeVersion ? `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(nodeVersion)} });` : ""}
global.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("/models") ? { data: [{ id: "test-model" }] } : { result: { tools: [] } }), { headers: { "content-type": "application/json" } });`,
  );
  vi.stubEnv("NODE_OPTIONS", `--require=${JSON.stringify(network)}`);
  writeFileSync(path.join(home, "bin/pi"), `#!/bin/sh\necho '${version}'\n`);
  chmodSync(path.join(home, "bin/pi"), 0o700);
  const run = () =>
    spawnSync("bash", ["-s"], {
      input: piSetup.bash.sections(context).join("\n"),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: "",
        PATH: `${home}/bin:${process.env.PATH}`,
      },
    });
  return {
    home,
    run,
    json: (file: string) =>
      JSON.parse(readFileSync(path.join(home, file), "utf8")),
  };
}

test("installs a private provider config and direct gateway, preserves unrelated servers on rerun", () => {
  const f = fixture();
  mkdirSync(path.join(f.home, ".pi/agent"), { recursive: true });
  writeFileSync(
    path.join(f.home, ".pi/agent/mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "other-server" } } }),
  );
  for (let i = 0; i < 2; i++) {
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
  }
  expect(f.json(".pi/agent/mcp.json")).toEqual({
    mcpServers: {
      other: { command: "other-server" },
      gateway: { url: context.mcp?.url, exposure: "direct" },
    },
  });
  expect(f.json(".archestra/pi/connection.json")).toMatchObject({
    apiKey: "test-private-key",
    model: "test-model",
  });
  expect(
    lstatSync(path.join(f.home, ".archestra/pi/connection.json")).mode & 0o777,
  ).toBe(0o600);
  expect(
    lstatSync(path.join(f.home, ".archestra/pi/install-state.json")).mode &
      0o777,
  ).toBe(0o600);
  expect(
    JSON.parse(
      Buffer.from(
        f.json(".archestra/pi/install-state.json").mcp.beforeFile,
        "base64",
      ).toString(),
    ),
  ).toEqual({
    mcpServers: { other: { command: "other-server" } },
  });
  expect(
    existsSync(path.join(f.home, ".pi/agent/extensions/archestra-pi.js")),
  ).toBe(true);
});

test("refuses an existing same-name gateway before writing credentials", () => {
  const f = fixture();
  mkdirSync(path.join(f.home, ".pi/agent"), { recursive: true });
  writeFileSync(
    path.join(f.home, ".pi/agent/mcp.json"),
    JSON.stringify({
      mcpServers: { gateway: { url: "https://other.example" } },
    }),
  );
  expect(f.run().status).not.toBe(0);
  expect(existsSync(path.join(f.home, ".archestra/pi/connection.json"))).toBe(
    false,
  );
  expect(f.json(".pi/agent/mcp.json").mcpServers.gateway.url).toBe(
    "https://other.example",
  );
});

test.each([
  "archestra",
  "archestra-openai",
])("refuses a configured %s provider that could impersonate an unloaded connection extension", (provider) => {
  const f = fixture();
  mkdirSync(path.join(f.home, ".pi/agent"), { recursive: true });
  writeFileSync(
    path.join(f.home, ".pi/agent/models.json"),
    JSON.stringify({
      providers: { [provider]: { baseUrl: "https://other.example" } },
    }),
  );
  expect(f.run().status).not.toBe(0);
  expect(existsSync(path.join(f.home, ".archestra/pi/connection.json"))).toBe(
    false,
  );
});

test.each([
  {
    args: ["--model", "archestra-openai/test-model"],
    expected: ["--provider", "archestra-openai", "--model", "test-model"],
  },
  {
    args: ["--model=test-model", "--system-prompt", "--provider"],
    expected: ["--provider", "archestra", "--model", "test-model"],
    tail: ["--system-prompt", "--provider"],
  },
  {
    args: ["-m", "test-model", "--", "space 日本語", "--provider", "literal"],
    expected: ["--provider", "archestra", "--model", "test-model"],
    tail: ["--", "space 日本語", "--provider", "literal"],
  },
])("arcpi resolves an exact catalog model and preserves literal arguments: $args", ({
  args,
  expected,
  tail,
}) => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  writeFileSync(
    path.join(f.home, "bin/pi"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARCPI_TEST_ARGS, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const output = path.join(f.home, "arguments.json");
  const result = spawnSync(path.join(f.home, ".local/bin/arcpi"), args, {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home, ARCPI_TEST_ARGS: output },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
    ...expected,
    "--extension",
    path.join(f.home, ".pi/agent/extensions/archestra-pi.js"),
    ...(tail ?? []),
  ]);
});

test.each([
  ["--provider", "archestra", "--provider", "openai"],
  ["--model", "test-model", "-m", "another"],
  ["--provider", "openai"],
  ["--model", "openai/test-model"],
  ["--model", "not-in-catalog"],
  ["--model"],
  ["--model", "--provider", "archestra"],
  ["--provider", "archestra", "--model", "archestra-openai/test-model"],
])("arcpi refuses unsafe or ambiguous overrides before starting Pi: %j", (...args) => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const marker = path.join(f.home, "started");
  writeFileSync(
    path.join(f.home, "bin/pi"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARCPI_TEST_MARKER, "started");\n`,
  );
  const result = spawnSync(path.join(f.home, ".local/bin/arcpi"), args, {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home, ARCPI_TEST_MARKER: marker },
  });
  expect(result.status).toBe(1);
  expect(existsSync(marker)).toBe(false);
});

test("refuses a symlinked configuration ancestor before writes", () => {
  const f = fixture();
  const target = path.join(f.home, "elsewhere");
  mkdirSync(target);
  rmSync(path.join(f.home, ".pi"), { recursive: true });
  symlinkSync(target, path.join(f.home, ".pi"));
  expect(f.run().status).not.toBe(0);
  expect(existsSync(path.join(target, "agent"))).toBe(false);
  expect(existsSync(path.join(f.home, ".archestra"))).toBe(false);
});

test("refuses an unsupported Pi version before writes", () => {
  const f = fixture("1.3.9");
  expect(f.run().status).not.toBe(0);
  expect(existsSync(path.join(f.home, ".archestra/pi/connection.json"))).toBe(
    false,
  );
});

test.each([
  "18.20.8",
  "20.19.0",
  "22.18.0",
])("refuses setup under Node %s before writing configuration", (version) => {
  const f = fixture("1.4.0", version);
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Node.js 22.19.0 or later");
  expect(
    existsSync(path.join(f.home, ".archestra/pi/install-state.json")),
  ).toBe(false);
  expect(existsSync(path.join(f.home, ".local/bin/arcpi"))).toBe(false);
});

test.each([
  "22.19.0",
  "24.22.0",
])("accepts supported setup Node %s", (version) => {
  const f = fixture("1.4.0", version);
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(path.join(f.home, ".archestra/pi/connection.json"))).toBe(
    true,
  );
});

test.each([
  ".pi/agent/extensions/archestra-pi.js",
  ".archestra/pi/connection.json",
  ".archestra/pi/lifecycle.cjs",
])("disconnect stays retryable through arcpi after a restoration error at %s", (target) => {
  const f = fixture();
  const installed = f.run();
  expect(installed.status, installed.stderr).toBe(0);
  const preload = path.join(f.home, "network.cjs");
  writeFileSync(
    preload,
    readFileSync(preload, "utf8") +
      `
if (process.env.PI_TEST_RESTORE_FAILURE) {
  const fs = require("node:fs"), path = require("node:path"), remove = fs.rmSync;
  fs.rmSync = (file, options) => {
    if (file === path.join(process.env.HOME, process.env.PI_TEST_RESTORE_FAILURE)) throw new Error("Test restoration error");
    return remove(file, options);
  };
}
`,
  );
  const disconnect = (fail: string) =>
    spawnSync(path.join(f.home, ".local/bin/arcpi"), ["--disconnect"], {
      encoding: "utf8",
      env: { ...process.env, HOME: f.home, PI_TEST_RESTORE_FAILURE: fail },
    });
  const failed = disconnect(target);
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("Test restoration error");
  for (const file of [
    ".local/bin/arcpi",
    ".archestra/pi/launch.cjs",
    ".archestra/pi/lifecycle.cjs",
    ".archestra/pi/connection.json",
    ".archestra/pi/install-state.json",
  ])
    expect(existsSync(path.join(f.home, file)), file).toBe(true);
  const retry = disconnect("");
  expect(retry.status, retry.stderr).toBe(0);
  expect(retry.stdout).toContain("Disconnected Pi");
  expect(
    existsSync(path.join(f.home, ".archestra/pi/install-state.json")),
  ).toBe(false);
  expect(existsSync(path.join(f.home, ".local/bin/arcpi"))).toBe(false);
  expect(
    readFileSync(path.join(f.home, ".pi/agent/mcp-auth.json"), "utf8"),
  ).toContain("test-oauth");
});

test("requires both transport sections", () => {
  expect(() => piSetup.bash.sections({ ...context, proxy: null })).toThrow();
  expect(() => piSetup.bash.sections({ ...context, mcp: null })).toThrow();
});

test("refuses a missing model instead of installing or printing an unverified fallback", () => {
  if (!context.proxy) throw new Error("Missing test proxy");
  const missing = { ...context, proxy: { ...context.proxy, model: null } };
  expect(() => piSetup.bash.sections(missing)).toThrow("Choose a model");
  expect(piSetup.ending(missing).launch).toEqual(["arcpi"]);
});

test("installs arcpi on the new shell PATH, forwards arguments without a shell and refuses a missing extension", () => {
  const f = fixture();
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  const binary = path.join(f.home, "bin/pi");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.ARCPI_TEST_ARGS, JSON.stringify(process.argv.slice(2))); process.exit(23);
`,
  );
  const output = path.join(f.home, "arguments.json");
  const args = ["space path/日本語", 'literal "quotes" and $()'];
  const launched = spawnSync(
    "bash",
    ["-c", '. "$HOME/.profile"; arcpi "$@"', "test", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: f.home, ARCPI_TEST_ARGS: output },
    },
  );
  expect(launched.status, launched.stderr).toBe(23);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
    "--provider",
    "archestra",
    "--model",
    "test-model",
    "--extension",
    path.join(f.home, ".pi/agent/extensions/archestra-pi.js"),
    ...args,
  ]);
  rmSync(output);
  rmSync(path.join(f.home, ".pi/agent/extensions/archestra-pi.js"));
  const refused = spawnSync(path.join(f.home, ".local/bin/arcpi"), [], {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home, ARCPI_TEST_ARGS: output },
  });
  expect(refused.status).toBe(1);
  expect(existsSync(output)).toBe(false);
});

function disconnect(f: ReturnType<typeof fixture>) {
  return spawnSync(
    process.execPath,
    [path.join(f.home, ".archestra/pi/lifecycle.cjs"), "disconnect"],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: f.home },
    },
  );
}

test("snapshots before modification and disconnect restores original bytes while preserving later unrelated edits", () => {
  const f = fixture();
  const originalMcp = '{"mcpServers":{"other":{"command":"unchanged"}}}\n';
  const models =
    '{"providers":{"local":{"baseUrl":"http://localhost:11434"}}}\n';
  const settings = {
    defaultProvider: "local",
    defaultModel: "original",
    theme: "light",
  };
  writeFileSync(path.join(f.home, ".pi/agent/mcp.json"), originalMcp);
  writeFileSync(path.join(f.home, ".pi/agent/models.json"), models);
  writeFileSync(
    path.join(f.home, ".pi/agent/settings.json"),
    JSON.stringify(settings),
  );
  writeFileSync(path.join(f.home, ".profile"), "# my profile\n");
  mkdirSync(path.join(f.home, ".pi/agent/skills/local"), { recursive: true });
  writeFileSync(
    path.join(f.home, ".pi/agent/skills/local/SKILL.md"),
    "local skill",
  );
  mkdirSync(path.join(f.home, ".archestra/skills/shared"), { recursive: true });
  writeFileSync(
    path.join(f.home, ".archestra/skills/shared/unmanaged"),
    "keep",
  );
  expect(f.run().status).toBe(0);
  const firstSnapshot = f.json(".archestra/pi/install-state.json");
  expect(firstSnapshot.legacy).toBe(false);
  expect(
    firstSnapshot.files[".archestra/pi/connection.json"].before,
  ).toBeNull();
  expect(f.run().status).toBe(0);
  expect(f.json(".archestra/pi/install-state.json").mcp.beforeFile).toBe(
    firstSnapshot.mcp.beforeFile,
  );
  writeFileSync(
    path.join(f.home, ".pi/agent/settings.json"),
    JSON.stringify({
      ...settings,
      defaultProvider: "archestra",
      defaultModel: "test-model",
      theme: "dark",
    }),
  );
  const profile = readFileSync(path.join(f.home, ".profile"), "utf8");
  writeFileSync(
    path.join(f.home, ".profile"),
    `${profile}# user added this later\n`,
  );
  const result = disconnect(f);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(path.join(f.home, ".pi/agent/mcp.json"), "utf8")).toBe(
    originalMcp,
  );
  expect(readFileSync(path.join(f.home, ".pi/agent/models.json"), "utf8")).toBe(
    models,
  );
  expect(f.json(".pi/agent/settings.json")).toEqual({
    ...settings,
    theme: "dark",
  });
  expect(readFileSync(path.join(f.home, ".profile"), "utf8")).toBe(
    "# my profile\n# user added this later\n",
  );
  expect(
    readFileSync(path.join(f.home, ".pi/agent/skills/local/SKILL.md"), "utf8"),
  ).toBe("local skill");
  expect(
    readFileSync(
      path.join(f.home, ".archestra/skills/shared/unmanaged"),
      "utf8",
    ),
  ).toBe("keep");
  for (const file of [
    ".archestra/pi/connection.json",
    ".pi/agent/extensions/archestra-pi.js",
    ".local/bin/arcpi",
    ".archestra/pi/install-state.json",
  ])
    expect(existsSync(path.join(f.home, file))).toBe(false);
  expect(
    spawnSync(path.join(f.home, "bin/pi"), ["--version"], {
      encoding: "utf8",
    }).stdout.trim(),
  ).toBe("1.4.0");
  expect(f.run().status).toBe(0);
  expect(f.json(".archestra/pi/install-state.json").legacy).toBe(false);
  expect(disconnect(f).status).toBe(0);
});

test("disconnect only removes this gateway's OAuth and MCP entries; user-selected direct model survives", () => {
  const f = fixture();
  rmSync(path.join(f.home, ".pi/agent/mcp-auth.json"));
  expect(f.run().status).toBe(0);
  const mcp = f.json(".pi/agent/mcp.json");
  mcp.mcpServers.later = { command: "my-server" };
  writeFileSync(path.join(f.home, ".pi/agent/mcp.json"), JSON.stringify(mcp));
  writeFileSync(
    path.join(f.home, ".pi/agent/mcp-auth.json"),
    JSON.stringify({
      [`mcp__gateway|${context.mcp?.url}`]: {
        serverUrl: context.mcp?.url,
        tokens: { access_token: "owned-test-token" },
      },
      other: { tokens: { access_token: "unrelated-test-token" } },
    }),
  );
  writeFileSync(
    path.join(f.home, ".pi/agent/settings.json"),
    JSON.stringify({
      defaultProvider: "local",
      defaultModel: "new-user-choice",
    }),
  );
  expect(disconnect(f).status).toBe(0);
  expect(f.json(".pi/agent/mcp.json")).toEqual({
    mcpServers: { later: { command: "my-server" } },
  });
  expect(f.json(".pi/agent/mcp-auth.json")).toEqual({
    other: { tokens: { access_token: "unrelated-test-token" } },
  });
  expect(f.json(".pi/agent/settings.json")).toEqual({
    defaultProvider: "local",
    defaultModel: "new-user-choice",
  });
});

test.each([
  ".archestra/pi/launch.cjs",
  ".pi/agent/extensions/archestra-pi.js",
  ".profile",
  ".pi/agent/mcp.json",
])("refuses disconnect before any mutation when %s was edited", (file) => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const target = path.join(f.home, file);
  writeFileSync(
    target,
    file.endsWith("mcp.json")
      ? JSON.stringify({
          mcpServers: { gateway: { url: "https://new.example" } },
        })
      : "user changed this",
  );
  const connection = readFileSync(
    path.join(f.home, ".archestra/pi/connection.json"),
  );
  const result = disconnect(f);
  expect(result.status).not.toBe(0);
  expect(
    readFileSync(path.join(f.home, ".archestra/pi/connection.json")),
  ).toEqual(connection);
  expect(existsSync(path.join(f.home, ".local/bin/arcpi"))).toBe(true);
  expect(readFileSync(target, "utf8")).toContain(
    file.endsWith("mcp.json") ? "new.example" : "user changed",
  );
});

test("preserves preexisting PATH entries and refuses missing or legacy restoration snapshots", () => {
  const f = fixture();
  const profile = 'export PATH="$HOME/.local/bin:$PATH"\n# owned by user\n';
  writeFileSync(path.join(f.home, ".profile"), profile);
  expect(f.run().status).toBe(0);
  expect(
    f.json(".archestra/pi/install-state.json").profiles[".profile"],
  ).toBeUndefined();
  rmSync(path.join(f.home, ".archestra/pi/install-state.json"));
  expect(disconnect(f).stderr).toContain("snapshot is missing");
  expect(existsSync(path.join(f.home, ".archestra/pi/connection.json"))).toBe(
    true,
  );
  expect(f.run().status).toBe(0);
  expect(f.json(".archestra/pi/install-state.json").legacy).toBe(true);
  expect(disconnect(f).stderr).toContain("predates restoration snapshots");
  expect(readFileSync(path.join(f.home, ".profile"), "utf8")).toBe(profile);
});

test("startup probe and offline RPC fail closed with redacted statuses, while version/help do not perform network requests", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  writeFileSync(
    path.join(f.home, "network.cjs"),
    `global.fetch = async () => new Response("PRIVATE_RESPONSE_CREDENTIAL", { status: 401, statusText: "PRIVATE_STATUS_CREDENTIAL" });`,
  );
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(f.home, ".archestra/pi/launch.cjs"), ...args],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: f.home },
        timeout: 15000,
      },
    );
  for (const args of [
    ["--mode", "rpc"],
    ["--print", "Hi"],
  ]) {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HTTP 401");
    expect(result.stderr).toContain(
      "No model request or local tool was started",
    );
    expect(result.stderr).not.toContain("PRIVATE_");
    expect(result.stdout).toBe("");
  }
  expect(run("--version").status).toBe(0);
  expect(run("--help").status).toBe(0);
  const reconnect = run("--reconnect");
  expect(reconnect.status).toBe(1);
  expect(reconnect.stderr).toContain("No browser or stdin prompt was opened");
  expect(reconnect.stdout).toBe("");
});

test("renders executable lifecycle files and existing shared startup menu for both platforms", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  for (const file of ["launch.cjs", "lifecycle.cjs"]) {
    const result = spawnSync(
      process.execPath,
      ["--check", path.join(f.home, ".archestra/pi", file)],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  }
  const shell = spawnSync(
    "bash",
    ["-n", path.join(f.home, ".archestra/pi/startup.sh")],
    { encoding: "utf8" },
  );
  expect(shell.status, shell.stderr).toBe(0);
  const ps = readFileSync(
    path.join(f.home, ".archestra/pi/startup.ps1"),
    "utf8",
  );
  expect(ps).toContain("function Invoke-ArchHealthFetch");
  expect(ps).toContain("lifecycle.cjs");
});

test.each([
  "",
  "\uFEFF",
])("Windows installer writes one BOM, hashes actual bytes, upgrades safely and restores original encoding %j", (originalBom) => {
  const f = fixture();
  const privateRoot = path.join(f.home, ".archestra/pi");
  mkdirSync(privateRoot, { recursive: true });
  const original = Buffer.from(
    `${originalBom}# Managed Pi launcher\n# Original ✓ · ⠋\r\n`,
  );
  for (const name of ["startup.ps1", "path.ps1"])
    writeFileSync(path.join(privateRoot, name), original);
  const profile = Buffer.from("\uFEFF# User profile ✓\r\n");
  writeFileSync(path.join(f.home, ".profile"), profile);
  // Exercise the decoded Windows installer, with only native process/OS
  // boundaries replaced. This is not execution of PowerShell on Windows.
  const rendered = piSetup.powerShell
    .sections({
      ...context,
      appName: "Archestra",
      platform: "windows",
    })
    .join("\n");
  const encoded = rendered.match(/\$archNodeScript = '([A-Za-z0-9+/=]+)'/);
  if (!encoded) throw new Error("Missing Windows Node payload");
  const payload = Buffer.from(encoded[1], "base64").toString("utf8");
  const native = path.join(f.home, "bin/pi.exe");
  writeFileSync(native, "Native process boundary fixture");
  const run = () =>
    new Function("require", "process", "console", payload)(
      (id: string) => {
        if (id === "node:os") return { homedir: () => f.home };
        if (id === "node:child_process")
          return {
            execFileSync: (command: string, args: string[]) => {
              if (command === native) {
                expect(args).toEqual(["--version"]);
                return "1.4.0";
              }
              expect(command).toBe("powershell.exe");
              expect(args.slice(0, 3)).toEqual([
                "-NoProfile",
                "-File",
                path.join(privateRoot, "path.ps1"),
              ]);
              return args[3] === "read" ? JSON.stringify("") : "";
            },
          };
        return require(id);
      },
      {
        ...process,
        platform: "win32",
        env: { PATH: path.dirname(native) },
      },
      { log: () => {} },
    );
  run();
  const startupFile = path.join(privateRoot, "startup.ps1");
  const first = readFileSync(startupFile);
  for (const name of ["startup.ps1", "path.ps1"]) {
    const bytes = readFileSync(path.join(privateRoot, name));
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.subarray(3, 6)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  }
  // Model PowerShell 5's BOM detection vs its legacy ANSI source decoder.
  const decoded = new TextDecoder("utf-8").decode(first);
  const legacy = new TextDecoder("windows-1252").decode(first.subarray(3));
  const braille = decoded.match(/[\u2801-\u28FF]/)?.[0];
  expect(braille).toBeDefined();
  for (const glyph of ["✓", "·", braille as string]) {
    expect(decoded).toContain(glyph);
    expect(legacy).toContain(
      new TextDecoder("windows-1252").decode(Buffer.from(glyph)),
    );
  }
  expect(legacy).toContain("â");
  const hash = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  expect(f.json(".archestra/pi/connection.json").guardSha256).toBe(hash(first));
  // Simulate the previous BOM-less managed installation, preserving its
  // original before-image and snapshot's exact last-written bytes.
  writeFileSync(startupFile, first.subarray(3));
  const state = f.json(".archestra/pi/install-state.json");
  state.files[".archestra/pi/startup.ps1"].expected = first
    .subarray(3)
    .toString("base64");
  writeFileSync(
    path.join(privateRoot, "install-state.json"),
    JSON.stringify(state),
  );
  run();
  run();
  expect(readFileSync(startupFile)).toEqual(first);
  expect(f.json(".archestra/pi/connection.json").guardSha256).toBe(hash(first));
  for (const name of [
    "launch.cjs",
    "lifecycle.cjs",
    "connection.json",
    "arcpi.cmd",
  ]) {
    const file =
      name === "arcpi.cmd"
        ? path.join(f.home, ".local/bin", name)
        : path.join(privateRoot, name);
    expect(readFileSync(file).subarray(0, 3)).not.toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
  }
  expect(
    [...readFileSync(path.join(f.home, ".local/bin/arcpi.cmd"))].every(
      (byte) => byte < 128,
    ),
  ).toBe(true);
  // Run the real restoration helper, replacing only the Windows PATH process.
  const restore = `const { PiInstallation } = require(${JSON.stringify(path.join(privateRoot, "lifecycle.cjs"))}); const install = new PiInstallation(); install.disconnect();`;
  const restoreFile = path.join(f.home, "restore.cjs");
  writeFileSync(
    restoreFile,
    `require("node:child_process").execFileSync = () => ""; ${restore}`,
  );
  const restored = spawnSync(process.execPath, [restoreFile], {
    env: { ...process.env, HOME: f.home },
    encoding: "utf8",
  });
  expect(restored.status, restored.stderr).toBe(0);
  for (const name of ["startup.ps1", "path.ps1"])
    expect(readFileSync(path.join(privateRoot, name))).toEqual(original);
  expect(readFileSync(path.join(f.home, ".profile"))).toEqual(profile);
  expect(existsSync(path.join(privateRoot, "install-state.json"))).toBe(false);
});

test("checks the router's actual qualified model identity and Pi's native OAuth namespace", () => {
  const f = fixture();
  if (!context.proxy) throw new Error("Fixture requires a proxy");
  const routed = {
    ...context,
    mcp: {
      ...context.mcp,
      serverName: "my-gateway",
      toolPrefix: "archestra",
      url: context.mcp?.url ?? "",
    },
    proxy: {
      ...context.proxy,
      primaryProviders: [
        {
          provider: "openai" as const,
          name: "OpenAI",
          models: [
            { id: "test-model", name: "Test", context: null, output: null },
          ],
        },
      ],
    },
  };
  const installed = spawnSync("bash", ["-s"], {
    input: piSetup.bash.sections(routed).join("\n"),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: f.home,
      PI_CODING_AGENT_DIR: "",
      PATH: `${f.home}/bin:${process.env.PATH}`,
    },
  });
  expect(installed.status, installed.stderr).toBe(0);
  writeFileSync(
    path.join(f.home, ".pi/agent/mcp-auth.json"),
    JSON.stringify({
      [`mcp__my_gateway|${context.mcp?.url}`]: {
        serverUrl: context.mcp?.url,
        tokens: { access_token: "test-only" },
      },
    }),
  );
  const network = path.join(f.home, "network.cjs");
  writeFileSync(
    network,
    `global.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("/models") ? { data: [{ id: "openai:test-model" }] } : { result: { tools: [] } }));`,
  );
  const check = () =>
    spawnSync(
      process.execPath,
      [path.join(f.home, ".archestra/pi/lifecycle.cjs"), "check"],
      { env: { ...process.env, HOME: f.home }, encoding: "utf8" },
    );
  expect(JSON.parse(check().stdout)).toMatchObject({
    llm: "ok",
    mcp: "ok",
    skills: "ok",
  });
  writeFileSync(
    network,
    `global.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("/models") ? { data: [{ id: "test-model" }] } : { result: { tools: [] } }));`,
  );
  expect(JSON.parse(check().stdout).llm).toBe("down");
});

test("bounded offline checks never start the native CLI or consume RPC stdin even when the visual guard is disabled", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  writeFileSync(
    path.join(f.home, "network.cjs"),
    `global.fetch = async (url, options) => new Promise((resolve, reject) => { const timer = setTimeout(() => resolve(new Response("late")), 30000); options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("PRIVATE_TIMEOUT_CREDENTIAL")); }); });`,
  );
  const output = path.join(f.home, "should-not-exist");
  writeFileSync(
    path.join(f.home, "bin/pi"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARCPI_TEST_ARGS, "started")`,
  );
  const start = Date.now();
  const child = spawnSync(
    process.execPath,
    [path.join(f.home, ".archestra/pi/launch.cjs"), "--mode", "rpc"],
    {
      env: {
        ...process.env,
        HOME: f.home,
        ARCPI_TEST_ARGS: output,
        ARCHESTRA_PI_GUARD: "0",
      },
      encoding: "utf8",
      input: '{"type":"get_state"}\n',
      timeout: 12000,
    },
  );
  expect(child.status, child.stderr).toBe(1);
  expect(Date.now() - start).toBeLessThan(10000);
  expect(existsSync(output)).toBe(false);
  expect(child.stdout).toBe("");
  expect(child.stderr).not.toContain("PRIVATE_TIMEOUT");
}, 15000);

test("catalog success explicitly leaves upstream inference untested while MCP auth is checked separately", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const requests = path.join(f.home, "requests.jsonl");
  writeFileSync(
    path.join(f.home, "network.cjs"),
    `global.fetch = async (url, options) => {
      require("node:fs").appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ url: String(url), method: options.method || "GET", body: options.body }) + "\\n");
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test-model" }] });
      if (String(url).includes("/v1/mcp/")) return Response.json({ result: { tools: [] } });
      return Response.json({ error: { message: "Invalid virtual API key" } }, { status: 401 });
    };`,
  );
  const checked = spawnSync(
    process.execPath,
    [path.join(f.home, ".archestra/pi/lifecycle.cjs"), "check"],
    { env: { ...process.env, HOME: f.home }, encoding: "utf8" },
  );
  expect(checked.status, checked.stderr).toBe(0);
  expect(JSON.parse(checked.stdout)).toMatchObject({
    llm: "ok",
    llmCheck: "proxy-catalog",
    upstreamInference: "not-tested",
    mcp: "ok",
  });
  const calls = readFileSync(requests, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls).toContainEqual({
    url: `${context.proxy?.url}/models`,
    method: "GET",
  });
  expect(calls).toContainEqual({
    url: context.mcp?.url,
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "pi-startup",
      method: "tools/list",
      params: {},
    }),
  });
  // The same network fixture has invalid upstream credentials. Startup neither
  // spends an inference request nor presents the catalog result as inference.
  const inference = spawnSync(
    process.execPath,
    [
      "-e",
      `fetch("https://proxy.example/responses", {}).then(r => console.log(r.status))`,
    ],
    { env: { ...process.env }, encoding: "utf8" },
  );
  expect(inference.stdout.trim()).toBe("401");
  for (const filename of ["startup.sh", "startup.ps1"]) {
    const script = readFileSync(
      path.join(f.home, ".archestra/pi", filename),
      "utf8",
    );
    expect(script).toContain("Proxy catalog/configuration");
    expect(script).toContain("Upstream inference is not tested at startup.");
    expect(script).not.toContain("LLM proxy (OpenAI)");
  }
});

test("disconnect refuses symlinked mutable stores and another OAuth client before touching owned files", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const target = path.join(f.home, "unrelated.json");
  writeFileSync(target, "{}");
  const auth = path.join(f.home, ".pi/agent/mcp-auth.json");
  rmSync(auth);
  symlinkSync(target, auth);
  expect(disconnect(f).status).toBe(1);
  expect(readFileSync(target, "utf8")).toBe("{}");
  expect(existsSync(path.join(f.home, ".local/bin/arcpi"))).toBe(true);
  rmSync(auth);
  writeFileSync(
    auth,
    JSON.stringify({
      [`mcp__gateway|${context.mcp?.url}`]: {
        serverUrl: context.mcp?.url,
        clientInformation: { client_id: "different-client" },
      },
    }),
  );
  const snapshot = f.json(".archestra/pi/install-state.json");
  snapshot.authClient = "owned-client";
  writeFileSync(
    path.join(f.home, ".archestra/pi/install-state.json"),
    JSON.stringify(snapshot),
  );
  expect(disconnect(f).stderr).toContain("sign-in record changed");
  expect(existsSync(path.join(f.home, ".local/bin/arcpi"))).toBe(true);
});

test("refuses lifecycle collisions before installing a launcher or changing profiles", () => {
  const f = fixture();
  mkdirSync(path.join(f.home, ".archestra/pi"), { recursive: true });
  const file = path.join(f.home, ".archestra/pi/lifecycle.cjs");
  writeFileSync(file, "// user script");
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unmanaged file");
  expect(readFileSync(file, "utf8")).toBe("// user script");
  expect(existsSync(path.join(f.home, ".local/bin/arcpi"))).toBe(false);
  expect(existsSync(path.join(f.home, ".profile"))).toBe(false);
});
