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

type Operation = { responses?: unknown; requestBody?: unknown };
type CompactDoc = {
  openapi?: unknown;
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
};

/** Collect every `#/components/schemas/<name>` reference in a serialized doc. */
function refNames(node: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) refNames(n, acc);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") {
        const m = v.match(/^#\/components\/schemas\/(.+)$/);
        if (m) acc.add(m[1]);
      } else {
        refNames(v, acc);
      }
    }
  }
  return acc;
}

// Swagger must be registered before the routes it should capture. We register
// `limits` (a real /api/* route with a request body and responses) alongside the
// compact route, then hit the live endpoint and assert the projection survives
// the HTTP boundary: the loose `z.record` response schema must serialize the
// nested doc without flattening it. Auth/denial is intentionally NOT exercised
// here — this app stubs `request.user` via onRequest and does not register the
// Authnz plugin; the `{}` permission mapping and deny-by-default behavior are
// covered by shared/access-control.test.ts and the middleware tests.
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

    // The request shape (a deeply nested object) must round-trip through the
    // loose `z.record` response serializer intact — that is the whole contract.
    expect(limits?.post?.requestBody).toBeDefined();

    // Self-containedness: any schema $ref the projection keeps must resolve
    // within components.schemas. Vacuously true when everything is inlined
    // (fastify inlines most request schemas), but catches a serializer that
    // dropped components while leaving dangling refs behind.
    const componentNames = new Set(Object.keys(body.components?.schemas ?? {}));
    for (const name of refNames(body.paths)) {
      expect(componentNames.has(name)).toBe(true);
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
