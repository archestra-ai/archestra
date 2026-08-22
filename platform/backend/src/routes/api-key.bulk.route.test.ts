import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { deleteApiKeyMock } = vi.hoisted(() => ({
  deleteApiKeyMock: vi.fn(),
}));

// Better Auth owns key deletion, so it is mocked at that boundary — the rows
// themselves are real, which is what the fence below actually tests.
vi.mock("@/auth/better-auth", () => ({
  auth: { api: { deleteApiKey: deleteApiKeyMock } },
}));

describe("DELETE /api/api-keys/bulk", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let otherUserId: string;

  beforeEach(async ({ makeUser }) => {
    vi.clearAllMocks();
    deleteApiKeyMock.mockResolvedValue({ success: true });
    user = await makeUser();
    otherUserId = (await makeUser()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
    });

    const { default: apiKeyRoutes } = await import("./api-key");
    await app.register(apiKeyRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const seedKey = async (id: string, name: string, ownerId: string) => {
    await db.insert(schema.apikeysTable).values({
      id,
      configId: "default",
      name,
      key: `hashed-${id}`,
      referenceId: ownerId,
      enabled: true,
      createdAt: new Date("2026-03-15T00:00:00.000Z"),
      updatedAt: new Date("2026-03-15T00:00:00.000Z"),
    });
  };

  const bulkDelete = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/api-keys/bulk",
      payload: { ids },
    });

  test("deletes every named key of the caller's own", async () => {
    await seedKey("bulk-key-1", "CLI Key", user.id);
    await seedKey("bulk-key-2", "Docs Key", user.id);

    const response = await bulkDelete(["bulk-key-1", "bulk-key-2"]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: "bulk-key-1", name: "CLI Key" },
        { id: "bulk-key-2", name: "Docs Key" },
      ],
      failed: [],
    });
    expect(deleteApiKeyMock).toHaveBeenCalledTimes(2);
  });

  /**
   * Keys are personal, so ownership is the whole authorization story: another
   * user's id must be indistinguishable from one that does not exist, and must
   * never reach Better Auth.
   */
  test("will not delete somebody else's key", async () => {
    await seedKey("mine", "Mine", user.id);
    await seedKey("theirs", "Theirs", otherUserId);

    const response = await bulkDelete(["mine", "theirs"]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: "mine", name: "Mine" }],
      failed: [{ id: "theirs", name: null, error: "API key not found" }],
    });
    expect(deleteApiKeyMock).toHaveBeenCalledTimes(1);
    expect(deleteApiKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: { keyId: "mine" } }),
    );
  });

  test("collapses duplicate ids into one deletion", async () => {
    await seedKey("dupe", "Dupe", user.id);

    const response = await bulkDelete(["dupe", "dupe", "dupe"]);

    expect(response.json().succeeded).toEqual([{ id: "dupe", name: "Dupe" }]);
    expect(deleteApiKeyMock).toHaveBeenCalledTimes(1);
  });

  test("reports one key's failure without abandoning the others", async () => {
    await seedKey("ok-1", "Fine", user.id);
    await seedKey("boom", "Broken", user.id);
    await seedKey("ok-2", "Also fine", user.id);
    deleteApiKeyMock.mockImplementation(
      ({ body }: { body: { keyId: string } }) => {
        if (body.keyId === "boom") throw new Error("upstream refused");
        return Promise.resolve({ success: true });
      },
    );

    const response = await bulkDelete(["ok-1", "boom", "ok-2"]);

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([
      { id: "ok-1", name: "Fine" },
      { id: "ok-2", name: "Also fine" },
    ]);
    expect(response.json().failed).toEqual([
      {
        id: "boom",
        name: "Broken",
        error: "Could not delete this API key",
      },
    ]);
  });

  test("rejects an empty batch", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
    expect(deleteApiKeyMock).not.toHaveBeenCalled();
  });

  test("rejects a batch over the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `key-${i}`);
    expect((await bulkDelete(ids)).statusCode).toBe(400);
    expect(deleteApiKeyMock).not.toHaveBeenCalled();
  });
});
