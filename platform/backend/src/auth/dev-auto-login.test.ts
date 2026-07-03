import { betterAuth } from "@/auth";
import config from "@/config";
import { afterEach, describe, expect, test } from "@/test";

/**
 * POST /api/auth/dev-auto-login mints a real session for the user named by
 * ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL. It is inert (404) unless the env
 * var is set and the build is non-production.
 */
// biome-ignore lint/suspicious/noExplicitAny: custom Better Auth endpoint isn't in the generated api types
const devAutoLogin = (betterAuth.api as any).devAutoLogin as (opts: {
  asResponse: true;
  headers: Headers;
}) => Promise<Response>;

const originalEmail = config.auth.devAutoAuthenticateEmail;
const originalProduction = config.production;

const setProduction = (value: boolean) => {
  Object.defineProperty(config, "production", { value, configurable: true });
};

describe("dev-auto-login endpoint", () => {
  afterEach(() => {
    config.auth.devAutoAuthenticateEmail = originalEmail;
    setProduction(originalProduction);
  });

  test("returns 404 when the feature is disabled", async () => {
    config.auth.devAutoAuthenticateEmail = undefined;

    const res = await devAutoLogin({
      asResponse: true,
      headers: new Headers(),
    });

    expect(res.status).toBe(404);
  });

  test("mints a session and sets a cookie for the configured user", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const email = "dev-auto-login@test.com";
    const user = await makeUser({ email });
    const org = await makeOrganization();
    await makeMember(user.id, org.id);
    config.auth.devAutoAuthenticateEmail = email;

    const res = await devAutoLogin({
      asResponse: true,
      headers: new Headers(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: user.id });
    // Better Auth's signed session cookie is set on the response.
    expect(res.headers.get("set-cookie")).toContain("session_token");
  });

  test("returns 404 when the configured email has no user", async () => {
    config.auth.devAutoAuthenticateEmail = "nobody@test.com";

    const res = await devAutoLogin({
      asResponse: true,
      headers: new Headers(),
    });

    expect(res.status).toBe(404);
  });

  test("returns 404 in production even when configured", async () => {
    config.auth.devAutoAuthenticateEmail = "dev-auto-login@test.com";
    setProduction(true);

    const res = await devAutoLogin({
      asResponse: true,
      headers: new Headers(),
    });

    expect(res.status).toBe(404);
  });
});
