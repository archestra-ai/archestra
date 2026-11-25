import { describe, expect, it } from "vitest";
import {
  buildAgentCatalogRuntime,
  buildCustomAgentRuntime,
  getAgentCatalogImages,
} from "./agent-catalog-images";
import {
  agentRuntimeCanNameAccountKind,
  companyAccountWords,
  resolveAgentRuntimeTemplate,
  withAgentRuntimeDefaults,
  withAgentRuntimeTemplateSettings,
} from "./agent-runtime-access";

const catalogImages = getAgentCatalogImages({
  registry: "mirror.example.com/archestra",
  tag: "1.5.0",
});
const customTemplates = [
  { id: "c0ffee00-0000-4000-8000-000000000001", image: "example.com/own:v1" },
];

describe("resolveAgentRuntimeTemplate", () => {
  it("finds the maintained runtime by its wrapper or its image, whatever else is set", () => {
    for (const runtime of [
      buildAgentCatalogRuntime({ id: "codex", image: "example.com/x:v1" }),
      // A maintained image entered as a custom image is still that runtime.
      buildCustomAgentRuntime({
        image: "ghcr.io/archestra-ai/agent-claude-code:1.4.0",
      }),
    ]) {
      expect(
        resolveAgentRuntimeTemplate({
          runtime,
          catalogImages,
          customTemplates,
        }),
      ).toEqual({
        kind: "built-in",
        id: runtime.command ? "codex" : "claude-code",
      });
    }
  });

  it("keeps a custom runtime's image its own whatever wrapper an agent sets", () => {
    expect(
      resolveAgentRuntimeTemplate({
        runtime: {
          ...buildCustomAgentRuntime({ image: "example.com/own:v1" }),
          command: ["archestra-codex"],
        },
        catalogImages,
        customTemplates,
      }),
    ).toEqual({ kind: "custom", id: customTemplates[0].id });
  });

  it("finds a custom runtime by its image, and nothing for an unknown image", () => {
    expect(
      resolveAgentRuntimeTemplate({
        runtime: buildCustomAgentRuntime({ image: " example.com/own:v1" }),
        catalogImages,
        customTemplates,
      }),
    ).toEqual({ kind: "custom", id: customTemplates[0].id });
    expect(
      resolveAgentRuntimeTemplate({
        runtime: buildCustomAgentRuntime({ image: "example.com/other:v1" }),
        catalogImages,
        customTemplates,
      }),
    ).toBeNull();
  });

  it("does not place a custom image with a standalone runtime wrapper on a maintained runtime", () => {
    for (const command of [
      "archestra-claude-code-runtime",
      "archestra-codex-runtime",
    ]) {
      expect(
        resolveAgentRuntimeTemplate({
          runtime: {
            ...buildCustomAgentRuntime({ image: "example.com/other:v1" }),
            command: [command],
          },
          catalogImages,
          customTemplates,
        }),
      ).toBeNull();
    }
  });
});

describe("withAgentRuntimeDefaults", () => {
  const catalog = buildAgentCatalogRuntime({ id: "claude-code", image: "a:0" });

  it("lays an administrator's Claude account and limits over the catalog's", () => {
    const defaults = {
      ttlHours: 6,
      claudeCode: { authentication: "provider" as const },
    };

    expect(withAgentRuntimeDefaults({ runtime: catalog, defaults })).toEqual({
      ...catalog,
      ttlHours: 6,
      claudeCode: { ...catalog.claudeCode, authentication: "provider" },
    });
  });

  it("starts a Claude runtime's agents on the Claude account of the kind its rule names", () => {
    for (const [kind, authentication] of [
      ["key", "provider"],
      ["subscription", "subscription"],
    ] as const) {
      const started = withAgentRuntimeDefaults({
        runtime: catalog,
        defaults: { accounts: { kind } },
      });

      expect(started).toEqual({
        ...catalog,
        claudeCode: { ...catalog.claudeCode, authentication },
      });
    }
  });

  it("keeps the runtime's account rule out of the agent's own runtime", () => {
    const codex = buildAgentCatalogRuntime({ id: "codex", image: "a:0" });
    const defaults = {
      ttlHours: 6,
      accounts: {
        kind: "key" as const,
        llmApiKeyId: "c0ffee00-0000-4000-8000-000000000002",
        keyName: "Company OpenAI",
      },
    };

    expect(withAgentRuntimeDefaults({ runtime: codex, defaults })).toEqual({
      ...codex,
      ttlHours: 6,
    });
  });
});

