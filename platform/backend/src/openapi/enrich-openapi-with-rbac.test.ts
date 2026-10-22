import { RouteId } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { enrichOpenApiWithRbac } from "./enrich-openapi-with-rbac";

describe("enrichOpenApiWithRbac", () => {
  it.each([
    RouteId.ModelRouterImagesWithDefaultAgent,
    RouteId.ModelRouterImageEditsWithAgent,
    RouteId.ModelRouterAudioTranscriptionsWithAgent,
  ])("documents mapped Bearer credentials for %s", (operationId) => {
    const spec = {
      paths: {
        "/v1/model-router/media": {
          post: { operationId, tags: ["LLM Proxy"] },
        },
      },
    };
    const operation = enrichOpenApiWithRbac(spec).paths[
      "/v1/model-router/media"
    ].post as { description?: string };
    expect(operation.description).toContain(
      "mapped standard Virtual API Key or LLM OAuth access token",
    );
    expect(operation.description).toContain(
      "Provider API keys, passthrough keys, and external identity-provider JWTs are not accepted",
    );
    expect(operation.description).not.toContain(
      "either an LLM provider API key",
    );
  });

  it.each([
    RouteId.AzureCreateFile,
    RouteId.AzureFileContentWithAgent,
    RouteId.AzureDeleteFile,
  ])("documents %s as requiring a principal and a configured account", (operationId) => {
    const spec = {
      paths: {
        "/v1/azure/files": { post: { operationId, tags: ["LLM Proxy"] } },
      },
    };
    const operation = enrichOpenApiWithRbac(spec).paths["/v1/azure/files"]
      .post as { description?: string };
    expect(operation.description).toContain("authenticated platform principal");
    expect(operation.description).toContain(
      "provider key alone is insufficient",
    );
    expect(operation.description).not.toContain(
      "either an LLM provider API key",
    );
  });
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
      permissions: ["mcpRegistry:read"],
    });
    expect(getOperation.description).toContain("Authentication:\n\n");
    expect(getOperation.description).toContain(
      "Required. Use an authenticated browser session or send your Archestra API key in the `Authorization` header.",
    );
    expect(getOperation.description).toContain("\n\nAuthorization:\n\n");
    expect(getOperation.description).toContain(
      "`mcpRegistry:read`: Open the MCP registry and use its built-in servers",
    );
  });

  it.each([
    RouteId.GetAgentOptions,
    RouteId.GetChatAgentRoster,
  ])("documents %s as dynamically authorized", (operationId) => {
    const spec = { paths: { "/api/agents/roster": { get: { operationId } } } };
    const operation = enrichOpenApiWithRbac(spec).paths["/api/agents/roster"]
      .get as {
      description?: string;
      "x-required-permissions"?: { kind: string; note: string };
    };
    expect(operation["x-required-permissions"]).toMatchObject({
      kind: "dynamic",
      note: expect.stringContaining("agent:read"),
    });
    expect(operation.description).not.toContain(
      "None (no additional RBAC permission required)",
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

  it("documents that a credential just for the caller needs no permission", () => {
    const spec = {
      paths: {
        "/api/credentials": {
          post: {
            operationId: RouteId.CreateRuntimeCredential,
            description: "Create a credential definition",
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const createOperation = enriched.paths["/api/credentials"].post as {
      "x-required-permissions"?: {
        kind: "dynamic" | "none" | "static";
        note?: string;
        permissions: string[];
      };
    };

    expect(createOperation["x-required-permissions"]).toEqual({
      kind: "dynamic",
      note: expect.stringContaining("require `credential:create`"),
      permissions: [],
    });
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
        "/api/agents/{id}/pin": {
          put: {
            operationId: RouteId.PinAgent,
            description: "Pin agent",
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

    const pinOperation = enriched.paths["/api/agents/{id}/pin"].put as {
      description?: string;
      "x-required-permissions"?: {
        kind: "dynamic" | "none" | "static";
        note?: string;
        permissions: string[];
      };
    };
    expect(pinOperation["x-required-permissions"]).toEqual({
      kind: "dynamic",
      note: expect.stringContaining("caller's visibility"),
      permissions: [],
    });
    expect(pinOperation.description).toContain("`agent:read`");
  });

  it("documents row-level log scope alongside the static permission", () => {
    const spec = {
      paths: {
        "/api/interactions": {
          get: {
            operationId: RouteId.GetInteractions,
            description: "List interactions",
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const operation = enriched.paths["/api/interactions"].get as {
      description?: string;
      "x-required-permissions"?: {
        kind: "dynamic" | "none" | "static";
        note?: string;
        permissions: string[];
      };
    };

    expect(operation["x-required-permissions"]).toEqual({
      kind: "static",
      note: expect.stringContaining("`log:admin` includes"),
      permissions: ["log:read"],
    });
    expect(operation.description).toContain(
      "`log:admin` includes every row in the active organization.",
    );
  });

  it("documents the extra permission that widens per-user statistics", () => {
    const spec = {
      paths: {
        "/api/statistics/users": {
          get: {
            operationId: RouteId.GetUserStatistics,
            description: "List user statistics",
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const operation = enriched.paths["/api/statistics/users"].get as {
      description?: string;
      "x-required-permissions"?: {
        kind: "dynamic" | "none" | "static";
        note?: string;
        permissions: string[];
      };
    };

    expect(operation["x-required-permissions"]).toEqual({
      kind: "static",
      note: expect.stringContaining("`member:read` includes"),
      permissions: ["llmCost:read"],
    });
    expect(operation.description).toContain(
      "`member:read` includes identified users across the active organization.",
    );
  });

  it("documents public api routes as not requiring authentication", () => {
    const spec = {
      paths: {
        "/api/config/public": {
          get: {
            operationId: RouteId.GetPublicConfig,
            description: "Get public config",
          },
        },
      },
    };

    const enriched = enrichOpenApiWithRbac(spec);
    const getOperation = enriched.paths["/api/config/public"].get as {
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
    expect(getOperation.description).toContain("Not required.");
    expect(getOperation.description).toContain("\n\nAuthorization:\n\n");
    expect(getOperation.description).toContain(
      "None (no additional RBAC permission required)",
    );
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
      "[LLM Proxy Authentication](/docs/llm-proxy/authentication)",
    );
  });
});
