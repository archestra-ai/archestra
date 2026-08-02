import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { describe, expect, test, vi } from "@/test";
import { revokeBasicAuthOnlySessions } from "./basic-auth-lockout";

async function sessionIdsFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.sessionsTable.id })
    .from(schema.sessionsTable)
    .where(eq(schema.sessionsTable.userId, userId));
  return rows.map((row) => row.id);
}

describe("revokeBasicAuthOnlySessions", () => {
  test("leaves every session alone while basic auth is enabled", async ({
    makeUser,
    makeAccount,
    makeSession,
  }) => {
    vi.spyOn(config.auth, "disableBasicAuth", "get").mockReturnValue(false);
    const user = await makeUser();
    await makeAccount(user.id, { providerId: "credential" });
    await makeSession(user.id);

    await revokeBasicAuthOnlySessions();

    expect(await sessionIdsFor(user.id)).toHaveLength(1);
  });

  test("revokes sessions for a user who only has a password account", async ({
    makeUser,
    makeAccount,
    makeSession,
  }) => {
    vi.spyOn(config.auth, "disableBasicAuth", "get").mockReturnValue(true);
    const user = await makeUser();
    await makeAccount(user.id, { providerId: "credential" });
    await makeSession(user.id);

    await revokeBasicAuthOnlySessions();

    expect(await sessionIdsFor(user.id)).toEqual([]);
  });

  test("spares a user with a federated account so deploys do not sign them out", async ({
    makeUser,
    makeAccount,
    makeSession,
  }) => {
    vi.spyOn(config.auth, "disableBasicAuth", "get").mockReturnValue(true);
    const user = await makeUser();
    await makeAccount(user.id, { providerId: "google" });
    await makeSession(user.id);

    await revokeBasicAuthOnlySessions();

    expect(await sessionIdsFor(user.id)).toHaveLength(1);
  });

  test("spares a user holding both account types — the documented residual", async ({
    makeUser,
    makeAccount,
    makeSession,
  }) => {
    // Their session may well have come from a password, but nothing on the
    // session row records that. Pinning the behaviour so the gap stays visible
    // rather than being mistaken for full coverage.
    vi.spyOn(config.auth, "disableBasicAuth", "get").mockReturnValue(true);
    const user = await makeUser();
    await makeAccount(user.id, { providerId: "credential" });
    await makeAccount(user.id, { providerId: "google" });
    await makeSession(user.id);

    await revokeBasicAuthOnlySessions();

    expect(await sessionIdsFor(user.id)).toHaveLength(1);
  });

  test("only sweeps the password-only user when both kinds exist", async ({
    makeUser,
    makeAccount,
    makeSession,
  }) => {
    vi.spyOn(config.auth, "disableBasicAuth", "get").mockReturnValue(true);
    const passwordOnly = await makeUser();
    await makeAccount(passwordOnly.id, { providerId: "credential" });
    await makeSession(passwordOnly.id);

    const federated = await makeUser();
    await makeAccount(federated.id, { providerId: "google" });
    await makeSession(federated.id);

    await revokeBasicAuthOnlySessions();

    expect(await sessionIdsFor(passwordOnly.id)).toEqual([]);
    expect(await sessionIdsFor(federated.id)).toHaveLength(1);
  });
});
