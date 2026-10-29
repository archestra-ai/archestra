import { hashPassword } from "better-auth/crypto";
import { describe, expect, test, vi } from "vitest";

const { verifyCalls } = vi.hoisted(() => ({ verifyCalls: { count: 0 } }));

vi.mock("better-auth/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth/crypto")>();
  return {
    ...actual,
    verifyPassword: (params: Parameters<typeof actual.verifyPassword>[0]) => {
      verifyCalls.count += 1;
      return actual.verifyPassword(params);
    },
  };
});

import { defaultAdminPasswordCheck } from "./default-admin-password";

describe("defaultAdminPasswordCheck", () => {
  test("verifies each stored hash once, and answers anew after a password change", async () => {
    const defaultPassword = "default-admin-password";
    const stored = await hashPassword(defaultPassword);
    verifyCalls.count = 0;

    expect(
      await defaultAdminPasswordCheck.matches({
        password: defaultPassword,
        hash: stored,
      }),
    ).toBe(true);
    expect(
      await defaultAdminPasswordCheck.matches({
        password: defaultPassword,
        hash: stored,
      }),
    ).toBe(true);
    expect(verifyCalls.count).toBe(1);

    // The admin sets their own password: a new hash, so a new answer.
    const changed = await hashPassword("a-password-of-their-own");
    expect(
      await defaultAdminPasswordCheck.matches({
        password: defaultPassword,
        hash: changed,
      }),
    ).toBe(false);
    expect(verifyCalls.count).toBe(2);
  });

  test("checks the same hash again for a different password", async () => {
    const stored = await hashPassword("first-default");
    verifyCalls.count = 0;

    expect(
      await defaultAdminPasswordCheck.matches({
        password: "first-default",
        hash: stored,
      }),
    ).toBe(true);
    expect(
      await defaultAdminPasswordCheck.matches({
        password: "second-default",
        hash: stored,
      }),
    ).toBe(false);
    expect(verifyCalls.count).toBe(2);
  });
});