describe("agentRuntimeCanNameAccountKind", () => {
  it("is for the runtimes whose agents have two account kinds", () => {
    const named = (id: Parameters<typeof buildAgentCatalogRuntime>[0]["id"]) =>
      agentRuntimeCanNameAccountKind(
        buildAgentCatalogRuntime({ id, image: "a:0" }),
      );

    // A subscription of the runtime's own, or Claude's.
    expect(
      ["codex", "grok", "copilot", "claude-code"].map((id) =>
        named(id as "codex"),
      ),
    ).toEqual([true, true, true, true]);
    expect(
      ["opencode", "hermes", "openclaw", "kimi"].map((id) =>
        named(id as "codex"),
      ),
    ).toEqual([false, false, false, false]);
    // A custom image has two once it declares Claude Code.
    const custom = buildCustomAgentRuntime({ image: "a:0" });
    expect(agentRuntimeCanNameAccountKind(custom)).toBe(false);
    expect(
      agentRuntimeCanNameAccountKind({
        ...custom,
        claudeCode: { authentication: "provider" },
      }),
    ).toBe(true);
  });
});

describe("companyAccountWords", () => {
  it("calls the GitHub Copilot CLI's company account an enterprise plan, never an API key", () => {
    for (const command of ["archestra-copilot", "archestra-copilot-runtime"]) {
      const words = companyAccountWords(command);
      expect(words.plan).toBe(true);
      expect(Object.values(words).join(" ")).not.toMatch(/API key|connection/);
      expect(words).toMatchObject({
        a: "the company's enterprise plan",
        companys: "company's enterprise plan",
        short: "enterprise plan",
        connection: "plan",
      });
    }
  });

  it("calls every other runtime's company account an API key with a connection", () => {
    for (const command of [
      "archestra-codex",
      "archestra-grok",
      "my-agent",
      null,
      undefined,
    ]) {
      expect(companyAccountWords(command)).toMatchObject({
        plan: false,
        a: "a company API key",
        the: "the company API key",
        companys: "company's API key",
        short: "API key",
        connection: "connection",
        aConnection: "a connection",
      });
    }
  });
});

describe("withAgentRuntimeTemplateSettings", () => {
  it("keeps the agent's own Claude account, whatever the runtime's settings store", () => {
    const agent = buildAgentCatalogRuntime({ id: "claude-code", image: "a:0" });
    const none = buildCustomAgentRuntime({ image: "a:0" });
    // A Claude account in a runtime's settings only starts new agents.
    for (const template of [
      none,
      { ...none, claudeCode: { authentication: "provider" as const } },
      { ...none, claudeCode: { authentication: "subscription" as const } },
    ]) {
      const kept = withAgentRuntimeTemplateSettings({
        runtime: agent,
        template,
      });
      expect(kept.claudeCode).toEqual(agent.claudeCode);
    }
    const unnamed = withAgentRuntimeTemplateSettings({
      runtime: none,
      template: { ...none, claudeCode: { authentication: "provider" } },
    });
    expect(unnamed).not.toHaveProperty("claudeCode");
  });

  it("takes the runtime's settings and keeps the agent's own image, values and model", () => {
    const template = {
      ...buildAgentCatalogRuntime({ id: "claude-code", image: "a:1" }),
      claudeCode: { authentication: "provider" as const },
      ttlHours: 8,
      maxTier: "large",
    };
    const agent = {
      ...buildAgentCatalogRuntime({ id: "claude-code", image: "a:0" }),
      environment: [{ key: "OWN", value: "1" }],
      ports: [3000],
      ttlHours: 1,
    };
    const kept = withAgentRuntimeTemplateSettings({ runtime: agent, template });
    expect(kept).toMatchObject({
      image: "a:0",
      environment: agent.environment,
      ports: [3000],
      ttlHours: 8,
      maxTier: "large",
      claudeCode: agent.claudeCode,
    });
  });
});
