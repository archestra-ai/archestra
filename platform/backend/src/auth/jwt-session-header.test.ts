import { makeSignature } from "better-auth/crypto";
import { betterAuth } from "@/auth";
import { expect, test } from "@/test";

// The jwt plugin's /get-session after-hook can mint a JWT (a jwks table read
// plus an RS256 signature) on every session validation just to set a
// `set-auth-jwt` response header. Nothing consumes that header, and the auth
// middleware calls getSession on every authenticated request, so the header
// is disabled (disableSettingJwtHeader). This pins that per-request JWT
// signing stays off — reverting the flag would silently reintroduce a DB
// read + RSA sign per request.
test("getSession does not mint a per-request JWT header", async ({
  makeUser,
  makeSession,
}) => {
  const user = await makeUser();
  const session = await makeSession(user.id);

  // Better-auth session cookies are HMAC-signed: `<token>.<signature>` under
  // the configured cookie name.
  const ctx = await betterAuth.$context;
  const cookieName = ctx.authCookies.sessionToken.name;
  const signedToken = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;

  const { response, headers } = await betterAuth.api.getSession({
    headers: new Headers({
      cookie: `${cookieName}=${encodeURIComponent(signedToken)}`,
    }),
    returnHeaders: true,
  });

  // Sanity: the session actually resolved — otherwise the header would be
  // absent for the wrong reason.
  expect(response?.user.id).toBe(user.id);
  expect(headers.get("set-auth-jwt")).toBeNull();
});
