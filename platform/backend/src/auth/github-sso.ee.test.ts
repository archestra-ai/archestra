// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { needsRuntimeDiscovery } from "@better-auth/sso";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    enterpriseFeatures: { core: true },
  }),
);

const { auth } = await import("./better-auth");
describe("GitHub OAuth SSO", () => {
  const server = useMswServer();

  for (const scenario of [
    {
      name: "public email",
      profileEmail: "oauth-user@example.com",
      emails: [],
      expectedEmail: "oauth-user@example.com",
    },
    {
      name: "private primary verified email",
      profileEmail: null,
      emails: [
        { email: "secondary@example.com", primary: false, verified: true },
        { email: "oauth-user@example.com", primary: true, verified: true },
      ],
      expectedEmail: "oauth-user@example.com",
    },
    {
      name: "verified secondary email",
      profileEmail: null,
      emails: [
        { email: "unverified@example.com", primary: true, verified: false },
        { email: "oauth-user@example.com", primary: false, verified: true },
      ],
      expectedEmail: "oauth-user@example.com",
    },
    {
      name: "no verified email",
      profileEmail: null,
      emails: [
        { email: "unverified@example.com", primary: true, verified: false },
      ],
      expectedEmail: null,
    },
    {
      name: "email lookup denied",
      profileEmail: null,
      emails: [],
      expectedEmail: null,
      emailStatus: 403,
    },
  ]) {
    test(`completes GitHub OAuth safely with ${scenario.name}`, async ({
      makeOrganization,
      makeIdentityProvider,
    }) => {
      const discoveryRequests: string[] = [];
      let emailRequests = 0;
      server.use(
        http.post("https://github.com/login/oauth/access_token", () =>
          HttpResponse.json({
            access_token: "test-access-token",
            token_type: "bearer",
            scope: "read:user,user:email",
          }),
        ),
        http.get("https://api.github.com/user", () =>
          HttpResponse.json({
            id: 12345,
            email: scenario.profileEmail,
            name: "OAuth User",
          }),
        ),
      );
      server.use(
        http.get("https://api.github.com/user/emails", ({ request }) => {
          emailRequests++;
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-access-token",
          );
          return HttpResponse.json(scenario.emails, {
            status: scenario.emailStatus ?? 200,
          });
        }),
        http.get(
          "https://github.com/.well-known/openid-configuration",
          ({ request }) => {
            discoveryRequests.push(request.url);
            return new HttpResponse(null, { status: 404 });
          },
        ),
      );
      const organization = await makeOrganization();
      const provider = await makeIdentityProvider(organization.id, {
        providerId: "GitHub",
        issuer: "https://github.com",
        domain: "",
        oidcConfig: {
          issuer: "https://github.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          authorizationEndpoint: "https://github.com/login/oauth/authorize",
          tokenEndpoint: "https://github.com/login/oauth/access_token",
          userInfoEndpoint: "https://api.github.com/user",
          discoveryEndpoint:
            "https://github.com/.well-known/openid-configuration",
          tokenEndpointAuthentication: "client_secret_basic",
          scopes: ["read:user", "user:email"],
          pkce: false,
          mapping: { id: "id", email: "email", name: "name" },
        },
      });
      const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/sso", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({
            providerId: provider.providerId,
            callbackURL: "http://localhost:3000/chat",
          }),
        }),
      );
      const body = await response.json();
      expect(response.status, JSON.stringify({ body, discoveryRequests })).toBe(
        200,
      );
      expect(body.url).toMatch(
        /^https:\/\/github\.com\/login\/oauth\/authorize\?/,
      );
      const state = new URL(body.url).searchParams.get("state");
      const cookies = response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const callback = await auth.handler(
        new Request(
          `http://localhost:3000/api/auth/sso/callback/${provider.providerId}?code=test-code&state=${state}`,
          { headers: { cookie: cookies } },
        ),
      );
      expect(callback.status).toBe(302);
      expect(discoveryRequests).toEqual([]);
      expect(emailRequests).toBe(scenario.profileEmail ? 0 : 1);
      if (!scenario.expectedEmail) {
        expect(callback.headers.get("location")).toContain(
          "error_description=missing_user_info",
        );
        expect(
          callback.headers
            .getSetCookie()
            .some((cookie) => cookie.includes("session_token=")),
        ).toBe(false);
        return;
      }
      expect(callback.headers.get("location")).toBe(
        "http://localhost:3000/chat",
      );
      const sessionCookies = callback.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: sessionCookies }),
      });
      expect(session?.user.email).toBe(scenario.expectedEmail);
      if (!scenario.profileEmail)
        expect(session?.user.emailVerified).toBe(true);
      expect(discoveryRequests).toEqual([]);
    });
  }
});

test.each([
  { scopes: undefined, userInfoEndpoint: "https://example.com/user" },
  { scopes: ["openid", "email"], userInfoEndpoint: "https://example.com/user" },
  { scopes: [], userInfoEndpoint: "https://example.com/user" },
  { scopes: ["read:user"], userInfoEndpoint: undefined },
])("still requires discovery for OIDC or missing identity endpoints: %j", (config) => {
  expect(
    needsRuntimeDiscovery({
      ...config,
      authorizationEndpoint: "https://example.com/authorize",
      tokenEndpoint: "https://example.com/token",
    }),
  ).toBe(true);
});
