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
import type { SupportedProvider } from "@archestra/shared/model-constants";
import { describe, expect, test } from "vitest";
import { KILO_CLIENT, OPENCODE_CLIENT } from "../opencode-family";
import type { SetupScriptProxySection } from "../types";
import {
  openCodePrimaryConfig,
  openCodePrimaryConfigScript,
} from "./opencode-primary-config";

const OPENCODE_PRIMARY_CONFIG_SCRIPT =
  openCodePrimaryConfigScript(OPENCODE_CLIENT);

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
    const payload = openCodePrimaryConfig(proxy, "Acme");
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
      openCodePrimaryConfig(
        {
          ...proxy,
          primaryProviders: proxy.primaryProviders?.slice(0, 1),
        },
        "Acme",
      ),
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

test.each([
  1, 2,
])("OpenCode %i writes both limit fields when either is known and omits limit when neither is", (major) => {
  const home = mkdtempSync(path.join(tmpdir(), "opencode-limits-"));
  const section = major === 2 ? "providers" : "provider";
  try {
    execFileSync(process.execPath, ["-e", OPENCODE_PRIMARY_CONFIG_SCRIPT], {
      input: JSON.stringify(
        openCodePrimaryConfig(
          {
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
                provider: "anthropic",
                name: "Anthropic",
                models: [
                  {
                    id: "context-only",
                    name: "context-only",
                    context: 200000,
                    output: null,
                  },
                  {
                    id: "output-only",
                    name: "output-only",
                    context: null,
                    output: 8192,
                  },
                  { id: "both", name: "both", context: 200000, output: 8192 },
                  {
                    id: "neither",
                    name: "neither",
                    context: null,
                    output: null,
                  },
                ],
              },
            ],
          },
          "Acme",
        ),
      ),
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        ARCHESTRA_OC_MAJOR: String(major),
        ARCHESTRA_OC_KEY: "arch_test",
        ARCHESTRA_OC_PRIMARY: "stdin",
      },
    });
    const { models } = JSON.parse(
      readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8"),
    )[section]["archestra-anthropic"];
    expect(models["context-only"].limit).toEqual({
      context: 200000,
      output: 0,
    });
    expect(models["output-only"].limit).toEqual({ context: 0, output: 8192 });
    expect(models.both.limit).toEqual({ context: 200000, output: 8192 });
    expect(models.neither).not.toHaveProperty("limit");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

