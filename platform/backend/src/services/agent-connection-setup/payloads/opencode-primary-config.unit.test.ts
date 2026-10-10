import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { SetupScriptProxySection } from "../types";
import {
  OPENCODE_PRIMARY_CONFIG_SCRIPT,
  openCodePrimaryConfig,
} from "./opencode-primary-config";

test.each([
  1, 2,
])("OpenCode %i installs all providers, preserves model IDs, refreshes and restores previous settings", (major) => {
  const home = mkdtempSync(path.join(tmpdir(), "opencode-primary-"));
  const configPath = path.join(home, ".config/opencode/opencode.json");
  const section = major === 2 ? "providers" : "provider";
  const before = {
    [section]: { local: { name: "Local account" } },
    model: "local/coder",
    enabled_providers: ["local"],
    mcp: { tools: { type: "remote", url: "https://tools.example" } },
  };
  const proxy: SetupScriptProxySection = {
    authMode: "primary-providers",
    provider: "anthropic",
    providerLabel: "Anthropic",
    baseUrl: "https://proxy.example/v1",
    url: "https://proxy.example/v1/anthropic",
    proxyName: "proxy",
    virtualKey: "arch_test",
    virtualKeyName: "Primary providers",
    passthroughVirtualKey: null,
    model: null,
    primaryProviders: [
      {
        provider: "kimi",
        name: "Kimi",
        models: [
          { id: "kimi-test", name: "Kimi", context: null, output: null },
        ],
      },
      {
        provider: "anthropic",
        name: "Anthropic",
        models: [
          { id: "claude-test", name: "Claude", context: 200000, output: 8192 },
        ],
      },
      {
        provider: "vllm",
        name: "Custom inference",
        models: [
          {
            id: "accounts/example/models/coder",
            name: "Coder",
            context: null,
            output: null,
          },
        ],
      },
      {
        provider: "openai",
        name: "My ChatGPT subscription",
        models: [
          { id: "gpt-5.3-codex", name: "Codex", context: null, output: null },
        ],
      },
    ],
  };
  const run = (input: ReturnType<typeof openCodePrimaryConfig> | null) =>
    execFileSync(process.execPath, ["-e", OPENCODE_PRIMARY_CONFIG_SCRIPT], {
      input: JSON.stringify(input),
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        ARCHESTRA_OC_MAJOR: String(major),
        ARCHESTRA_OC_KEY: "arch_test",
        ARCHESTRA_OC_PRIMARY: "stdin",
      },
    });
  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(before));
    // Exercise migration from the old single-provider installer, including its
    // backup of the user's original native provider and enabled list.
    mkdirSync(path.join(home, ".archestra"), { recursive: true });
    writeFileSync(
      path.join(home, ".archestra/opencode-connection-state.json"),
      JSON.stringify({
        providerState: { anthropic: null },
        enabledProvidersPresent: true,
        enabledProviders: before.enabled_providers,
        disabledProvidersPresent: false,
      }),
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        ...before,
        provider: {
          ...(major === 1 ? { local: { name: "Local account" } } : {}),
          anthropic: { options: { baseURL: "https://old.example/v1" } },
        },
        enabled_providers: ["anthropic"],
      }),
    );
    const payload = openCodePrimaryConfig(proxy);
    run(payload);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.enabled_providers).toEqual([
      "archestra-kimi",
      "archestra-anthropic",
      "archestra-vllm",
      "archestra-openai",
    ]);
    expect(config[section].local).toEqual({ name: "Local account" });
    expect(config[section]["archestra-kimi"]).toMatchObject({
      [major === 2 ? "package" : "npm"]:
        major === 2
          ? "@opencode/ai/providers/openai-compatible"
          : "@ai-sdk/openai-compatible",
      [major === 2 ? "settings" : "options"]: {
        baseURL: "https://proxy.example/v1/kimi",
      },
      models: {
        "kimi-test": { [major === 2 ? "modelID" : "id"]: "kimi-test" },
      },
    });
    expect(
      config[section]["archestra-vllm"].models["accounts/example/models/coder"][
        major === 2 ? "modelID" : "id"
      ],
    ).toBe("vllm:accounts/example/models/coder");
    expect(
      config[section]["archestra-openai"][major === 2 ? "package" : "npm"],
    ).toBe(
      major === 2
        ? "@opencode/ai/providers/openai-compatible/responses"
        : "@ai-sdk/openai",
    );
    expect(
      config[section]["archestra-openai"][major === 2 ? "settings" : "options"]
        .apiKey,
    ).toBe("{file:~/.archestra/opencode-primary.key}");
    expect(config.model).toBeUndefined();
    expect(
      readFileSync(path.join(home, ".archestra/opencode-primary.key"), "utf8"),
    ).toBe("arch_test");
    run(
      openCodePrimaryConfig({
        ...proxy,
        primaryProviders: proxy.primaryProviders?.slice(0, 1),
      }),
    );
    expect(
      JSON.parse(readFileSync(configPath, "utf8"))[section]["archestra-vllm"],
    ).toBeUndefined();
    run(null);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(before);
    run(null);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
