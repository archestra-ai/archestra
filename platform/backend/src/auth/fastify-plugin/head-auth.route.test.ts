import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFastifyInstance } from "@/fastify-instance";
import { authPlugin } from "./plugin";

describe("protected route authentication", () => {
  let app: ReturnType<typeof createFastifyInstance>;

  beforeEach(() => {
    app = createFastifyInstance();
  });

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

  test("rejects an unauthenticated chat message PATCH before its handler runs", async () => {
    const handler = vi.fn(async () => ({ updated: true }));
    await app.register(authPlugin);
    app.patch("/api/chat/messages/:id", handler);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/chat/messages/1d6934ea-eb0d-452d-abf3-72122d140c49",
      payload: {
        conversationId: "9c1f74a3-19f6-4f81-9c07-371f7a1f8f6e",
        partIndex: 0,
        text: "Updated text",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
