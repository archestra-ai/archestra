// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import AccountModel from "@/models/account";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { auth } from "./better-auth";

const ORIGIN = "http://localhost:3000";
const IDP = "https://reassigned-email.example.test";
const PROVIDER = "reassigned-email";
const EMAIL = "reused@example.com";
const DEPARTED_SUBJECT = "departed-employee-subject";
const NEW_SUBJECT = "new-employee-subject";

// An IdP can hand a mailbox to a different person: a departed employee's
// address is reassigned to a new hire, who gets a new, immutable subject.
// The subject identifies the person; the email does not.
describe("SSO sign-in when the IdP reassigns an email to a new subject", () => {
  const server = useMswServer();
  let departedUserId: string;
  let organizationId: string;
  let profile: Record<string, unknown>;

  beforeEach(
    async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeIdentityProvider,
    }) => {
      config.enterpriseFeatures.core = true;
      departedUserId = (await makeUser({ email: EMAIL, emailVerified: true }))
        .id;
      organizationId = (await makeOrganization()).id;
      await makeMember(departedUserId, organizationId, { role: "member" });
      await makeIdentityProvider(organizationId, {
        providerId: PROVIDER,
        issuer: IDP,
        domain: "example.com",
        oidcConfig: {
          issuer: IDP,
          discoveryEndpoint: `${IDP}/.well-known/openid-configuration`,
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          authorizationEndpoint: `${IDP}/authorize`,
          tokenEndpoint: `${IDP}/token`,
          userInfoEndpoint: `${IDP}/userinfo`,
          jwksEndpoint: `${IDP}/jwks`,
          scopes: ["openid", "email"],
          pkce: false,
          mapping: { id: "sub", email: "email", name: "name" },
        },
      });
      await makeAccount(departedUserId, {
        providerId: PROVIDER,
        accountId: DEPARTED_SUBJECT,
      });
      profile = {
        sub: NEW_SUBJECT,
        email: EMAIL,
        email_verified: true,
        name: "New Hire",
      };
      server.use(
        http.get(`${IDP}/.well-known/openid-configuration`, () =>
          HttpResponse.json({
            issuer: IDP,
            authorization_endpoint: `${IDP}/authorize`,
            token_endpoint: `${IDP}/token`,
            userinfo_endpoint: `${IDP}/userinfo`,
            jwks_uri: `${IDP}/jwks`,
          }),
        ),
        http.post(`${IDP}/token`, () =>
          HttpResponse.json({
            access_token: "test-access-token",
            token_type: "Bearer",
          }),
        ),
        http.get(`${IDP}/userinfo`, () => HttpResponse.json(profile)),
      );
    },
  );

  test("does not sign the new subject into the departed user's account", async () => {
    const response = await signIn();
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookies(response) }),
    });

    expect(session?.user.id).not.toBe(departedUserId);
    expect(
      (await AccountModel.getAllByUserId(departedUserId)).map(
        (account) => account.accountId,
      ),
    ).toEqual([DEPARTED_SUBJECT]);
  });

  test("does not sign the new subject in after the departed user left the organization", async () => {
    // The user row outlives its last membership when it was removed through
    // a path that does not delete users (or before removal deleted them).
    await db.delete(schema.membersTable);

    const response = await signIn();
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookies(response) }),
    });

    expect(session?.user.id).not.toBe(departedUserId);
  });
});

async function signIn() {
  const start = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        providerId: PROVIDER,
        callbackURL: `${ORIGIN}/chat`,
      }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = await start.json();
  const state = new URL(url).searchParams.get("state");
  return auth.handler(
    new Request(
      `${ORIGIN}/api/auth/sso/callback/${PROVIDER}?code=test-code&state=${state}`,
      { headers: { cookie: cookies(start) } },
    ),
  );
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
