import { RouteId } from "@shared";
import { describe, expect, it } from "vitest";
import { enrichOpenApiWithRbac } from "./enrich-openapi-with-rbac";

describe("enrichOpenApiWithRbac", () => {
  it("adds permission metadata and markdown for routes with static RBAC requirements", () => {
    const spec = {
      paths: {
        "/api/tools": {
          get: {
            operationId: RouteId.GetTools,
            description: "List tools",
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const getOperation = enriched.paths["/api/tools"].get as {
      description?: string;
      "x-required-permissions"?: { allOf: string[] };
    };

    expect(getOperation["x-required-permissions"]).toEqual({
      allOf: ["toolPolicy:read"],
    });
    expect(getOperation.description).toContain("Required RBAC permissions:");
    expect(getOperation.description).toContain(
      "`toolPolicy:read`: View tools, tool invocation policies, and trusted data policies",
    );
  });

  it("leaves routes alone when permissions are dynamic or unspecified", () => {
    const spec = {
      paths: {
        "/api/agents": {
          post: {
            operationId: RouteId.CreateAgent,
            description: "Create agent",
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const postOperation = enriched.paths["/api/agents"].post as {
      description?: string;
      "x-required-permissions"?: { allOf: string[] };
    };

    expect(postOperation["x-required-permissions"]).toBe(undefined);
    expect(postOperation.description).toBe("Create agent");
  });
});
