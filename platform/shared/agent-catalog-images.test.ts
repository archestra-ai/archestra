import { describe, expect, test } from "vitest";
import {
  getAgentCatalogImages,
  getDefaultAgentRuntimeImage,
} from "./agent-catalog-images";

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
