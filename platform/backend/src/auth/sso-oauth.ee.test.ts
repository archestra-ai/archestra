// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    auth: {
      trustedOrigins: ["http://localhost:3000", "https://idp.example.com"],
    },
  }),
);

const { auth } = await import("./better-auth");
describe("SSO with explicit OAuth endpoints", () => {
  const server = useMswServer();
  test("GitHub signs in and completes its userinfo callback without OIDC discovery or JWKS", async ({
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const provider = await makeIdentityProvider(org.id, {
      providerId: "GitHub",
      issuer: "https://github.com",
      domain: "example.com",
      oidcConfig: {
        issuer: "https://github.com",
        clientId: "test-github-client",
        clientSecret: "test-github-secret",
        discoveryEndpoint: "",
        skipDiscovery: true,
        pkce: false,
        authorizationEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        userInfoEndpoint: "https://api.github.com/user",
        scopes: ["read:user", "user:email"],
        mapping: { id: "id", email: "email", name: "name" },
      },
    });
    let tokenRequests = 0;
    let userInfoRequests = 0;
    server.use(
      http.post(
        "https://github.com/login/oauth/access_token",
        async ({ request }) => {
          tokenRequests++;
          const body = new URLSearchParams(await request.text());
          expect(body.get("code")).toBe("test-code");
          expect(body.get("redirect_uri")).toBe(
            "http://localhost:3000/api/auth/sso/callback/GitHub",
          );
          return HttpResponse.json({
            access_token: "test-github-access-token",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        },
      ),
      http.get("https://api.github.com/user", ({ request }) => {
        userInfoRequests++;
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-github-access-token",
        );
        return HttpResponse.json({
          id: 12345,
          email: "github-user@example.com",
          name: "GitHub User",
        });
      }),
    );

    const signIn = await initiateSignIn(provider.providerId);
    expect(signIn.status).toBe(200);
    const { url } = await signIn.json();
    const authorizationUrl = new URL(url);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "read:user user:email",
    );
    expect(authorizationUrl.searchParams.has("code_challenge")).toBe(false);
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    const cookies = signIn.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    const callback = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/sso/callback/GitHub?code=test-code&state=${state}`,
        { headers: { cookie: cookies } },
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("http://localhost:3000/chat");
    expect(tokenRequests).toBe(1);
    expect(userInfoRequests).toBe(1);
    const [account] = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.providerId, "GitHub"));
    expect(account.accountId).toBe("12345");
    const [session] = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, account.userId));
    expect(session).toBeDefined();
  });

  test("an ID-token-only provider still discovers its missing JWKS endpoint", async ({
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const provider = await makeIdentityProvider(org.id, {
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "test-oidc-client",
        clientSecret: "test-oidc-secret",
        authorizationEndpoint: "https://idp.example.com/authorize",
        tokenEndpoint: "https://idp.example.com/token",
      },
    });
    let discoveryRequests = 0;
    server.use(
      http.get(
        "https://idp.example.com/.well-known/openid-configuration",
        () => {
          discoveryRequests++;
          return HttpResponse.json({
            issuer: "https://idp.example.com",
            authorization_endpoint: "https://idp.example.com/authorize",
            token_endpoint: "https://idp.example.com/token",
            jwks_uri: "https://idp.example.com/jwks",
          });
        },
      ),
    );

    const response = await initiateSignIn(provider.providerId);
    expect(response.status).toBe(200);
    expect(discoveryRequests).toBe(1);
  });

  test("explicit OAuth endpoints still reject an untrusted private userinfo URL", async ({
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const provider = await makeIdentityProvider(org.id, {
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "test-oauth-client",
        clientSecret: "test-oauth-secret",
        skipDiscovery: true,
        authorizationEndpoint: "https://idp.example.com/authorize",
        tokenEndpoint: "https://idp.example.com/token",
        userInfoEndpoint: "http://192.168.0.1/userinfo",
      },
    });

    const response = await initiateSignIn(provider.providerId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "discovery_private_host",
    });
  });
});

function initiateSignIn(providerId: string) {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/sso", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        providerId,
        callbackURL: "http://localhost:3000/chat",
      }),
    }),
  );
}
