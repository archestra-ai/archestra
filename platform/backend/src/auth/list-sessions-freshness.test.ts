import { APIError } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";
import { betterAuth } from "@/auth";
import config from "@/config";
import { describe, expect, test } from "@/test";

const DAY_MS = 86_400_000;

async function sessionCookieHeaders(sessionToken: string) {
  if (!config.auth.secret) {
    throw new Error("Auth secret is not configured");
  }
  const ctx = await betterAuth.$context;
  const signature = await makeSignature(sessionToken, config.auth.secret);
  return new Headers({
    cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(
      `${sessionToken}.${signature}`,
    )}`,
  });
}

/**
 * `/list-sessions` returns every session's raw token, so Better Auth guards it
 * with a freshness check: a session older than `freshAge` (24h by default) is
 * refused even though it is still valid for everything else. Sessions live 7
 * days, so an account spends most of its life in that state — which is why the
 * Sessions card has a re-authentication state rather than just a list.
 */
describe("listSessions session freshness", () => {
  test("refuses a session older than freshAge", async ({
    makeUser,
    makeSession,
  }) => {
    const user = await makeUser();
    const session = await makeSession(user.id, {
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      expiresAt: new Date(Date.now() + 5 * DAY_MS),
    });

    const listStale = betterAuth.api.listSessions({
      headers: await sessionCookieHeaders(session.token),
    });

    await expect(listStale).rejects.toThrow(APIError);
    await expect(listStale).rejects.toMatchObject({
      body: { code: "SESSION_NOT_FRESH" },
    });
  });

  test("lists sessions for a session within freshAge", async ({
    makeUser,
    makeSession,
  }) => {
    const user = await makeUser();
    const session = await makeSession(user.id, {
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
    });

    const sessions = await betterAuth.api.listSessions({
      headers: await sessionCookieHeaders(session.token),
    });

    expect(sessions.map((s) => s.id)).toContain(session.id);
  });
});
