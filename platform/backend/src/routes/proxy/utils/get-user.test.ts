import { USER_ID_HEADER } from "@shared";
import { describe, expect, test } from "@/test";
import { getUser } from "./get-user";

const headerKey = USER_ID_HEADER.toLowerCase();

describe("getUser", () => {
  test("returns userId from X-Archestra-User-Id header when user exists", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id);

    const result = await getUser({ [headerKey]: user.id });

    expect(result).toEqual({ userId: user.id, source: "archestra-header" });
  });

  test("returns undefined when X-Archestra-User-Id header has invalid user ID", async () => {
    const result = await getUser({
      [headerKey]: "00000000-0000-0000-0000-000000000000",
    });

    expect(result).toBeUndefined();
  });

  test("returns userId from x-openwebui-user-email when user exists with matching email", async ({
    makeUser,
  }) => {
    const email = `openwebui-${crypto.randomUUID()}@test.com`;
    const user = await makeUser({ email });

    const result = await getUser({
      "x-openwebui-user-email": email,
    });

    expect(result).toEqual({ userId: user.id, source: "openwebui-email" });
  });

  test("returns undefined when x-openwebui-user-email has no matching user", async () => {
    const result = await getUser({
      "x-openwebui-user-email": "nonexistent@example.com",
    });

    expect(result).toBeUndefined();
  });

  test("prefers X-Archestra-User-Id over x-openwebui-user-email when both present", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const archestraUser = await makeUser({
      email: `archestra-${crypto.randomUUID()}@test.com`,
    });
    const org = await makeOrganization();
    await makeMember(archestraUser.id, org.id);

    const openwebuiUser = await makeUser({
      email: `openwebui-${crypto.randomUUID()}@test.com`,
    });

    const result = await getUser({
      [headerKey]: archestraUser.id,
      "x-openwebui-user-email": openwebuiUser.email,
    });

    expect(result).toEqual({
      userId: archestraUser.id,
      source: "archestra-header",
    });
  });

  test("falls back to x-openwebui-user-email when X-Archestra-User-Id is invalid", async ({
    makeUser,
  }) => {
    const email = `fallback-${crypto.randomUUID()}@test.com`;
    const user = await makeUser({ email });

    const result = await getUser({
      [headerKey]: "00000000-0000-0000-0000-000000000000",
      "x-openwebui-user-email": email,
    });

    expect(result).toEqual({ userId: user.id, source: "openwebui-email" });
  });

  test("returns undefined when no headers present", async () => {
    const result = await getUser({});

    expect(result).toBeUndefined();
  });

  test("handles array header values", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id);

    const result = await getUser({
      [headerKey]: [user.id, "ignored-value"],
    });

    expect(result).toEqual({ userId: user.id, source: "archestra-header" });
  });

  test("handles whitespace-only header values as absent", async () => {
    const result = await getUser({
      [headerKey]: "   ",
      "x-openwebui-user-email": "  ",
    });

    expect(result).toBeUndefined();
  });
});
