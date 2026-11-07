import { describe, expect, test } from "vitest";
import {
  AGENT_CATALOG_IMAGE_REGISTRY,
  followAgentCatalogImage,
  getAgentCatalogImages,
  pinReleaseImage,
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

describe("pinReleaseImage", () => {
  const digests = {
    version: "1.5.0",
    images: { "agent-codex": `sha256:${"b".repeat(64)}` },
  };

  test("pins a release image of the shipped version to its digest", () => {
    expect(
      pinReleaseImage({
        image: `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-codex:1.5.0`,
        digests,
      }),
    ).toBe(
      `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-codex:1.5.0@sha256:${"b".repeat(64)}`,
    );
  });

  test("leaves mirrors, other tags, unknown images and builds without digests on their tag", () => {
    for (const image of [
      "registry.example:5000/team/agent-codex:1.5.0",
      `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-codex:1.5.1`,
      `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-hermes:1.5.0`,
      `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-codex:1.5.0@sha256:${"c".repeat(64)}`,
    ]) {
      expect(pinReleaseImage({ image, digests })).toBe(image);
    }
    const image = `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-codex:1.5.0`;
    expect(pinReleaseImage({ image, digests: null })).toBe(image);
  });
});

describe("followAgentCatalogImage", () => {
  test("moves a release digest pin to this release's pin", () => {
    const current = getAgentCatalogImages({
      registry: AGENT_CATALOG_IMAGE_REGISTRY,
      tag: "1.5.1",
    });
    const pinnedCurrent = {
      ...current,
      codex: `${current.codex}@sha256:${"d".repeat(64)}`,
    };
    const saved = `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-codex:1.5.0@sha256:${"b".repeat(64)}`;
    expect(
      followAgentCatalogImage({ image: saved, catalogImages: pinnedCurrent }),
    ).toBe(pinnedCurrent.codex);
    // A development build ships no digests: the pin moves to the tag.
    expect(
      followAgentCatalogImage({ image: saved, catalogImages: current }),
    ).toBe(current.codex);
  });

  test("moves maintained legacy registry tags to this release while preserving digest pins", () => {
    const legacy =
      "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-codex";
    const catalogImages = getAgentCatalogImages({
      registry: AGENT_CATALOG_IMAGE_REGISTRY,
      tag: "1.5.0-rc.12",
    });
    expect(
      followAgentCatalogImage({ image: `${legacy}:1.4.0`, catalogImages }),
    ).toBe("ghcr.io/archestra-ai/agent-codex:1.5.0-rc.12");
    const pinned = `${legacy}@sha256:${"a".repeat(64)}`;
    expect(followAgentCatalogImage({ image: pinned, catalogImages })).toBe(
      pinned,
    );
  });
  const catalogImages = getAgentCatalogImages({
    registry: AGENT_CATALOG_IMAGE_REGISTRY,
    tag: "1.4.0-rc.37",
  });

  test("moves a maintained image saved on an older release to the current tag", () => {
    expect(
      followAgentCatalogImage({
        image: `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-claude-code:1.4.0-rc.31`,
        catalogImages,
      }),
    ).toBe(`${AGENT_CATALOG_IMAGE_REGISTRY}/agent-claude-code:1.4.0-rc.37`);
    expect(
      followAgentCatalogImage({
        image: `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-codex`,
        catalogImages,
      }),
    ).toBe(`${AGENT_CATALOG_IMAGE_REGISTRY}/agent-codex:1.4.0-rc.37`);
  });

  test("follows an operator's mirror, including from the public registry", () => {
    const mirrored = getAgentCatalogImages({
      registry: "registry.example:5000/team",
      tag: "pinned",
    });
    for (const image of [
      "registry.example:5000/team/agent-hermes:1.4.0-rc.20",
      `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-hermes:1.4.0-rc.20`,
    ]) {
      expect(followAgentCatalogImage({ image, catalogImages: mirrored })).toBe(
        "registry.example:5000/team/agent-hermes:pinned",
      );
    }
  });

  test("launches digest pins and the author's own images as saved", () => {
    for (const image of [
      `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-claude-code@sha256:${"a".repeat(64)}`,
      "registry.example/team/agent-claude-code:v2",
      "registry.example:5000/agent-claude-code",
      `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-claude-code-extended:1.4.0-rc.31`,
      "ghcr.io/example/toolbox:latest",
    ]) {
      expect(followAgentCatalogImage({ image, catalogImages })).toBe(image);
    }
  });
});
