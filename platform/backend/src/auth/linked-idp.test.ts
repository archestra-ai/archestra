import {
  LINKED_IDP_AUTH_COMPLETE_ENDPOINT,
  LINKED_IDP_AUTH_INTENT_ENDPOINT,
} from "@shared";
import { getCookies, parseSetCookieHeader } from "better-auth/cookies";
import { makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { betterAuth } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

describe("linked identity provider auth plugin", () => {
  test("requires an authenticated session to create a linked IdP intent", async () => {
    const response = await betterAuth.handler(
      new Request(`http://localhost:3000${LINKED_IDP_AUTH_INTENT_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "downstream-idp",
          redirectTo: "/chat/abc",
        }),
      }),
    );

    expect(response.status).not.toBe(200);
  });

  test("creates a linked IdP intent from the active session", async ({
    makeMember,
    makeOrganization,
    makeSession,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "primary@example.com" });
    await makeMember(user.id, org.id, { role: "member" });
    const session = await makeSession(user.id, {
      activeOrganizationId: org.id,
    });

    const response = await betterAuth.handler(
      new Request(`http://localhost:3000${LINKED_IDP_AUTH_INTENT_ENDPOINT}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: await createSessionCookie(session.token),
        },
        body: JSON.stringify({
          providerId: "downstream-idp",
          redirectTo: "https://evil.example.com/phish",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      intentId: string;
      redirectTo: string;
    };
    expect(body.intentId).toEqual(expect.any(String));
    expect(body.redirectTo).toBe("/chat");

    const [verification] = await db
      .select()
      .from(schema.verificationsTable)
      .where(
        eq(schema.verificationsTable.identifier, `linked-idp:${body.intentId}`),
      );
    expect(verification).toBeDefined();
    const intent = JSON.parse(verification.value);
    expect(intent).toMatchObject({
      originalUserId: user.id,
      originalSessionId: session.id,
      providerId: "downstream-idp",
      redirectTo: "/chat",
    });
    expect(intent).not.toHaveProperty("originalSessionToken");
  });

  test("completes a linked IdP intent and restores a Better Auth session cookie", async ({
    makeAccount,
    makeMember,
    makeOrganization,
    makeSession,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const originalUser = await makeUser({ email: "primary@example.com" });
    const downstreamUser = await makeUser({ email: "downstream@example.com" });
    await makeMember(originalUser.id, org.id, { role: "member" });
    await makeMember(downstreamUser.id, org.id, { role: "member" });
    const originalSession = await makeSession(originalUser.id, {
      activeOrganizationId: org.id,
    });
    const downstreamSession = await makeSession(downstreamUser.id, {
      activeOrganizationId: org.id,
    });
    const downstreamAccount = await makeAccount(downstreamUser.id, {
      providerId: "downstream-idp",
      accessToken: "linked-access-token",
    });

    const intentResponse = await betterAuth.handler(
      new Request(`http://localhost:3000${LINKED_IDP_AUTH_INTENT_ENDPOINT}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: await createSessionCookie(originalSession.token),
        },
        body: JSON.stringify({
          providerId: "downstream-idp",
          redirectTo: "/chat/conversation-123",
        }),
      }),
    );
    expect(intentResponse.status).toBe(200);
    const { intentId } = (await intentResponse.json()) as { intentId: string };

    const completeResponse = await betterAuth.handler(
      new Request(`http://localhost:3000${LINKED_IDP_AUTH_COMPLETE_ENDPOINT}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: await createSessionCookie(downstreamSession.token),
        },
        body: JSON.stringify({ intentId }),
      }),
    );

    expect(completeResponse.status).toBe(200);
    expect(await completeResponse.json()).toEqual({
      redirectTo: "/chat/conversation-123",
    });

    const restoredCookie = getSessionCookieFromResponse(completeResponse);
    expect(restoredCookie).toContain(originalSession.token);

    const restoredSessionResponse = await betterAuth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { cookie: restoredCookie },
      }),
    );
    expect(restoredSessionResponse.status).toBe(200);
    const restoredSession = (await restoredSessionResponse.json()) as {
      user: { id: string };
      session: { id: string };
    };
    expect(restoredSession.user.id).toBe(originalUser.id);
    expect(restoredSession.session.id).toBe(originalSession.id);

    const [linkedAccount] = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.id, downstreamAccount.id));
    expect(linkedAccount?.userId).toBe(originalUser.id);

    const [deletedDownstreamSession] = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, downstreamSession.id));
    expect(deletedDownstreamSession).toBeUndefined();
  });
});

async function createSessionCookie(sessionToken: string) {
  if (!config.auth.secret) {
    throw new Error("Auth secret is not configured");
  }

  const signature = await makeSignature(sessionToken, config.auth.secret);
  return `${getSessionCookieName()}=${encodeURIComponent(
    `${sessionToken}.${signature}`,
  )}`;
}

function getSessionCookieFromResponse(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();

  const cookies = parseSetCookieHeader(setCookie || "");
  const cookieName = getSessionCookieName();
  const sessionCookie = cookies.get(cookieName);
  expect(sessionCookie?.value).toBeTruthy();
  return `${cookieName}=${sessionCookie?.value}`;
}

function getSessionCookieName() {
  return getCookies(betterAuth.options).sessionToken.name;
}
