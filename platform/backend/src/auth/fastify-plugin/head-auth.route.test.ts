import { afterEach, describe, expect, test, vi } from "vitest";
import { createFastifyInstance } from "@/fastify-instance";
import { authPlugin } from "./plugin";

describe("HEAD route authentication", () => {
  const app = createFastifyInstance();

  afterEach(async () => {
    await app.close();
  });

  test("rejects an unauthenticated HEAD request before a protected GET handler runs", async () => {
    const handler = vi.fn(async () => ({ privateData: true }));
    await app.register(authPlugin);
    app.get("/api/protected-head-check", handler);

    const response = await app.inject({
      method: "HEAD",
      url: "/api/protected-head-check",
    });

    expect(response.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
