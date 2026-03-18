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
      "x-required-permissions"?: {
        kind: "dynamic" | "none" | "static";
        note?: string;
        permissions: string[];
      };
    };

    expect(getOperation["x-required-permissions"]).toEqual({
      kind: "static",
      permissions: ["toolPolicy:read"],
    });
    expect(getOperation.description).toContain("Authentication:");
    expect(getOperation.description).toContain("Required RBAC permissions:");
    expect(getOperation.description).toContain(
      "`toolPolicy:read`: View tools, tool invocation policies, and trusted data policies",
    );
  });

  it("documents auth-only routes as requiring no additional RBAC permission", () => {
    const spec = {
      paths: {
        "/api/agents": {
          get: {
            operationId: RouteId.GetAgentEmailAddress,
            description: "Get agent email address",
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const getOperation = enriched.paths["/api/agents"].get as {
      description?: string;
      "x-required-permissions"?: {
        kind: "dynamic" | "none" | "static";
        note?: string;
        permissions: string[];
      };
    };

    expect(getOperation["x-required-permissions"]).toEqual({
      kind: "none",
      note: "None (no additional RBAC permission required)",
      permissions: [],
    });
    expect(getOperation.description).toContain("Authentication:");
    expect(getOperation.description).toContain(
      "None (no additional RBAC permission required)",
    );
  });

  it("documents dynamic agent RBAC checks with an explicit note", () => {
    const spec = {
      paths: {
        "/api/agents/{id}": {
          get: {
            operationId: RouteId.GetAgent,
            description: "Get agent by ID",
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const getOperation = enriched.paths["/api/agents/{id}"].get as {
      description?: string;
      "x-required-permissions"?: {
        kind: "dynamic" | "none" | "static";
        note?: string;
        permissions: string[];
      };
    };

    expect(getOperation["x-required-permissions"]).toEqual({
      kind: "dynamic",
      note: expect.stringContaining(
        "Checked dynamically based on the target agent's type",
      ),
      permissions: [],
    });
    expect(getOperation.description).toContain("Required RBAC permissions:");
    expect(getOperation.description).toContain("mcpGateway:read");
  });

  it("leaves non-api routes alone", () => {
    const spec = {
      paths: {
        "/v1/a2a/{agentId}": {
          post: {
            operationId: "sendA2aMessage",
            description: "Send A2A message",
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const postOperation = enriched.paths["/v1/a2a/{agentId}"].post as {
      description?: string;
      "x-required-permissions"?: {
        kind: "dynamic" | "none" | "static";
        note?: string;
        permissions: string[];
      };
    };

    expect(postOperation["x-required-permissions"]).toBe(undefined);
    expect(postOperation.description).toBe("Send A2A message");
  });
});
