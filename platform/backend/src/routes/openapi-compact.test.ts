import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance, registerSwaggerPlugin } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

type CompactDoc = {
  openapi?: unknown;
  paths?: Record<string, Record<string, { responses?: unknown }>>;
};

// Swagger must be registered before the routes it should capture. We register
// `limits` (a real /api/* route that carries responses) alongside the compact
// route so the projection has something to strip, then assert the live endpoint
// returns the request-focused view — proving the route is wired, auth-mapped
// (operationId resolves, so it isn't denied-by-default), and that the loose
// `z.record` response schema serializes the nested doc without flattening it.
describe("GET /api/openapi-compact", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async ({ makeOrganization, makeAdmin }) => {
    const organization = await makeOrganization();
    const user = await makeAdmin();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organization.id;
      (request as typeof request & { user: User }).user = user;
    });

    await registerSwaggerPlugin(app);
    const { default: limitsRoutes } = await import("./limits");
    const { default: openapiCompactRoutes } = await import("./openapi-compact");
    await app.register(limitsRoutes);
    await app.register(openapiCompactRoutes);
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("returns a request-focused projection with responses dropped", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/openapi-compact",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as CompactDoc;
    expect(body.openapi).toBeDefined();

    const limits = body.paths?.["/api/limits"];
    expect(limits).toBeDefined();
    for (const op of Object.values(limits ?? {})) {
      expect(op.responses).toBeUndefined();
    }
  });

  test("narrows to one route group via ?path", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/openapi-compact?path=/api/limits",
    });

    expect(response.statusCode).toBe(200);
    const paths = Object.keys((response.json() as CompactDoc).paths ?? {});
    expect(paths).toContain("/api/limits");
    expect(paths).not.toContain("/api/openapi-compact");
  });
});
