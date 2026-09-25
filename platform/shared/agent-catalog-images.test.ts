import { describe, expect, test } from "vitest";
import {
  AGENT_CATALOG_IMAGE_REGISTRY,
  getAgentCatalogImages,
  getAgentCatalogImageTag,
  resolveAgentCatalogId,
} from "./agent-catalog-images";

describe("resolveAgentCatalogId", () => {
  test("names a maintained CLI template by the wrapper command it runs", () => {
    expect(
      resolveAgentCatalogId({
        image: "registry.example/team/agent-claude-code:v2",
        command: ["archestra-claude-code", "--permission-mode", "bypass"],
      }),
    ).toBe("claude-code");
    expect(
      resolveAgentCatalogId({
        image: "ghcr.io/example/my-codex:latest",
        command: ["archestra-codex"],
      }),
    ).toBe("codex");
  });

  test("answers null for a custom runtime and anything that is not a runtime", () => {
    expect(
      resolveAgentCatalogId({
        image: "ghcr.io/example/toolbox:latest",
        command: ["python", "loop.py"],
      }),
    ).toBeNull();
    expect(
      resolveAgentCatalogId({
        image: "ghcr.io/example/toolbox:latest",
        command: null,
      }),
    ).toBeNull();
    expect(resolveAgentCatalogId(null)).toBeNull();
    expect(resolveAgentCatalogId("archestra-claude-code")).toBeNull();
  });
});

describe("popular Agent images", () => {
  test("uses the stable alias on stable releases and matching tags otherwise", () => {
    expect(getAgentCatalogImageTag("1.3.65")).toBe("latest");
    expect(getAgentCatalogImageTag("1.4.0-rc.17")).toBe("1.4.0-rc.17");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(getAgentCatalogImageTag(commit)).toBe(commit);
  });

  test("builds every maintained image from one registry and tag", () => {
    expect(
      getAgentCatalogImages({
        registry: AGENT_CATALOG_IMAGE_REGISTRY,
        tag: "latest",
      }),
    ).toEqual({
      "claude-code": `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-claude-code:latest`,
      codex: `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-codex:latest`,
      opencode: `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-opencode:latest`,
      hermes: `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-hermes:latest`,
      openclaw: `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-openclaw:latest`,
    });
  });

  test("preserves mirror registry ports and namespaces", () => {
    const images = getAgentCatalogImages({
      registry: "registry.example:5000/team/",
      tag: "v2",
    });
    expect(images["claude-code"]).toBe(
      "registry.example:5000/team/agent-claude-code:v2",
    );
    expect(images.hermes).toBe("registry.example:5000/team/agent-hermes:v2");
  });
});
