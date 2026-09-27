import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createCachedOpenApiRouteHandler } from "./cached-openapi-route";

const createApp = (
  buildDocument: () => unknown,
  getCacheKey: () => string = () => "default",
) => {
  const app = Fastify();
  app.get(
    "/openapi.json",
    createCachedOpenApiRouteHandler({ buildDocument, getCacheKey }),
  );
  return app;
};

describe("createCachedOpenApiRouteHandler", () => {
  it("serializes the document once and reuses the response", async () => {
    const buildDocument = vi.fn(() => ({ openapi: "3.1.0" }));
    const app = createApp(buildDocument);

    const first = await app.inject("/openapi.json");
    const second = await app.inject("/openapi.json");

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ openapi: "3.1.0" });
    expect(second.body).toBe(first.body);
    expect(buildDocument).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("adds shared-cache headers and a strong ETag", async () => {
    const app = createApp(() => ({ openapi: "3.1.0" }));

    const response = await app.inject("/openapi.json");

    expect(response.headers["cache-control"]).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(response.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it.each([
    "strong",
    "weak",
    "wildcard",
  ])("returns 304 for a matching %s validator", async (validator) => {
    const app = createApp(() => ({ openapi: "3.1.0" }));
    const first = await app.inject("/openapi.json");
    const etag = first.headers.etag as string;
    const ifNoneMatch =
      validator === "strong" ? etag : validator === "weak" ? `W/${etag}` : "*";

    const response = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "if-none-match": ifNoneMatch },
    });

    expect(response.statusCode).toBe(304);
    expect(response.body).toBe("");
    await app.close();
  });

  it("rebuilds when the branding cache key changes", async () => {
    let key = "Archestra:false";
    const buildDocument = vi.fn(() => ({ key }));
    const app = createApp(buildDocument, () => key);

    const first = await app.inject("/openapi.json");
    key = "Example:true";
    const second = await app.inject("/openapi.json");

    expect(first.json()).toEqual({ key: "Archestra:false" });
    expect(second.json()).toEqual({ key: "Example:true" });
    expect(buildDocument).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
