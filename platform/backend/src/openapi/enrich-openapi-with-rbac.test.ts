import { RouteId } from "@shared";
import { describe, expect, it } from "vitest";
import { enrichOpenApiWithRbac } from "./enrich-openapi-with-rbac";

describe("enrichOpenApiWithRbac", () => {
  it("adds permission metadata plus authentication and RBAC guidance for routes with static requirements", () => {
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
    expect(getOperation.description).toContain("Authentication:\n\n");
    expect(getOperation.description).toContain(
      "Required. Use an authenticated browser session or send your Archestra API key in the `Authorization` header.",
    );
    expect(getOperation.description).toContain("\n\nAuthorization:\n\n");
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
    expect(getOperation.description).toContain("Authentication:\n\n");
    expect(getOperation.description).toContain(
      "Required. Use an authenticated browser session or send your Archestra API key in the `Authorization` header.",
    );
    expect(getOperation.description).toContain("\n\nAuthorization:\n\n");
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
    expect(getOperation.description).toContain("Authentication:\n\n");
    expect(getOperation.description).toContain(
      "Required. Use an authenticated browser session or send your Archestra API key in the `Authorization` header.",
    );
    expect(getOperation.description).toContain("\n\nAuthorization:\n\n");
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

  it("adds the LLM Proxy key-type note", () => {
    const spec = {
      paths: {
        "/v1/openai/chat/completions": {
          post: {
            description: "OpenAI-compatible chat completions",
            tags: ["LLM Proxy", "OAuth", "Auth"],
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const postOperation = enriched.paths["/v1/openai/chat/completions"]
      .post as {
      description?: string;
      tags?: string[];
    };

    expect(postOperation.tags).toEqual(["LLM Proxy", "OAuth", "Auth"]);
    expect(postOperation.description).toContain(
      "This route accepts either an LLM provider API key or a Virtual API Key.",
    );
    expect(postOperation.description).toContain(
      "[LLM Proxy Authentication](/docs/platform-llm-proxy-authentication)",
    );
  });
});
