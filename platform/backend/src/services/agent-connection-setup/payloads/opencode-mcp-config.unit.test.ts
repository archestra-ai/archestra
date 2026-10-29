import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  KILO_CLIENT,
  OPENCODE_CLIENT,
  type OpenCodeFamilyClient,
} from "../opencode-family";
import { openCodeMcpMergeScript } from "./opencode-mcp-config";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const gatewayUrl = "https://platform.example.com/v1/mcp/personal-gateway";
const serverName = "deployment";

async function fixture({
  client = KILO_CLIENT,
  owned = {},
  sibling = "",
}: {
  client?: OpenCodeFamilyClient;
  owned?: Record<string, unknown>;
  sibling?: string;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-migration-"));
  roots.push(root);
  const dir = path.join(root, "xdg", client.dir);
  await mkdir(dir, { recursive: true });
  const configPath = path.join(dir, client.configFile);
  const siblingPath = path.join(dir, client.commentedConfigFile);
  await writeFile(configPath, JSON.stringify(owned));
  if (sibling) await writeFile(siblingPath, sibling);
  return {
    configPath,
    siblingPath,
    run: (
      mode: "connect" | "disconnect" | "verify" = "connect",
      failOwnedWrite = false,
    ) =>
      execFileAsync(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs"), path = require("node:path");
const configPath = process.env.ARCHESTRA_OC_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
${openCodeMcpMergeScript(client, mode)}
if (${JSON.stringify(failOwnedWrite)}) throw new Error("Simulated managed configuration write failure");
fs.writeFileSync(configPath, JSON.stringify(cfg));
writeMcpSibling();`,
        ],
        {
          env: {
            ...process.env,
            ARCHESTRA_OC_CONFIG_PATH: configPath,
            ARCHESTRA_OC_MCP_NAME: serverName,
            ARCHESTRA_OC_MCP_URL: gatewayUrl,
          },
        },
      ),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("OpenCode-family MCP migration", () => {
  test.each([
    KILO_CLIENT,
    OPENCODE_CLIENT,
  ])("$label consolidates a legacy JSONC gateway without losing comments or authentication", async (client) => {
    const sibling = `// user configuration\n{
  "mcp": {
    "my_gateway": {
      // Keep this authentication setting.
      "type": "remote", "url": "${gatewayUrl}",
      "headers": { "Authorization": "Bearer example-test-token", "note": "comma,} and // not a comment" },
      "oauth": false, "timeout": 12345,
    },
    "other": { "type": "remote", "url": "https://other.example.com/mcp" },
  },
  "instructions": ["example",],
}\n`;
    const files = await fixture({
      client,
      owned: { model: "example/model" },
      sibling,
    });
    await files.run();
    const owned = JSON.parse(await readFile(files.configPath, "utf8"));
    expect(owned).toEqual({
      model: "example/model",
      mcp: {
        deployment: {
          type: "remote",
          url: gatewayUrl,
          headers: {
            Authorization: "Bearer example-test-token",
            note: "comma,} and // not a comment",
          },
          oauth: false,
          timeout: 12345,
        },
      },
    });
    const updated = await readFile(files.siblingPath, "utf8");
    expect(updated).toBe(
      sibling.replace('"my_gateway": {', '"my_gateway": {"enabled":false,'),
    );
    expect(
      await readFile(`${files.siblingPath}.archestra-backup`, "utf8"),
    ).toBe(sibling);
    await files.run();
    expect(await readFile(files.siblingPath, "utf8")).toBe(updated);
    expect(JSON.parse(await readFile(files.configPath, "utf8"))).toEqual(owned);
    expect(
      await readFile(`${files.siblingPath}.archestra-backup`, "utf8"),
    ).toBe(sibling);
  });

  test("matches endpoints, not generic legacy names, and handles multiple aliases", async () => {
    const other = { type: "remote", url: "https://other.example.com/mcp" };
    const files = await fixture({
      owned: {
        mcp: {
          my_gateway: other,
          old_deployment: { type: "remote", url: gatewayUrl },
        },
      },
      sibling: JSON.stringify({
        mcp: {
          custom_name: { type: "remote", url: gatewayUrl, enabled: true },
          second_alias: { type: "remote", url: gatewayUrl },
          local: { type: "local", command: ["example"] },
        },
      }),
    });
    await files.run();
    const owned = JSON.parse(await readFile(files.configPath, "utf8"));
    const sibling = JSON.parse(await readFile(files.siblingPath, "utf8"));
    // Kilo deep-merges JSON then JSONC; only one alias may be enabled afterward.
    const effective = { ...owned.mcp, ...sibling.mcp };
    expect(
      Object.entries(effective)
        .filter(([, entry]) => {
          const server = entry as { url?: string; enabled?: boolean };
          return server.url === gatewayUrl && server.enabled !== false;
        })
        .map(([name]) => name),
    ).toEqual([serverName]);
    expect(owned.mcp.my_gateway).toEqual(other);
    expect(owned.mcp.old_deployment).toBeUndefined();
    expect(sibling.mcp.local).toEqual({ type: "local", command: ["example"] });
  });

  test("re-enables an existing canonical registration in the higher-precedence sibling", async () => {
    const files = await fixture({
      owned: {
        mcp: {
          deployment: { type: "remote", url: gatewayUrl, enabled: false },
        },
      },
      sibling: `{"mcp":{"deployment":{"type":"remote","url":"${gatewayUrl}","enabled": /* keep */ false}}}`,
    });
    await files.run();
    expect(
      JSON.parse(await readFile(files.configPath, "utf8")).mcp.deployment
        .enabled,
    ).toBe(true);
    expect(await readFile(files.siblingPath, "utf8")).toContain(
      '"enabled": /* keep */ true',
    );
  });

  test("honors partial higher-precedence overrides before consolidating aliases", async () => {
    const files = await fixture({
      owned: {
        mcp: {
          my_gateway: {
            type: "remote",
            url: gatewayUrl,
            headers: {
              Authorization: "Bearer previous-example",
              other: "kept",
            },
          },
          deployment: { type: "remote", url: gatewayUrl },
        },
      },
      sibling: JSON.stringify({
        mcp: {
          my_gateway: { headers: { Authorization: "Bearer current-example" } },
          deployment: { enabled: false },
        },
      }),
    });
    await files.run();
    const owned = JSON.parse(await readFile(files.configPath, "utf8"));
    const sibling = JSON.parse(await readFile(files.siblingPath, "utf8"));
    expect(owned.mcp).toEqual({
      deployment: {
        type: "remote",
        url: gatewayUrl,
        enabled: true,
        headers: { Authorization: "Bearer current-example", other: "kept" },
      },
    });
    expect(sibling.mcp.my_gateway.enabled).toBe(false);
    expect(sibling.mcp.deployment.enabled).toBe(true);
    await files.run();
    expect(JSON.parse(await readFile(files.configPath, "utf8"))).toEqual(owned);
  });

  test.each([
    { enabled: false },
    {
      type: "remote",
      url: gatewayUrl,
      enabled: false,
      oauth: false,
      headers: { Authorization: "Bearer example-test-token" },
    },
  ])("connects and disconnects a canonical JSONC registration without leaving it active", async (registration) => {
    const files = await fixture({
      sibling: JSON.stringify({
        mcp: { deployment: registration },
      }),
    });
    await files.run();
    expect(
      JSON.parse(await readFile(files.configPath, "utf8")).mcp.deployment.url,
    ).toBe(gatewayUrl);
    expect(
      JSON.parse(await readFile(files.siblingPath, "utf8")).mcp.deployment
        .enabled,
    ).toBe(true);
    await expect(files.run("verify")).rejects.toThrow();
    await files.run("disconnect");
    expect(
      JSON.parse(await readFile(files.configPath, "utf8")).mcp,
    ).toBeUndefined();
    expect(
      JSON.parse(await readFile(files.siblingPath, "utf8")).mcp.deployment
        .enabled,
    ).toBe(false);
    await files.run("verify");
    await files.run("disconnect");
    await files.run("verify");
  });

  test("keeps the old connection and credentials when the managed configuration write fails", async () => {
    const sibling = JSON.stringify({
      mcp: {
        my_gateway: {
          type: "remote",
          url: gatewayUrl,
          oauth: false,
          headers: { Authorization: "Bearer example-test-token" },
        },
      },
    });
    const files = await fixture({ sibling });
    await expect(files.run("connect", true)).rejects.toThrow(
      "Simulated managed configuration write failure",
    );
    expect(await readFile(files.siblingPath, "utf8")).toBe(sibling);
    expect(JSON.parse(await readFile(files.configPath, "utf8"))).toEqual({});
    await files.run();
    expect(
      JSON.parse(await readFile(files.configPath, "utf8")).mcp.deployment
        .headers.Authorization,
    ).toBe("Bearer example-test-token");
    expect(
      JSON.parse(await readFile(files.siblingPath, "utf8")).mcp.my_gateway
        .enabled,
    ).toBe(false);
  });

  test.each([
    `{"mcp":{"deployment":{"type":"remote","url":"https://other.example.com/mcp"}}}`,
    `{"mcp":{"my_gateway":{"type":"remote","url":"${gatewayUrl}","headers":{"Authorization":"Bearer conflicting-example"}}}}`,
    '{"mcp": { /* incomplete JSONC',
    '{"mcp":{"deployment":false}}',
    `{"mcp":{"my_gateway":{"type":"remote","url":"${gatewayUrl}","enabled":false,"enabled":true}}}`,
  ])("refuses an ambiguous or invalid sibling before modifying either file", async (sibling) => {
    const files = await fixture({
      owned: {
        mcp: {
          deployment: {
            type: "remote",
            url: gatewayUrl,
            headers: { Authorization: "Bearer original-example" },
          },
        },
      },
      sibling,
    });
    const owned = await readFile(files.configPath, "utf8");
    await expect(files.run()).rejects.toThrow();
    expect(await readFile(files.configPath, "utf8")).toBe(owned);
    expect(await readFile(files.siblingPath, "utf8")).toBe(sibling);
  });
});
