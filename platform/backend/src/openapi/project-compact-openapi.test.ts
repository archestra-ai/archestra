// biome-ignore-all lint/suspicious/noExplicitAny: test
import { describe, expect, test } from "vitest";
import {
  type OpenApiDoc,
  projectCompactOpenApi,
} from "./project-compact-openapi";

function sampleDoc(): OpenApiDoc {
  return {
    openapi: "3.1.0",
    info: { title: "Test", version: "1.0.0" },
    paths: {
      "/api/agents": {
        post: {
          operationId: "CreateAgent",
          summary: "Create an agent",
          description: "A long description that should be dropped.",
          parameters: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/InsertAgent" },
              },
            },
          },
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HeavyResponse" },
                },
              },
            },
          },
          "x-required-permissions": { kind: "dynamic", permissions: [] },
        },
      },
      "/api/limits": {
        get: {
          operationId: "ListLimits",
          parameters: [{ name: "scope", in: "query", required: true }],
          responses: { "200": { description: "ok" } },
          "x-required-permissions": {
            kind: "static",
            permissions: ["llmLimit:read"],
          },
        },
      },
      "/v1/openai/chat": {
        post: { operationId: "ProxyChat", responses: {} },
      },
    },
    components: {
      schemas: {
        InsertAgent: {
          type: "object",
          required: ["name", "agentType"],
          properties: {
            name: { type: "string" },
            agentType: { type: "string", enum: ["agent", "llm_proxy"] },
            labels: { $ref: "#/components/schemas/Label" },
          },
        },
        Label: { type: "object", properties: { key: { type: "string" } } },
        HeavyResponse: { type: "object", description: "huge inlined response" },
      },
    },
  };
}

describe("projectCompactOpenApi", () => {
  test("keeps request fields and drops responses/descriptions", () => {
    const compact = projectCompactOpenApi(sampleDoc());
    const post = (compact.paths?.["/api/agents"] as Record<string, any>).post;
    expect(post.operationId).toBe("CreateAgent");
    expect(post.summary).toBe("Create an agent");
    expect(post.requestBody).toBeDefined();
    expect(post.parameters).toBeDefined();
    expect(post.responses).toBeUndefined();
    expect(post.description).toBeUndefined();
  });

  test("preserves x-required-permissions for RBAC guidance", () => {
    const compact = projectCompactOpenApi(sampleDoc());
    const get = (compact.paths?.["/api/limits"] as Record<string, any>).get;
    expect(get["x-required-permissions"]).toEqual({
      kind: "static",
      permissions: ["llmLimit:read"],
    });
  });

  test("includes referenced schemas transitively and required/enum metadata", () => {
    const compact = projectCompactOpenApi(sampleDoc());
    const schemas = compact.components?.schemas ?? {};
    expect(Object.keys(schemas).sort()).toEqual(["InsertAgent", "Label"]);
    const insert = schemas.InsertAgent as Record<string, any>;
    expect(insert.required).toEqual(["name", "agentType"]);
    expect(insert.properties.agentType.enum).toEqual(["agent", "llm_proxy"]);
  });

  test("excludes schemas only reachable through dropped responses", () => {
    const compact = projectCompactOpenApi(sampleDoc());
    expect(compact.components?.schemas?.HeavyResponse).toBeUndefined();
  });

  test("excludes non-/api paths (auth-skipping proxies)", () => {
    const compact = projectCompactOpenApi(sampleDoc());
    expect(compact.paths?.["/v1/openai/chat"]).toBeUndefined();
  });

  test("pathPrefix filters to one route group", () => {
    const compact = projectCompactOpenApi(sampleDoc(), {
      pathPrefix: "/api/agents",
    });
    expect(Object.keys(compact.paths ?? {})).toEqual(["/api/agents"]);
  });

  test("ignores a pathPrefix outside the admin surface", () => {
    const compact = projectCompactOpenApi(sampleDoc(), { pathPrefix: "/v1" });
    // Falls back to the full /api surface rather than leaking /v1 routes.
    expect(Object.keys(compact.paths ?? {}).sort()).toEqual([
      "/api/agents",
      "/api/limits",
    ]);
  });

  test("omits an empty components block when nothing is referenced", () => {
    const compact = projectCompactOpenApi(sampleDoc(), {
      pathPrefix: "/api/limits",
    });
    expect(compact.components).toBeUndefined();
  });
});
