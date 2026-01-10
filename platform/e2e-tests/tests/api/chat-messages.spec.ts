import { expect, test } from "./fixtures";

// Valid v4 UUIDs for testing (these won't exist in the database)
const NONEXISTENT_MESSAGE_ID = "1d6934ea-eb0d-452d-abf3-72122d140c49";

test.describe("PATCH /api/chat/messages/:id - API Validation", () => {
  test("returns 404 for non-existent message", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {
        partIndex: 0,
        text: "Updated text",
      },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });

  test("validates minimum text length", async ({ request, makeApiRequest }) => {
    // Use a valid v4 UUID - validation happens before checking if message exists
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {
        partIndex: 0,
        text: "",
      },
      ignoreStatusCheck: true,
    });

    // Zod validation errors return 500 in Fastify (not 400)
    // because they're thrown as regular Error objects before the handler runs
    expect(response.status()).toBe(500);
  });

  test("validates partIndex is a number", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {
        partIndex: "not-a-number" as unknown as number,
        text: "Updated text",
      },
      ignoreStatusCheck: true,
    });

    // Zod validation errors return 500 in Fastify
    expect(response.status()).toBe(500);
  });

  test("validates partIndex is non-negative", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {
        partIndex: -1,
        text: "Updated text",
      },
      ignoreStatusCheck: true,
    });

    // Zod validation errors return 500 in Fastify
    expect(response.status()).toBe(500);
  });

  test("validates request body schema", async ({ request, makeApiRequest }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {},
      ignoreStatusCheck: true,
    });

    // Zod validation errors return 500 in Fastify
    expect(response.status()).toBe(500);
  });

  test("validates UUID format in path parameter", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/chat/messages/invalid-uuid",
      data: {
        partIndex: 0,
        text: "Updated text",
      },
      ignoreStatusCheck: true,
    });

    // Invalid UUID format in path returns 500 (Zod validation error)
    expect(response.status()).toBe(500);
  });
});

test.describe("Chat Messages Access Control", () => {
  test("requires authentication", async ({ playwright }) => {
    // Create a fresh request context explicitly without any auth storage state
    // Note: We must explicitly set storageState to undefined to avoid inheriting
    // the project's default storageState (adminAuthFile)
    const unauthenticatedContext = await playwright.request.newContext({
      baseURL: "http://localhost:9000",
      storageState: undefined,
    });

    try {
      const response = await unauthenticatedContext.patch(
        `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
        {
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3000",
          },
          data: {
            partIndex: 0,
            text: "Updated text",
          },
        },
      );

      expect([401, 403]).toContain(response.status());
    } finally {
      await unauthenticatedContext.dispose();
    }
  });
});