describe.each([1, 2])("OpenCode %i default model after connect", (major) => {
  const section = major === 2 ? "providers" : "provider";
  const proxy = (
    primaryProviders: NonNullable<SetupScriptProxySection["primaryProviders"]>,
  ): SetupScriptProxySection => ({
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
    primaryProviders,
  });
  const entry = (provider: SupportedProvider, ...ids: string[]) => ({
    provider,
    name: provider,
    models: ids.map((id) => ({ id, name: id, context: null, output: null })),
  });
  const catalog = proxy([
    entry("anthropic", "claude-test"),
    entry("openai", "gpt-test"),
    entry("gemini", "gemini-test"),
  ]);

  function setup(before: Record<string, unknown>) {
    const home = mkdtempSync(path.join(tmpdir(), "opencode-pin-"));
    const configPath = path.join(home, ".config/opencode/opencode.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(before));
    const run = (input: ReturnType<typeof openCodePrimaryConfig> | null) =>
      execFileSync(process.execPath, ["-e", OPENCODE_PRIMARY_CONFIG_SCRIPT], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          ARCHESTRA_OC_MAJOR: String(major),
          ARCHESTRA_OC_KEY: "arch_test",
          ARCHESTRA_OC_PRIMARY: "stdin",
        },
      });
    const read = () => JSON.parse(readFileSync(configPath, "utf8"));
    return { home, run, read };
  }

  test("moves a native pin to the Archestra provider that serves the same model", () => {
    const { home, run, read } = setup({
      model: "openai/gpt-test",
      small_model: "google/gemini-test",
    });
    try {
      const output = run(openCodePrimaryConfig(catalog, "Acme"));
      expect(read().model).toBe("archestra-openai/gpt-test");
      expect(read().small_model).toBe("archestra-gemini/gemini-test");
      expect(output).toContain(
        "info:OpenCode model openai/gpt-test now uses archestra-openai/gpt-test from Acme. Disconnect restores openai/gpt-test.",
      );
      expect(output).toContain(
        "info:OpenCode small_model google/gemini-test now uses archestra-gemini/gemini-test from Acme.",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("moves agent pins to their Archestra twins, removes one nothing serves, and disconnect restores them", () => {
    const before = {
      agent: {
        general: { model: "openai/gpt-test", prompt: "research" },
        // Kilo Code pins its compaction agent to a Kimi Code plan provider;
        // the Kimi provider here serves the same model under its own id.
        compaction: { model: "kimi-code-plan-global/k3" },
        summary: { model: "kimi-code-plan-cn/k3-256k" },
        build: { prompt: "no pin" },
      },
    };
    const withKimi = proxy([
      entry("anthropic", "claude-test"),
      entry("openai", "gpt-test"),
      entry("kimi", "k3"),
    ]);
    const { home, run, read } = setup(before);
    try {
      const output = run(openCodePrimaryConfig(withKimi, "Acme"));
      expect(read().agent).toEqual({
        general: { model: "archestra-openai/gpt-test", prompt: "research" },
        compaction: { model: "archestra-kimi/k3" },
        summary: {},
        build: { prompt: "no pin" },
      });
      expect(output).toContain(
        "info:OpenCode agent.general.model openai/gpt-test now uses archestra-openai/gpt-test from Acme. Disconnect restores openai/gpt-test.",
      );
      expect(output).toContain(
        "info:OpenCode agent.compaction.model kimi-code-plan-global/k3 now uses archestra-kimi/k3 from Acme. Disconnect restores kimi-code-plan-global/k3.",
      );
      expect(output).toContain(
        "warn:Acme does not offer OpenCode agent.summary.model kimi-code-plan-cn/k3-256k, so setup removed it. The agent uses the session's model. Disconnect restores kimi-code-plan-cn/k3-256k.",
      );
      // A second run remaps from the original pins, and disconnect restores them.
      run(openCodePrimaryConfig(withKimi, "Acme"));
      expect(read().agent.compaction.model).toBe("archestra-kimi/k3");
      run(null);
      expect(read().agent).toEqual(before.agent);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("removes a pin Archestra cannot serve so OpenCode falls back to the first provider", () => {
    const { home, run, read } = setup({
      model: "openai/gpt-not-offered",
      small_model: "local/coder",
    });
    try {
      const output = run(openCodePrimaryConfig(catalog, "Acme"));
      const config = read();
      expect(config.model).toBeUndefined();
      expect(config.small_model).toBeUndefined();
      expect(output).toContain(
        "warn:Acme does not offer OpenCode model openai/gpt-not-offered, so setup removed it. Choose a model in OpenCode with /models. Disconnect restores openai/gpt-not-offered.",
      );
      expect(output).toContain("OpenCode small_model local/coder");
      expect(Object.keys(config[section])[0]).toBe("archestra-anthropic");
      expect(config.enabled_providers[0]).toBe("archestra-anthropic");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps an Archestra pin whose model is offered and drops one whose model is not", () => {
    const { home, run, read } = setup({
      model: "archestra-openai/gpt-test",
      small_model: "archestra-openai/retired",
    });
    try {
      const output = run(openCodePrimaryConfig(catalog, "Acme"));
      expect(read().model).toBe("archestra-openai/gpt-test");
      expect(read().small_model).toBeUndefined();
      expect(output).not.toContain("OpenCode model");
      expect(output).toContain("OpenCode small_model archestra-openai/retired");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never adds a pin when the user had none", () => {
    const { home, run, read } = setup({});
    try {
      expect(run(openCodePrimaryConfig(catalog, "Acme"))).toBe("");
      expect(read()).not.toHaveProperty("model");
      expect(read()).not.toHaveProperty("small_model");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("lists Archestra providers in catalog order even when earlier runs left them in another order", () => {
    const stale = (id: string) => ({ name: id });
    const { home, run, read } = setup({
      [section]: {
        "archestra-gemini": stale("old"),
        local: { name: "Local account" },
        "archestra-anthropic": stale("old"),
      },
      enabled_providers: ["archestra-gemini"],
    });
    try {
      run(openCodePrimaryConfig(catalog, "Acme"));
      expect(
        Object.keys(read()[section]).filter((id) =>
          id.startsWith("archestra-"),
        ),
      ).toEqual([
        "archestra-anthropic",
        "archestra-openai",
        "archestra-gemini",
      ]);
      expect(read().enabled_providers).toEqual([
        "archestra-anthropic",
        "archestra-openai",
        "archestra-gemini",
      ]);
      run(null);
      expect(read()[section]).toEqual({
        "archestra-gemini": stale("old"),
        local: { name: "Local account" },
        "archestra-anthropic": stale("old"),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("re-running setup remaps from the original pin and disconnect restores it", () => {
    const before = {
      model: "openai/gpt-test",
      small_model: "openai/gpt-not-offered",
      enabled_providers: ["openai"],
    };
    const { home, run, read } = setup(before);
    try {
      run(openCodePrimaryConfig(catalog, "Acme"));
      run(openCodePrimaryConfig(catalog, "Acme"));
      expect(read().model).toBe("archestra-openai/gpt-test");
      expect(read().small_model).toBeUndefined();
      run(null);
      expect(read()).toEqual(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("Kilo Code gets the same providers in its own config, key file and state", () => {
  const home = mkdtempSync(path.join(tmpdir(), "kilo-primary-"));
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
        provider: "anthropic",
        name: "Anthropic",
        models: [
          { id: "claude-test", name: "Claude", context: 200000, output: 8192 },
        ],
      },
    ],
  };
  const run = (input: ReturnType<typeof openCodePrimaryConfig> | null) =>
    execFileSync(
      process.execPath,
      ["-e", openCodePrimaryConfigScript(KILO_CLIENT)],
      {
        input: JSON.stringify(input),
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          // Kilo's setup always passes OpenCode 1's plugin API.
          ARCHESTRA_OC_MAJOR: "1",
          ARCHESTRA_OC_KEY: "arch_test",
          ARCHESTRA_OC_PRIMARY: "stdin",
        },
      },
    );
  try {
    run(openCodePrimaryConfig(proxy, "Archestra"));
    const config = JSON.parse(
      readFileSync(path.join(home, ".config/kilo/kilo.json"), "utf8"),
    );
    expect(config.enabled_providers).toEqual(["archestra-anthropic"]);
    expect(config.provider["archestra-anthropic"].options).toEqual({
      baseURL: "https://proxy.example/v1/model-router",
      apiKey: "{file:~/.archestra/kilo-primary.key}",
    });
    expect(
      readFileSync(path.join(home, ".archestra/kilo-primary.key"), "utf8"),
    ).toBe("arch_test");
    expect(() =>
      readFileSync(path.join(home, ".config/opencode/opencode.json")),
    ).toThrow();

    run(null);
    expect(
      JSON.parse(
        readFileSync(path.join(home, ".config/kilo/kilo.json"), "utf8"),
      ),
    ).toEqual({});
    expect(() =>
      readFileSync(path.join(home, ".archestra/kilo-primary.key")),
    ).toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("routes the user's own sign-ins next to the Archestra providers and keeps a native pin", () => {
  const home = mkdtempSync(path.join(tmpdir(), "opencode-native-"));
  const configPath = path.join(home, ".config/opencode/opencode.json");
  const proxy: SetupScriptProxySection = {
    authMode: "primary-providers",
    provider: "anthropic",
    providerLabel: "Anthropic",
    baseUrl: "https://proxy.example/v1",
    url: "https://proxy.example/v1/anthropic",
    proxyName: "proxy",
    virtualKey: "arch_test",
    virtualKeyName: "Primary providers",
    passthroughVirtualKey: "arch_passthrough",
    passthroughProviders: ["anthropic", "openai", "gemini"],
    model: null,
    primaryProviders: [
      {
        provider: "anthropic",
        name: "Anthropic",
        models: [
          { id: "claude-test", name: "Claude", context: null, output: null },
        ],
      },
    ],
  };
  const payload = openCodePrimaryConfig(proxy, "Acme");
  expect(payload.routes).toEqual({
    "archestra-anthropic": "https://proxy.example/v1/model-router",
    anthropic: "https://proxy.example/v1/anthropic/v1",
    google: "https://proxy.example/v1/gemini/v1beta",
    openai: "https://proxy.example/v1/openai",
  });
  // The passthrough key goes only on the user's own sign-ins: the Archestra
  // providers already authenticate with the virtual key.
  expect(payload.routeHeaders).toEqual({
    anthropic: { "X-Archestra-Virtual-Key": "arch_passthrough" },
    google: { "X-Archestra-Virtual-Key": "arch_passthrough" },
    openai: { "X-Archestra-Virtual-Key": "arch_passthrough" },
  });
  expect(payload.nativeRoutes).toEqual(["anthropic", "google", "openai"]);
  expect(
    openCodePrimaryConfig({ ...proxy, passthroughVirtualKey: null }, "Acme")
      .routeHeaders,
  ).toEqual({});
  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "openai/gpt-own",
        small_model: "anthropic/claude-test",
      }),
    );
    const output = execFileSync(
      process.execPath,
      ["-e", OPENCODE_PRIMARY_CONFIG_SCRIPT],
      {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          ARCHESTRA_OC_MAJOR: "1",
          ARCHESTRA_OC_KEY: "arch_test",
          ARCHESTRA_OC_PRIMARY: "stdin",
        },
      },
    );
    expect(output).toBe("");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    // A pin on a provider the user signs in to stays, even when an Archestra
    // provider offers the same model.
    expect(config.model).toBe("openai/gpt-own");
    expect(config.small_model).toBe("anthropic/claude-test");
    // The file lists the Archestra providers; the plugin lists the rest.
    expect(config.enabled_providers).toEqual(["archestra-anthropic"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
