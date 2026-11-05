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

  test("refuses to sign the new subject into the departed user's account", async ({
    makeAccount,
  }) => {
    await makeAccount(departedUserId, {
      providerId: PROVIDER,
      accountId: DEPARTED_SUBJECT,
    });

    const response = await signIn();

    expectSubjectConflict(response);
    expect(await sessionUserId(response)).toBeUndefined();
    expect(await subjectsOf(departedUserId)).toEqual([DEPARTED_SUBJECT]);
  });

  test("refuses the new subject after the departed user left the organization", async ({
    makeAccount,
  }) => {
    // The user row outlives its last membership when it was removed through a
    // path that does not delete users. Sign-in must not revive it for someone
    // else, or organization provisioning hands them the old account's data.
    await makeAccount(departedUserId, {
      providerId: PROVIDER,
      accountId: DEPARTED_SUBJECT,
    });
    await db.delete(schema.membersTable);

    const response = await signIn();

    expectSubjectConflict(response);
    expect(await sessionUserId(response)).toBeUndefined();
    expect(await db.select().from(schema.membersTable)).toEqual([]);
  });

  test("still signs in the subject that is already linked", async ({
    makeAccount,
  }) => {
    await makeAccount(departedUserId, {
      providerId: PROVIDER,
      accountId: DEPARTED_SUBJECT,
    });
    profile.sub = DEPARTED_SUBJECT;

    const response = await signIn();

    expect(response.headers.get("location")).toBe(`${ORIGIN}/chat`);
    expect(await sessionUserId(response)).toBe(departedUserId);
  });

  test("still links a user's first subject from this provider by email", async () => {
    const response = await signIn();

    expect(response.headers.get("location")).toBe(`${ORIGIN}/chat`);
    expect(await sessionUserId(response)).toBe(departedUserId);
    expect(await subjectsOf(departedUserId)).toEqual([NEW_SUBJECT]);
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

function expectSubjectConflict(response: Response) {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.searchParams.get("error")).toBe("SSO_SUBJECT_CONFLICT");
}

async function sessionUserId(response: Response) {
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: cookies(response) }),
  });
  return session?.user.id;
}

async function subjectsOf(userId: string) {
  return (await AccountModel.getAllByUserId(userId))
    .filter((account) => account.providerId === PROVIDER)
    .map((account) => account.accountId);
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
