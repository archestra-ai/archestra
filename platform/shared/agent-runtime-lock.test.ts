import { describe, expect, it } from "vitest";
import {
  buildAgentCatalogRuntime,
  buildCustomAgentRuntime,
  getAgentCatalogImages,
} from "./agent-catalog-images";
import {
  resolveAgentRuntimeTemplate,
  withLockedAgentRuntimeSettings,
} from "./agent-runtime-lock";

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
});

describe("withLockedAgentRuntimeSettings", () => {
  it("keeps the agent's own Claude account when the runtime sets none", () => {
    const agent = buildAgentCatalogRuntime({ id: "claude-code", image: "a:0" });
    const template = buildCustomAgentRuntime({ image: "a:0" });
    const locked = withLockedAgentRuntimeSettings({ runtime: agent, template });
    expect(locked.claudeCode).toEqual(agent.claudeCode);
  });

  it("takes the locked settings and keeps the agent's own image, values and model", () => {
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
    const locked = withLockedAgentRuntimeSettings({ runtime: agent, template });
    expect(locked).toMatchObject({
      image: "a:0",
      environment: agent.environment,
      ports: [3000],
      ttlHours: 8,
      maxTier: "large",
      claudeCode: {
        authentication: "provider",
        model: agent.claudeCode?.model,
      },
    });
  });
});
