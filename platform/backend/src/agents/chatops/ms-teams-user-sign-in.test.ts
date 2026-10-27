import { createHash } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { ChatOpsMsTeamsUserConnectionModel } from "@/models";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import type { IncomingChatMessage } from "@/types";
import {
  getMsTeamsSignInRedirectUri,
  msTeamsUserSignIn,
} from "./ms-teams-user-sign-in";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const SENDER_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT = {
  tenantId: TENANT_ID,
  clientId: "22222222-2222-4222-8222-222222222222",
  clientSecret: "client-secret",
};
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

describe("Teams file sign-in", () => {
  const server = useMswServer();
  setupTestCacheManager();

  test("signing in stores the sender's tokens and hands back their held message once", async () => {
    let redeemed: URLSearchParams | undefined;
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        redeemed = new URLSearchParams(await request.text());
        return HttpResponse.json(
          tokenResponse({ oid: SENDER_ID, tid: TENANT_ID }),
        );
      }),
    );
    const message = heldMessage();

    const authorize = await startSignIn(message);
    const outcome = await msTeamsUserSignIn.completeSignIn({
      code: "auth-code",
      state: authorize.searchParams.get("state") ?? "",
      client: CLIENT,
    });

    // PKCE: the code is redeemed with the verifier behind the challenge.
    const verifier = redeemed?.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      authorize.searchParams.get("code_challenge"),
    );
    expect(redeemed?.get("redirect_uri")).toBe(getMsTeamsSignInRedirectUri());
    expect(redeemed?.get("client_secret")).toBe("client-secret");

    expect(outcome.status).toBe("connected");
    const replay = outcome.status === "connected" ? outcome.replay : null;
    // Answered as a new message, still reading its files from the original.
    expect(replay).toMatchObject({
      messageId: "1792632504796:signed-in",
      text: "what's in the report?",
      metadata: {
        conversationType: "groupChat",
        sourceMessageId: "1792632504796",
      },
    });
    expect(replay?.timestamp).toBeInstanceOf(Date);
    // The webhook's live objects and credentials are never held.
    expect(replay?.metadata).not.toHaveProperty("turnContext");
    expect(replay?.metadata).not.toHaveProperty("authHeader");

    expect(
      await msTeamsUserSignIn.getAccessToken({
        tenantId: TENANT_ID,
        aadObjectId: SENDER_ID,
        client: CLIENT,
      }),
    ).toBe("access-1");
  });

  test("a different account finishing the sign-in stores nothing", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          tokenResponse({ oid: "someone-else", tid: TENANT_ID }),
        ),
      ),
    );

    const authorize = await startSignIn(heldMessage());
    const outcome = await msTeamsUserSignIn.completeSignIn({
      code: "auth-code",
      state: authorize.searchParams.get("state") ?? "",
      client: CLIENT,
    });

    expect(outcome).toEqual({ status: "wrong_account", expectedName: "Alice" });
    expect(
      await ChatOpsMsTeamsUserConnectionModel.find({
        tenantId: TENANT_ID,
        aadObjectId: SENDER_ID,
      }),
    ).toBeNull();
  });

  test("a sign-in state works once, and a held message is answered once", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(tokenResponse({ oid: SENDER_ID, tid: TENANT_ID })),
      ),
    );
    const signInUrl = await msTeamsUserSignIn.createPendingSignIn({
      tenantId: TENANT_ID,
      message: heldMessage(),
    });
    const key = new URL(signInUrl).searchParams.get("key") ?? "";
    // The card is clicked twice before either sign-in finishes.
    const first = await beginSignIn(key);
    const second = await beginSignIn(key);

    const firstOutcome = await msTeamsUserSignIn.completeSignIn({
      code: "code-1",
      state: first.searchParams.get("state") ?? "",
      client: CLIENT,
    });
    const reusedState = await msTeamsUserSignIn.completeSignIn({
      code: "code-1",
      state: first.searchParams.get("state") ?? "",
      client: CLIENT,
    });
    const secondOutcome = await msTeamsUserSignIn.completeSignIn({
      code: "code-2",
      state: second.searchParams.get("state") ?? "",
      client: CLIENT,
    });

    expect(firstOutcome).toMatchObject({ status: "connected" });
    expect(reusedState).toEqual({ status: "expired" });
    // The held message was taken by the first sign-in.
    expect(secondOutcome).toEqual({ status: "expired" });
    // And the card's link is spent too.
    expect(
      await msTeamsUserSignIn.beginSignIn({ key, client: CLIENT }),
    ).toBeNull();
  });

  test("an expired access token is refreshed, keeping the newest refresh token", async () => {
    const grants: string[] = [];
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        grants.push(`${body.get("grant_type")}:${body.get("refresh_token")}`);
        return HttpResponse.json({
          access_token: `access-${grants.length}`,
          refresh_token: `refresh-${grants.length}`,
          expires_in: 3600,
          scope: "Files.Read",
        });
      }),
    );
    await signedInWithExpiredToken("refresh-0");

    const first = await accessToken();
    // Fresh now, so it is not refreshed again.
    const second = await accessToken();

    expect(first).toBe("access-1");
    expect(second).toBe("access-1");
    expect(grants).toEqual(["refresh_token:refresh-0"]);
  });

  test("a sign-in Microsoft no longer honours is dropped so the next file asks again", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "AADSTS700082: The refresh token has expired.",
          },
          { status: 400 },
        ),
      ),
    );
    await signedInWithExpiredToken("refresh-revoked");

    expect(await accessToken()).toBeNull();
    expect(
      await ChatOpsMsTeamsUserConnectionModel.find({
        tenantId: TENANT_ID,
        aadObjectId: SENDER_ID,
      }),
    ).toBeNull();
  });

  test("a passing token-service outage keeps the sign-in", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          { error: "temporarily_unavailable" },
          { status: 503 },
        ),
      ),
    );
    await signedInWithExpiredToken("refresh-0");

    expect(await accessToken()).toBeNull();
    expect(
      await ChatOpsMsTeamsUserConnectionModel.find({
        tenantId: TENANT_ID,
        aadObjectId: SENDER_ID,
      }),
    ).not.toBeNull();
  });

  test("an unknown or malformed sign-in link starts nothing", async () => {
    expect(
      await msTeamsUserSignIn.beginSignIn({
        key: "00000000-0000-4000-8000-000000000000",
        client: CLIENT,
      }),
    ).toBeNull();
    expect(
      await msTeamsUserSignIn.beginSignIn({ key: "not-a-key", client: CLIENT }),
    ).toBeNull();
  });
});

