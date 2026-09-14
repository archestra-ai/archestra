import { describe, expect, test } from "vitest";
import {
  getAgentCatalogImages,
  getDefaultAgentRuntimeImage,
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
    // The command decides, not the image: a custom image running the
    // wrapper is that wrapper's template.
    expect(
      resolveAgentCatalogId({
        image: "ghcr.io/example/my-codex:latest",
        command: ["archestra-codex"],
      }),
    ).toBe("codex");
  });

  test("names the platform's own loop by its image when no command is set", () => {
    expect(
      resolveAgentCatalogId({
        image: "registry.example:5000/team/agent-archestra:v2",
        command: null,
      }),
    ).toBe("archestra");
    expect(
      resolveAgentCatalogId({ image: getDefaultAgentRuntimeImage("1.4.0") }),
    ).toBe("archestra");
  });

  test("answers null for a custom runtime and for anything that is not one", () => {
    expect(
      resolveAgentCatalogId({
        image: "ghcr.io/example/toolbox:latest",
        command: null,
      }),
    ).toBeNull();
    expect(
      resolveAgentCatalogId({
        image: "registry.example/team/agent-archestra:v2",
        command: ["python", "loop.py"],
      }),
    ).toBeNull();
    expect(
      resolveAgentCatalogId({
        image: "registry.example/team/agent-archestra-fork:v2",
        command: null,
      }),
    ).toBeNull();
    expect(resolveAgentCatalogId(null)).toBeNull();
    expect(resolveAgentCatalogId("archestra-claude-code")).toBeNull();
  });
});

describe("popular Agent images", () => {
  test("preserves registry ports, namespaces and the release tag across the catalog", () => {
    const images = getAgentCatalogImages(
      "registry.example:5000/team/agent-archestra:v2",
    );
    expect(images["claude-code"]).toBe(
      "registry.example:5000/team/agent-claude-code:v2",
    );
    expect(images.hermes).toBe("registry.example:5000/team/agent-hermes:v2");
    expect(
      Object.values(images).every(
        (image) =>
          image.startsWith("registry.example:5000/team/") &&
          image.endsWith(":v2"),
      ),
    ).toBe(true);
  });
  test("preserves an unrelated custom base image and uses maintained native images", () => {
    const images = getAgentCatalogImages(
      "registry.example/team/custom:agent-archestra-v2",
    );
    expect(images.archestra).toBe(
      "registry.example/team/custom:agent-archestra-v2",
    );
    expect(images.codex).toBe(
      getDefaultAgentRuntimeImage("latest").replace(
        "agent-archestra",
        "agent-codex",
      ),
    );
    expect(getAgentCatalogImages("agent-archestra:dev")["claude-code"]).toBe(
      "agent-claude-code:dev",
    );
  });
});
