import { expect, test } from "./api-fixtures";

const NONEXISTENT_MESSAGE_ID = "1d6934ea-eb0d-452d-abf3-72122d140c49";

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
