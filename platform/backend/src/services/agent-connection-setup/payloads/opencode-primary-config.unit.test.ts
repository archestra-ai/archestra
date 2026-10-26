import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { KILO_CLIENT, OPENCODE_CLIENT } from "../opencode-family";
import type { SetupScriptProxySection } from "../types";
import {
  openCodePrimaryConfig,
  openCodePrimaryConfigScript,
  publicManagedCatalog,
} from "./opencode-primary-config";

const OPENCODE_PRIMARY_CONFIG_SCRIPT =
  openCodePrimaryConfigScript(OPENCODE_CLIENT);

const PROXY: SetupScriptProxySection = {
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
      provider: "kimi",
      name: "Moonshot (Kimi)",
      models: [{ id: "kimi-k3", name: "kimi-k3", context: null, output: null }],
    },
    {
      provider: "anthropic",
      name: "Anthropic Personal",
      models: [
        { id: "claude-test", name: "Claude", context: 200000, output: 8192 },
      ],
    },
    {
      provider: "vllm",
      name: "Lab cluster",
      models: [
        {
          id: "accounts/example/models/coder",
          name: "Coder",
          context: null,
          output: null,
        },
      ],
    },
  ],
};

function runScript(script: string, home: string, input: object | null): string {
  return execFileSync(process.execPath, ["-e", script], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      ARCHESTRA_OC_KEY: "arch_test",
      ARCHESTRA_OC_PRIMARY: "stdin",
    },
  });
}

test("maps primary providers and the user's own sign-ins to the client's provider ids and names the rest", () => {
  const payload = openCodePrimaryConfig(PROXY, "Acme");
  // Every served provider keeps the client's id; the routes are the
  // provider's own wire on the proxy, under the setup context.
  expect(payload.routes).toEqual({
    anthropic: "https://proxy.example/v1/anthropic/v1",
    google: "https://proxy.example/v1/gemini/v1beta",
    openai: "https://proxy.example/v1/openai",
    moonshotai: "https://proxy.example/v1/kimi",
  });
  expect(payload.catalog).toEqual({
    routes: payload.routes,
    managed: { anthropic: ["claude-test"], moonshotai: ["kimi-k3"] },
    passthrough: ["anthropic", "google", "openai"],
    legacy: {
      "archestra-anthropic": "anthropic",
      "archestra-kimi": "moonshotai",
    },
  });
  // The passthrough key goes only on the user's own sign-ins.
  expect(payload.routeHeaders).toEqual({
    anthropic: { "X-Archestra-Virtual-Key": "arch_passthrough" },
    google: { "X-Archestra-Virtual-Key": "arch_passthrough" },
    openai: { "X-Archestra-Virtual-Key": "arch_passthrough" },
  });
  expect(
    openCodePrimaryConfig({ ...PROXY, passthroughVirtualKey: null }, "Acme")
      .routeHeaders,
  ).toEqual({});
  // No OpenCode provider speaks vLLM's wire, so it cannot be shown without
  // an Archestra-specific provider; the installer says so.
  expect(payload.unsupported).toEqual(["Lab cluster"]);
  expect(JSON.stringify(payload)).not.toContain("archestra-vllm");
  expect(JSON.stringify(payload)).not.toContain("model-router");
  expect(payload.appName).toBe("Acme");
});

test("the runtime catalog addresses the installation's agent on ordinary proxy routes", () => {
  expect(
    publicManagedCatalog({
      primaryProviders: PROXY.primaryProviders,
      passthroughProviders: ["openai"],
      ordinaryBaseUrl: "https://deployment.example/v1/",
      routingAgentId: "agent-1",
    }),
  ).toEqual({
    routes: {
      anthropic: "https://deployment.example/v1/anthropic/agent-1/v1",
      openai: "https://deployment.example/v1/openai/agent-1",
      moonshotai: "https://deployment.example/v1/kimi/agent-1",
    },
    managed: { anthropic: ["claude-test"], moonshotai: ["kimi-k3"] },
    passthrough: ["openai"],
    legacy: {
      "archestra-anthropic": "anthropic",
      "archestra-kimi": "moonshotai",
    },
  });
});

