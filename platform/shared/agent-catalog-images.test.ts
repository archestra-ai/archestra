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
    expect(
      resolveAgentCatalogId({
        image: "ghcr.io/example/my-codex:latest",
        command: ["archestra-codex"],
      }),
    ).toBe("codex");
  });

  test("answers null for a custom runtime, the platform loop, and anything that is not a runtime", () => {
    expect(
      resolveAgentCatalogId({
        image: "ghcr.io/example/toolbox:latest",
        command: ["python", "loop.py"],
      }),
    ).toBeNull();
    expect(
      resolveAgentCatalogId({
        image: getDefaultAgentRuntimeImage("1.4.0"),
        command: null,
      }),
    ).toBeNull();
    expect(resolveAgentCatalogId(null)).toBeNull();
    expect(resolveAgentCatalogId("archestra-claude-code")).toBeNull();
  });
});

describe("popular Agent images", () => {
  test("uses the stable release alias for maintained clients while keeping the built-in image pinned", () => {
    const baseImage = getDefaultAgentRuntimeImage("1.3.65");
    const images = getAgentCatalogImages(baseImage);
    expect(images.archestra).toBe(baseImage);
    expect(images).toEqual({
      archestra: baseImage,
      "claude-code": getDefaultAgentRuntimeImage("latest").replace(
        "agent-archestra",
        "agent-claude-code",
      ),
      codex: getDefaultAgentRuntimeImage("latest").replace(
        "agent-archestra",
        "agent-codex",
      ),
      opencode: getDefaultAgentRuntimeImage("latest").replace(
        "agent-archestra",
        "agent-opencode",
      ),
      hermes: getDefaultAgentRuntimeImage("latest").replace(
        "agent-archestra",
        "agent-hermes",
      ),
      openclaw: getDefaultAgentRuntimeImage("latest").replace(
        "agent-archestra",
        "agent-openclaw",
      ),
    });
  });

  test.each([
    "1.4.0-rc.17",
    "0123456789abcdef0123456789abcdef01234567",
  ])("keeps prerelease and commit images together at %s", (tag) => {
    const images = getAgentCatalogImages(getDefaultAgentRuntimeImage(tag));
    expect(images["claude-code"]).toBe(
      getDefaultAgentRuntimeImage(tag).replace(
        "agent-archestra",
        "agent-claude-code",
      ),
    );
    expect(
      Object.values(images).every((image) => image.endsWith(`:${tag}`)),
    ).toBe(true);
  });

  test("preserves explicit custom registry ports, namespaces and tags", () => {
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