// =============================================================================
// Helpers
// =============================================================================

function heldMessage(): IncomingChatMessage {
  return {
    messageId: "1792632504796",
    channelId: "19:group-chat@thread.v2",
    workspaceId: null,
    senderId: SENDER_ID,
    senderName: "Alice",
    senderEmail: "alice@contoso.com",
    text: "what's in the report?",
    rawText: "<at>Bot</at> what's in the report?",
    timestamp: new Date("2026-10-21T12:00:00Z"),
    isThreadReply: false,
    metadata: {
      conversationType: "groupChat",
      tenantId: TENANT_ID,
      conversationReference: {
        conversation: { id: "19:group-chat@thread.v2" },
      },
      turnContext: { live: true },
      authHeader: "Bearer webhook-jwt",
    },
  };
}

async function startSignIn(message: IncomingChatMessage): Promise<URL> {
  const signInUrl = await msTeamsUserSignIn.createPendingSignIn({
    tenantId: TENANT_ID,
    message,
  });
  return beginSignIn(new URL(signInUrl).searchParams.get("key") ?? "");
}

async function beginSignIn(key: string): Promise<URL> {
  const authorizeUrl = await msTeamsUserSignIn.beginSignIn({
    key,
    client: CLIENT,
  });
  if (!authorizeUrl) throw new Error("sign-in did not start");
  return new URL(authorizeUrl);
}

function tokenResponse(claims: { oid: string; tid: string }) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3600,
    scope: "openid profile https://graph.microsoft.com/Files.Read",
    id_token: `${encode({ alg: "none" })}.${encode(claims)}.`,
  };
}

async function signedInWithExpiredToken(refreshToken: string): Promise<void> {
  await ChatOpsMsTeamsUserConnectionModel.save({
    tenantId: TENANT_ID,
    aadObjectId: SENDER_ID,
    scope: "Files.Read",
    tokens: {
      accessToken: "access-0",
      refreshToken,
      accessTokenExpiresAt: Date.now() - 1000,
    },
  });
}

function accessToken(): Promise<string | null> {
  return msTeamsUserSignIn.getAccessToken({
    tenantId: TENANT_ID,
    aadObjectId: SENDER_ID,
    client: CLIENT,
  });
}
