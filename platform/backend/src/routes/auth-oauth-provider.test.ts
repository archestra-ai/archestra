import { createHash, randomBytes } from "node:crypto";
import fastifyFormbody from "@fastify/formbody";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import AccountModel from "@/models/account";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";

setupTestCacheManager();

// These run the auth routes against the real Better Auth OAuth provider, so
// they pin how the provider treats the requests real MCP clients send.
describe("auth routes with the OAuth provider", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    app = createFastifyInstance();
    await app.register(fastifyFormbody);
    const { default: authRoutes } = await import("./auth");
    await app.register(authRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("dynamic client registration", () => {
    test.each([
      ["a loopback redirect (Claude Code)", "http://localhost:53682/callback"],
      ["a loopback IP redirect (VS Code)", "http://127.0.0.1:33418/"],
      [
        "an authority-form custom scheme (Cursor)",
        "cursor://anysphere.cursor-mcp/oauth/callback",
      ],
      ["a reverse-domain custom scheme", "com.example.app:/callback"],
    ])("registers a client with %s as a native app", async (_label, redirectUri) => {
      const response = await register({ redirect_uris: [redirectUri] });

      expect(response.statusCode).toBe(201);
      expect(await storedApplicationType(response.json().client_id)).toBe(
        "native",
      );
    });

    test("keeps an https client on a public host a web app", async () => {
      const response = await register({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      });

      expect(response.statusCode).toBe(201);
      expect(await storedApplicationType(response.json().client_id)).toBe(
        "web",
      );
    });

    test("keeps the application_type a client sends", async () => {
      const response = await register({
        redirect_uris: ["http://localhost:53682/callback"],
        application_type: "web",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_redirect_uri");
    });

    test("still rejects a reserved redirect scheme", async () => {
      const response = await register({
        redirect_uris: ["file:///tmp/callback"],
      });

      expect(response.statusCode).toBe(400);
    });
  });

  test("a native MCP client signs in with a gateway resource, refreshes, and outlives the user's browser session", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    const password = "test-only-password-strong-482!";
    await AccountModel.createCredentialAccount({
      userId: user.id,
      passwordHash: await hashPassword(password),
    });
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: BROWSER_HEADERS,
      payload: { email: user.email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = [signIn.headers["set-cookie"]]
      .flat()
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.split(";")[0])
      .join("; ");

    const redirectUri = "http://localhost:53682/callback";
    const registration = await register({
      redirect_uris: [redirectUri],
      scope: "mcp offline_access",
    });
    const clientId = registration.json().client_id;
    const verifier = randomBytes(32).toString("base64url");

    // MCP clients send the gateway URL as the RFC 8707 resource.
    const authorize = await app.inject({
      method: "GET",
      url: `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "mcp offline_access",
        state: "state",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        resource: GATEWAY_RESOURCE,
      })}`,
      headers: { host: HOST, cookie },
    });
    expect(authorize.statusCode).toBe(302);
    const consentLocation = String(authorize.headers.location);
    expect(consentLocation).not.toContain("error=");

    const consent = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/consent",
      headers: { ...BROWSER_HEADERS, cookie },
      payload: {
        accept: true,
        scope: "mcp offline_access",
        oauth_query: consentLocation.slice(consentLocation.indexOf("?") + 1),
      },
    });
    const code = new URL(consent.json().redirectTo).searchParams.get("code");

    const issued = await token({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: GATEWAY_RESOURCE,
    });
    expect(issued.statusCode).toBe(200);
    expect(await isAccepted(issued.json().access_token)).toBe(true);

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: issued.json().refresh_token,
      client_id: clientId,
      resource: GATEWAY_RESOURCE,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(await isAccepted(refreshed.json().access_token)).toBe(true);

    // Signing out revokes the access tokens bound to that browser session...
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { ...BROWSER_HEADERS, cookie },
      payload: {},
    });
    expect(await isAccepted(refreshed.json().access_token)).toBe(false);

    // ...but an offline_access refresh token keeps the MCP client signed in.
    const afterSignOut = await token({
      grant_type: "refresh_token",
      refresh_token: refreshed.json().refresh_token,
      client_id: clientId,
    });
    expect(afterSignOut.statusCode).toBe(200);
    expect(await isAccepted(afterSignOut.json().access_token)).toBe(true);
  });

  async function register(metadata: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/auth/oauth2/register",
      headers: BROWSER_HEADERS,
      payload: {
        client_name: "MCP client",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...metadata,
      },
    });
  }

  async function token(params: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: {
        host: HOST,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams(params).toString(),
    });
  }
});

const HOST = "localhost:3000";
const BROWSER_HEADERS = { host: HOST, origin: `http://${HOST}` };
const GATEWAY_RESOURCE =
  "http://localhost:9000/v1/mcp/00000000-0000-4000-8000-000000000001";

async function storedApplicationType(clientId: string) {
  const [client] = await db
    .select({ applicationType: schema.oauthClientsTable.applicationType })
    .from(schema.oauthClientsTable)
    .where(eq(schema.oauthClientsTable.clientId, clientId));
  return client?.applicationType;
}

/** Whether the gateways' token lookup still accepts this access token. */
async function isAccepted(accessToken: string) {
  const row = await OAuthAccessTokenModel.getByTokenHash(
    OAuthAccessTokenModel.hashTokenForLookup(accessToken),
  );
  return Boolean(row && !row.refreshTokenRevoked);
}
