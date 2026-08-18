import { describe, expect, test } from "@/test";
import { getMcpImagePullPolicy } from "./image-pull-policy";

describe("getMcpImagePullPolicy", () => {
  describe("registry-backed images", () => {
    const registryImages = [
      "ghcr.io/my-org/custom-mcp-server:v2.1.0",
      "docker.io/library/node:22-alpine",
      "registry.example.com:5000/team/server@sha256:abc123",
      "library/redis:7",
      "mcp-base.internal:latest",
    ];

    // A node-cached copy is what lets a pod start while the registry is
    // unreachable, so the steady state must accept it.
    test.each(registryImages)("%s defaults to IfNotPresent", (image) => {
      expect(getMcpImagePullPolicy(image)).toBe("IfNotPresent");
      expect(getMcpImagePullPolicy(image, {})).toBe("IfNotPresent");
      expect(getMcpImagePullPolicy(image, { forceFreshPull: false })).toBe(
        "IfNotPresent",
      );
    });

    // Freshness is the refresh-image flow's job, not the steady state's.
    test.each(registryImages)("%s pulls fresh only on request", (image) => {
      expect(getMcpImagePullPolicy(image, { forceFreshPull: true })).toBe(
        "Always",
      );
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
});
