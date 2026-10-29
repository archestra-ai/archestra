import { describe, expect, test } from "vitest";
import { getMcpImagePullPolicy } from "./image-pull-policy";

describe("getMcpImagePullPolicy", () => {
  describe("pinned registry images", () => {
    const pinnedImages = [
      "ghcr.io/my-org/custom-mcp-server:v2.1.0",
      "docker.io/library/node:22-alpine",
      "registry.example.com:5000/team/server@sha256:abc123",
      "library/redis:7",
    ];

    // A node-cached copy is what lets a pod start while the registry is
    // unreachable, so the steady state must accept it.
    test.each(pinnedImages)("%s defaults to IfNotPresent", (image) => {
      expect(getMcpImagePullPolicy(image)).toBe("IfNotPresent");
      expect(getMcpImagePullPolicy(image, { forceFreshPull: false })).toBe(
        "IfNotPresent",
      );
    });

    test.each(pinnedImages)("%s pulls fresh on a refresh", (image) => {
      expect(getMcpImagePullPolicy(image, { forceFreshPull: true })).toBe(
        "Always",
      );
    });
  });

  describe("mutable registry images", () => {
    const mutableImages = [
      "mcp-base.internal:latest",
      "ghcr.io/my-org/custom-mcp-server:latest",
      "ghcr.io/my-org/custom-mcp-server",
      "registry.example.com:5000/team/server",
      "mcp/grafana",
    ];

    // The tag moves, so a node-cached copy may be stale: every rollout must
    // ask the registry what the tag points at now.
    test.each(mutableImages)("%s defaults to Always", (image) => {
      expect(getMcpImagePullPolicy(image)).toBe("Always");
    });
  });

  describe("bare local image names", () => {
    const localImages = [
      "my-docker-image:latest",
      "archestra-mcp-base",
      "test:latest",
    ];

    // A dev-cluster image that only exists on the node has no registry to
    // pull from, so neither the steady state nor a refresh may ask for one.
    test.each(localImages)("%s stays Never in the steady state", (image) => {
      expect(getMcpImagePullPolicy(image)).toBe("Never");
    });

    test.each(localImages)("%s stays Never under a refresh", (image) => {
      expect(getMcpImagePullPolicy(image, { forceFreshPull: true })).toBe(
        "Never",
      );
    });
  });

  describe("policy pinned on the catalog", () => {
    test("overrides the image-derived default", () => {
      expect(
        getMcpImagePullPolicy("ghcr.io/my-org/server:latest", {
          configured: "IfNotPresent",
        }),
      ).toBe("IfNotPresent");
      expect(
        getMcpImagePullPolicy("ghcr.io/my-org/server:v1", {
          configured: "Always",
        }),
      ).toBe("Always");
      expect(
        getMcpImagePullPolicy("redis", { configured: "IfNotPresent" }),
      ).toBe("IfNotPresent");
    });

    test("a refresh still pulls fresh unless the policy is Never", () => {
      expect(
        getMcpImagePullPolicy("ghcr.io/my-org/server:v1", {
          configured: "IfNotPresent",
          forceFreshPull: true,
        }),
      ).toBe("Always");
      expect(
        getMcpImagePullPolicy("ghcr.io/my-org/server:v1", {
          configured: "Never",
          forceFreshPull: true,
        }),
      ).toBe("Never");
    });
  });
});
