import { describe, expect, test } from "vitest";
import {
  parsePermissionSubjectKey,
  permissionSubjectKey,
  ResourceOwnerQuerySchema,
  ResourceSharedWithQuerySchema,
} from "./resource-access";

const serviceAccountId = "00000000-0000-4000-8000-000000000001";

describe("sharedWith subject keys", () => {
  test("round-trip every subject type, with org as a bare token", () => {
    for (const subject of [
      { type: "organization", id: "*" },
      { type: "role", id: "role-1" },
      { type: "team", id: "team-1" },
      { type: "user", id: "user-1" },
      { type: "serviceAccount", id: serviceAccountId },
    ] as const) {
      expect(parsePermissionSubjectKey(permissionSubjectKey(subject))).toEqual(
        subject,
      );
    }
    expect(permissionSubjectKey({ type: "organization", id: "*" })).toBe("org");
    expect(parsePermissionSubjectKey("organization:*")).toEqual({
      type: "organization",
      id: "*",
    });
  });

  test("rejects malformed keys", () => {
    for (const key of [
      "",
      "team",
      "team:",
      ":id",
      "group:1",
      "organization:abc",
      "serviceAccount:not-a-uuid",
    ]) {
      expect(parsePermissionSubjectKey(key)).toBeNull();
    }
  });

  test("the query parameter parses a comma-separated list and rejects a bad key", () => {
    expect(ResourceSharedWithQuerySchema.parse(`org,team:t1,user:u1`)).toEqual([
      { type: "organization", id: "*" },
      { type: "team", id: "t1" },
      { type: "user", id: "u1" },
    ]);
    expect(ResourceSharedWithQuerySchema.parse(undefined)).toBeUndefined();
    expect(ResourceSharedWithQuerySchema.safeParse("nope").success).toBe(false);
    expect(ResourceOwnerQuerySchema.parse("u1,u2")).toEqual(["u1", "u2"]);
  });
});