test("connect writes the key and leaves the client's providers, allowlists and pins alone", () => {
  const home = mkdtempSync(path.join(tmpdir(), "opencode-primary-"));
  const configPath = path.join(home, ".config/opencode/opencode.json");
  const before = {
    provider: { local: { name: "Local account" } },
    enabled_providers: ["local", "anthropic"],
    disabled_providers: ["google"],
    model: "anthropic/claude-test",
    small_model: "local/coder",
    agent: {
      compaction: { model: "kimi-code-plan-global/k3" },
      build: { model: "openai/gpt-own", prompt: "build" },
      review: { model: "moonshotai/kimi-k2.6" },
      // An earlier setup's id for the Anthropic key: the plugin moves it to
      // the client's provider, so it is served.
      old: { model: "archestra-anthropic/claude-test" },
    },
    mcp: { tools: { type: "remote", url: "https://tools.example" } },
  };
  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(before));
    const output = runScript(
      OPENCODE_PRIMARY_CONFIG_SCRIPT,
      home,
      openCodePrimaryConfig(PROXY, "Acme"),
    );
    // The file is untouched: the routing plugin filters the client's own
    // catalog while connected.
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(before);
    expect(
      readFileSync(path.join(home, ".archestra/opencode-primary.key"), "utf8"),
    ).toBe("arch_test");
    expect(
      JSON.parse(
        readFileSync(
          path.join(home, ".archestra/opencode-primary-state.json"),
          "utf8",
        ),
      ),
    ).toEqual({ sections: {}, fields: {}, agents: {} });
    // A pin on a served model or on a provider the user signs in to is fine;
    // the rest are named once. A served provider the user may sign in to
    // serves any model of theirs.
    expect(output.trim().split("\n")).toEqual([
      "warn:Acme does not offer OpenCode small_model local/coder. OpenCode ignores it while connected. Choose a model in OpenCode with /models.",
      "warn:Acme does not offer OpenCode agent.compaction.model kimi-code-plan-global/k3. The agent uses the session's model while connected.",
      "warn:Acme does not offer OpenCode agent.review.model moonshotai/kimi-k2.6. The agent uses the session's model while connected.",
      "warn:Lab cluster has no OpenCode provider, so OpenCode does not list its models.",
    ]);

    // Disconnect removes the key and state and changes nothing else.
    runScript(OPENCODE_PRIMARY_CONFIG_SCRIPT, home, null);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(before);
    expect(existsSync(path.join(home, ".archestra/opencode-primary.key"))).toBe(
      false,
    );
    expect(
      existsSync(path.join(home, ".archestra/opencode-primary-state.json")),
    ).toBe(false);
    // A second disconnect is a no-op.
    runScript(OPENCODE_PRIMARY_CONFIG_SCRIPT, home, null);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("connect does not create a config file the client did not have", () => {
  const home = mkdtempSync(path.join(tmpdir(), "opencode-primary-fresh-"));
  try {
    expect(
      runScript(
        OPENCODE_PRIMARY_CONFIG_SCRIPT,
        home,
        openCodePrimaryConfig(
          { ...PROXY, primaryProviders: PROXY.primaryProviders?.slice(1, 2) },
          "Acme",
        ),
      ),
    ).toBe("");
    expect(existsSync(path.join(home, ".config/opencode/opencode.json"))).toBe(
      false,
    );
    expect(
      readFileSync(path.join(home, ".archestra/opencode-primary.key"), "utf8"),
    ).toBe("arch_test");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reconnecting restores what an older installer changed and migrates the single-provider installer's state", () => {
  const home = mkdtempSync(path.join(tmpdir(), "opencode-primary-upgrade-"));
  const configPath = path.join(home, ".config/opencode/opencode.json");
  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    mkdirSync(path.join(home, ".archestra"), { recursive: true });
    // An older installer wrote the proxy's providers into the file, moved
    // the pins to them and took this snapshot.
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          local: { name: "Local account" },
          "archestra-anthropic": {
            name: "Anthropic Personal",
            npm: "@ai-sdk/openai",
            options: {
              baseURL: "https://proxy.example/v1/model-router",
              apiKey: "{file:~/.archestra/opencode-primary.key}",
            },
            models: { "claude-test": { id: "anthropic:claude-test" } },
          },
          anthropic: { options: { baseURL: "https://old.example/v1" } },
        },
        enabled_providers: ["archestra-anthropic"],
        model: "archestra-anthropic/claude-test",
        agent: { compaction: { model: "archestra-kimi/k3" } },
      }),
    );
    writeFileSync(
      path.join(home, ".archestra/opencode-primary-state.json"),
      JSON.stringify({
        sections: { provider: { "archestra-anthropic": null } },
        fields: {
          enabled_providers: ["anthropic"],
          disabled_providers: null,
          model: "anthropic/claude-test",
          small_model: null,
        },
        agents: { compaction: "kimi-code-plan-global/k3" },
      }),
    );
    // And the installer before that one kept its own backup of a native
    // provider override.
    writeFileSync(
      path.join(home, ".archestra/opencode-connection-state.json"),
      JSON.stringify({
        providerState: { anthropic: null },
        enabledProvidersPresent: false,
        disabledProvidersPresent: false,
      }),
    );
    runScript(
      OPENCODE_PRIMARY_CONFIG_SCRIPT,
      home,
      openCodePrimaryConfig(PROXY, "Acme"),
    );
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      provider: { local: { name: "Local account" } },
      model: "anthropic/claude-test",
      agent: { compaction: { model: "kimi-code-plan-global/k3" } },
    });
    expect(
      existsSync(path.join(home, ".archestra/opencode-connection-state.json")),
    ).toBe(false);
    expect(
      JSON.parse(
        readFileSync(
          path.join(home, ".archestra/opencode-primary-state.json"),
          "utf8",
        ),
      ),
    ).toEqual({ sections: {}, fields: {}, agents: {} });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Kilo Code gets the key file and state under its own names", () => {
  const home = mkdtempSync(path.join(tmpdir(), "kilo-primary-"));
  try {
    runScript(
      openCodePrimaryConfigScript(KILO_CLIENT),
      home,
      openCodePrimaryConfig(PROXY, "Archestra"),
    );
    expect(
      readFileSync(path.join(home, ".archestra/kilo-primary.key"), "utf8"),
    ).toBe("arch_test");
    expect(
      existsSync(path.join(home, ".archestra/kilo-primary-state.json")),
    ).toBe(true);
    expect(existsSync(path.join(home, ".config/kilo/kilo.json"))).toBe(false);
    expect(existsSync(path.join(home, ".config/opencode"))).toBe(false);
    runScript(openCodePrimaryConfigScript(KILO_CLIENT), home, null);
    expect(existsSync(path.join(home, ".archestra/kilo-primary.key"))).toBe(
      false,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  OPENCODE_CLIENT,
  KILO_CLIENT,
])("$label primary setup and disconnect accept a BOM without losing preferences", (client) => {
  const home = mkdtempSync(path.join(tmpdir(), "primary-bom-"));
  const configPath = path.join(home, ".config", client.dir, client.configFile);
  const original = {
    model: "anthropic/claude-test",
    instructions: ["custom.md"],
  };
  const script = openCodePrimaryConfigScript(client);
  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, `\uFEFF${JSON.stringify(original)}`);
    runScript(script, home, openCodePrimaryConfig(PROXY, "Acme"));
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(original);
    writeFileSync(configPath, `\uFEFF${readFileSync(configPath, "utf8")}`);
    runScript(script, home, null);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(original);
    expect(
      existsSync(
        path.join(home, ".archestra", `${client.stateName}-primary.key`),
      ),
    ).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
