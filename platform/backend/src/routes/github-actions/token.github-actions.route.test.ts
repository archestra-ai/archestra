import { generateKeyPairSync, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import logger from "@/logging";
import {
  AgentModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { validateOAuthToken } from "@/routes/mcp-gateway/utils";
import { buildOAuthIssuer } from "@/services/identity-providers/enterprise-managed/authorization";
import { jwksValidator } from "@/services/jwks-validator";
import { oauthTokenRateLimiter } from "@/services/oauth-token-rate-limit";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { authenticatedRouteApp } from "@/test/authenticated-route-app";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { GitHubUserIdSchema, type User } from "@/types";
import githubActionsRoutes from "./github-actions.routes";

vi.mock("@/logging");

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const REPOSITORY = "acme/widgets";
const REPOSITORY_ID = 7_000_001;
const WORKFLOW =
  "acme/review-workflows/.github/workflows/review.yml@refs/heads/main";
const AUTHOR = { id: 4242, login: "octo-author" };
const SCOPED_GITHUB_TOKEN = "ghs_scoped_to_one_repository";
const UNTRUSTED = {
  error: "not_trusted",
  message: "This MCP gateway does not accept this GitHub Actions run.",
};
const ACCESS_TOKENS_URL =
  "https://api.github.com/app/installations/456/access_tokens";
const GITHUB_USER_URL = "https://api.github.com/user";
const HOUR = 60 * 60 * 1000;

// The GitHub App's own key, which signs its requests for installation tokens.
const appPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

// GitHub's OIDC signing key, served from its published JWKS URL below.
let oidcSigningKey: CryptoKey;
let oidcPublicJwk: JWK;
let pullRequest: {
  user: { id: number; login: string };
  head: { repo: { full_name: string } | null };
};
let scopedTokenRequests: unknown[];

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
const server = useMswServer(
  http.get(`${GITHUB_ISSUER}/.well-known/jwks`, () =>
    HttpResponse.json({ keys: [oidcPublicJwk] }),
  ),
  http.post(ACCESS_TOKENS_URL, async ({ request }) => {
    const text = await request.text();
    const body = text ? JSON.parse(text) : {};
    if (body.repository_ids) scopedTokenRequests.push(body);
    return HttpResponse.json(
      {
        token: body.repository_ids
          ? SCOPED_GITHUB_TOKEN
          : "ghs_installation_wide",
        expires_at: new Date(Date.now() + HOUR).toISOString(),
      },
      { status: 201 },
    );
  }),
  http.get("https://api.github.com/repos/:owner/:repo/pulls/:number", () =>
    HttpResponse.json(pullRequest),
  ),
  // A user token `ghu_<id>` (see `connectGitHub`) is the GitHub account `<id>`.
  http.get(GITHUB_USER_URL, ({ request }) => {
    const id = Number(
      /^Bearer ghu_(\d+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1],
    );
    return id
      ? HttpResponse.json({ id, login: `user-${id}` })
      : HttpResponse.json({ message: "Bad credentials" }, { status: 401 });
  }),
);
setupTestCacheManager();

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  oidcSigningKey = privateKey as CryptoKey;
  oidcPublicJwk = {
    ...(await exportJWK(publicKey)),
    kid: "github-actions-test",
    alg: "RS256",
    use: "sig",
  };
});

afterAll(() => {
  jwksValidator.clearCache();
});

describe("POST /api/github-actions/token", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let author: User;
  let gateway: { id: string; slug: string | null };

  beforeEach(
    async ({
      makeOrganization,
      makeAdmin,
      makeMember,
      makeUser,
      makeAgent,
    }) => {
      pullRequest = {
        user: AUTHOR,
        head: { repo: { full_name: REPOSITORY } },
      };
      scopedTokenRequests = [];
      organizationId = (await makeOrganization()).id;
      const admin = await makeAdmin();
      await makeMember(admin.id, organizationId, { role: "admin" });
      await RuntimeCredentialDefinitionModel.create({
        organizationId,
        createdBy: admin.id,
        definition: {
          description: "",
          icon: null,
          key: "review-app",
          name: "Code Review App",
          kind: "github_app",
          allowPersonal: false,
          allowOrganization: true,
          githubUrl: "https://api.github.com",
          appId: "123",
          installationId: "456",
          githubClientId: "review-client",
        },
      });
      await setAppPrivateKey(appPrivateKey);
      await RuntimeCredentialDefinitionModel.create({
        organizationId,
        createdBy: admin.id,
        definition: {
          description: "",
          icon: null,
          key: "github",
          name: "GitHub",
          kind: "github_app_user",
          allowPersonal: true,
          allowOrganization: false,
          githubAppCredentialKey: "review-app",
        },
      });

      author = await makeUser();
      await makeMember(author.id, organizationId);
      await connectGitHub(author.id, AUTHOR);

      gateway = await makeGitHubActionsGateway(makeAgent);
      app = await authenticatedRouteApp({
        organizationId,
        routes: [githubActionsRoutes],
      });
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("issues a gateway token acting as whoever started the run and a GitHub token for that repository", async ({
    makeAgent,
  }) => {
    const oidc = await oidcToken();

    const response = await exchange({ token: oidc });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body).toMatchObject({
      token_type: "Bearer",
      expires_in: 3 * 60 * 60,
      github_token: SCOPED_GITHUB_TOKEN,
      github_login: AUTHOR.login,
      user_id: author.id,
    });
    expect(Date.parse(body.github_token_expires_at)).toBeGreaterThan(
      Date.now(),
    );
    expect(scopedTokenRequests).toEqual([
      {
        repository_ids: [REPOSITORY_ID],
        permissions: {
          pull_requests: "write",
          contents: "read",
          checks: "read",
          metadata: "read",
        },
      },
    ]);

    // The gateway accepts it as the author, and only this gateway does.
    expect(
      await validateOAuthToken({
        profileId: gateway.id,
        tokenValue: body.access_token,
      }),
    ).toMatchObject({ userId: author.id, organizationId });
    const other = await makeGitHubActionsGateway(makeAgent);
    expect(
      await validateOAuthToken({
        profileId: other.id,
        tokenValue: body.access_token,
      }),
    ).toBeNull();

    // Named in the log, and no credential is.
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayId: gateway.id,
        repository: REPOSITORY,
        pullRequest: 42,
        githubLogin: AUTHOR.login,
        userId: author.id,
      }),
      expect.any(String),
    );
    const logged = JSON.stringify(
      (["fatal", "error", "warn", "info", "debug", "trace"] as const).flatMap(
        (level) => vi.mocked(logger[level]).mock.calls,
      ),
    );
    for (const secret of [oidc, body.access_token, body.github_token])
      expect(logged).not.toContain(secret);
  });

  test("accepts the gateway's slug URL and a numeric actor_id", async () => {
    expect(gateway.slug).toBeTruthy();

    const response = await exchange({
      token: await oidcToken({ claims: { actor_id: AUTHOR.id } }),
      resource: `${buildOAuthIssuer()}/v1/mcp/${gateway.slug}`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      await validateOAuthToken({
        profileId: gateway.id,
        tokenValue: response.json().access_token,
      }),
    ).toMatchObject({ userId: author.id });
  });

  test("refuses, by default, a run someone other than the author started", async () => {
    const response = await exchange({
      token: await oidcToken({
        claims: { actor_id: "777", actor: "a-maintainer" },
      }),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body).toMatchObject({ error: "not_author", login: AUTHOR.login });
    expect(body.message).toContain("a-maintainer");
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("acts as whoever started the run when the gateway says so, also on someone else's pull request", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const maintainer = await makeUser();
    await makeMember(maintainer.id, organizationId);
    await connectGitHub(maintainer.id, { id: 777, login: "a-maintainer" });
    const actorGateway = await makeGitHubActionsGateway(makeAgent, {
      actAs: "actor",
    });

    const response = await exchange({
      token: await oidcToken({
        claims: { actor_id: "777", actor: "a-maintainer" },
      }),
      resource: gatewayUrl(actorGateway.id),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      github_login: "a-maintainer",
      user_id: maintainer.id,
    });
    // Never the author's account: the author did not start this run.
    expect(body.user_id).not.toBe(author.id);
  });

  test("names whoever started the run when they have not connected GitHub", async ({
    makeAgent,
  }) => {
    const actorGateway = await makeGitHubActionsGateway(makeAgent, {
      actAs: "actor",
    });

    const response = await exchange({
      token: await oidcToken({
        claims: { actor_id: "777", actor: "a-maintainer" },
      }),
      resource: gatewayUrl(actorGateway.id),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "not_linked",
      login: "a-maintainer",
    });
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("asks for contents: write when the gateway resolves review threads", async ({
    makeAgent,
  }) => {
    const resolving = await makeGitHubActionsGateway(makeAgent, {
      resolveReviewThreads: true,
    });

    const response = await exchange({
      token: await oidcToken(),
      resource: gatewayUrl(resolving.id),
    });

    expect(response.statusCode).toBe(200);
    expect(scopedTokenRequests).toMatchObject([
      { permissions: { contents: "write", pull_requests: "write" } },
    ]);
    // The audit log says what the run's GitHub token can do.
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: resolving.id, contents: "write" }),
      expect.any(String),
    );
  });

  test("falls back to contents: read when the App may not write contents", async ({
    makeAgent,
  }) => {
    const resolving = await makeGitHubActionsGateway(makeAgent, {
      resolveReviewThreads: true,
    });
    server.use(
      http.post(ACCESS_TOKENS_URL, async ({ request }) => {
        const text = await request.text();
        const body = text ? JSON.parse(text) : {};
        if (body.repository_ids) scopedTokenRequests.push(body);
        if (body.permissions?.contents === "write")
          return HttpResponse.json(
            {
              message:
                "The permissions requested are not granted to this installation.",
            },
            { status: 422 },
          );
        return HttpResponse.json(
          {
            token: body.repository_ids
              ? SCOPED_GITHUB_TOKEN
              : "ghs_installation_wide",
            expires_at: new Date(Date.now() + HOUR).toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    const response = await exchange({
      token: await oidcToken(),
      resource: gatewayUrl(resolving.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().github_token).toBe(SCOPED_GITHUB_TOKEN);
    expect(
      scopedTokenRequests.map(
        (request) =>
          (request as { permissions: { contents: string } }).permissions
            .contents,
      ),
    ).toEqual(["write", "read"]);
  });

  test("takes the gateway token back when GitHub refuses both the write and the read token", async ({
    makeAgent,
  }) => {
    const resolving = await makeGitHubActionsGateway(makeAgent, {
      resolveReviewThreads: true,
    });
    server.use(
      http.post(ACCESS_TOKENS_URL, async ({ request }) => {
        const text = await request.text();
        const body = text ? JSON.parse(text) : {};
        if (body.repository_ids) {
          scopedTokenRequests.push(body);
          return HttpResponse.json(
            { message: "Resource not accessible by integration" },
            { status: 422 },
          );
        }
        return HttpResponse.json(
          {
            token: "ghs_installation_wide",
            expires_at: new Date(Date.now() + HOUR).toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    const response = await exchange({
      token: await oidcToken(),
      resource: gatewayUrl(resolving.id),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("github_error");
    expect(scopedTokenRequests).toHaveLength(2);
    expect(
      await OAuthClientModel.listWithUserTokens({ userId: author.id }),
    ).toEqual([]);
  });

  test("does not fall back to contents: read when GitHub fails for another reason", async ({
    makeAgent,
  }) => {
    const resolving = await makeGitHubActionsGateway(makeAgent, {
      resolveReviewThreads: true,
    });
    server.use(
      http.post(ACCESS_TOKENS_URL, async ({ request }) => {
        const text = await request.text();
        const body = text ? JSON.parse(text) : {};
        if (body.repository_ids) {
          scopedTokenRequests.push(body);
          return HttpResponse.json(
            { message: "Server Error" },
            { status: 500 },
          );
        }
        return HttpResponse.json(
          {
            token: "ghs_installation_wide",
            expires_at: new Date(Date.now() + HOUR).toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    const response = await exchange({
      token: await oidcToken(),
      resource: gatewayUrl(resolving.id),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("github_error");
    expect(scopedTokenRequests).toHaveLength(1);
    expect(
      await OAuthClientModel.listWithUserTokens({ userId: author.id }),
    ).toEqual([]);
  });

  test("refuses a token that was already exchanged", async () => {
    const oidc = await oidcToken();

    expect((await exchange({ token: oidc })).statusCode).toBe(200);
    const replay = await exchange({ token: oidc });

    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("invalid_token");
    expect(scopedTokenRequests).toHaveLength(1);
  });

  test("accepts a token once when two exchanges race", async () => {
    const oidc = await oidcToken();

    const responses = await Promise.all([
      exchange({ token: oidc }),
      exchange({ token: oidc }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 401,
    ]);
    expect(scopedTokenRequests).toHaveLength(1);
  });

  test.each([
    ["for another audience", { audience: "https://elsewhere.example.com" }],
    ["from another issuer", { issuer: "https://token.actions.example.com" }],
    ["that expired", { expiresAt: Math.floor(Date.now() / 1000) - 600 }],
  ])("refuses a token %s as invalid", async (_case, options) => {
    const response = await exchange({ token: await oidcToken(options) });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("invalid_token");
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test.each<[string, { claims?: Record<string, unknown>; gatewayId?: string }]>(
    [
      [
        "an event other than pull_request",
        { claims: { event_name: "push", ref: "refs/heads/main" } },
      ],
      [
        "a ref that is not a pull request merge ref",
        { claims: { ref: "refs/heads/main" } },
      ],
      [
        "a repository the gateway does not list",
        { claims: { repository: "acme/other" } },
      ],
      [
        "a workflow the gateway does not trust",
        {
          claims: {
            job_workflow_ref:
              "acme/widgets/.github/workflows/review.yml@refs/pull/42/merge",
          },
        },
      ],
      ["a gateway that does not exist", { gatewayId: randomUUID() }],
    ],
  )("refuses %s with the same answer", async (_case, options) => {
    const response = await exchange({
      token: await oidcToken({ claims: options.claims }),
      ...(options.gatewayId && { resource: gatewayUrl(options.gatewayId) }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(UNTRUSTED);
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("gives gateways that do not take GitHub Actions runs the same answer, and logs why", async ({
    makeAgent,
    makeInternalAgent,
  }) => {
    const plainGateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    const agent = await makeInternalAgent({ organizationId });
    await AgentModel.update(agent.id, {
      githubActionsAccess: githubActionsAccess(),
    });

    for (const id of [plainGateway.id, agent.id]) {
      const response = await exchange({
        token: await oidcToken(),
        resource: gatewayUrl(id),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(UNTRUSTED);
    }
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "GitHub Actions access is off" }),
      expect.any(String),
    );
  });

  test("accepts any repository of an owner that the gateway lists as owner/*", async ({
    makeAgent,
  }) => {
    const ownerWide = await makeGitHubActionsGateway(makeAgent);
    await AgentModel.update(ownerWide.id, {
      githubActionsAccess: {
        ...githubActionsAccess(),
        repositories: ["Acme/*"],
      },
    });

    const response = await exchange({
      token: await oidcToken(),
      resource: gatewayUrl(ownerWide.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().github_login).toBe(AUTHOR.login);
    // The GitHub token is for the repository the run came from, by its id.
    expect(scopedTokenRequests).toMatchObject([
      { repository_ids: [REPOSITORY_ID] },
    ]);
  });

  test("refuses an OIDC token without a valid repository id", async () => {
    for (const repositoryId of [undefined, "0", "widgets"]) {
      const response = await exchange({
        token: await oidcToken({ claims: { repository_id: repositoryId } }),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("invalid_token");
    }
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("refuses a repository of another owner under owner/*", async ({
    makeAgent,
  }) => {
    const ownerWide = await makeGitHubActionsGateway(makeAgent);
    await AgentModel.update(ownerWide.id, {
      githubActionsAccess: {
        ...githubActionsAccess(),
        repositories: ["other/*"],
      },
    });

    const response = await exchange({
      token: await oidcToken(),
      resource: gatewayUrl(ownerWide.id),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(UNTRUSTED);
  });

  test("refuses a pull request from a fork as not trusted", async () => {
    pullRequest = {
      user: AUTHOR,
      head: { repo: { full_name: "someone-else/widgets" } },
    };

    // Someone else started it; by default the token would act as the author.
    const response = await exchange({
      token: await oidcToken({
        claims: { actor_id: "777", actor: "a-maintainer" },
      }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "not_trusted",
      login: AUTHOR.login,
    });
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("refuses a pull request the GitHub App cannot read as not trusted", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/pulls/:number", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("not_trusted");
  });

  test("reports a GitHub App key that cannot be used", async () => {
    await setAppPrivateKey(
      "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----",
    );

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("github_error");
    expect(response.json().message).toContain("private key");
  });

  test("takes the gateway token back when GitHub refuses the repository token", async () => {
    server.use(
      http.post(ACCESS_TOKENS_URL, async ({ request }) =>
        (await request.text())
          ? HttpResponse.json(
              { message: "Resource not accessible by integration" },
              { status: 422 },
            )
          : HttpResponse.json(
              {
                token: "ghs_installation_wide",
                expires_at: new Date(Date.now() + HOUR).toISOString(),
              },
              { status: 201 },
            ),
      ),
    );

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("github_error");
    expect(response.json().message).toContain(
      "Resource not accessible by integration",
    );
    expect(
      await OAuthClientModel.listWithUserTokens({ userId: author.id }),
    ).toEqual([]);
  });

  test("takes the gateway token back when GitHub cannot be reached", async () => {
    server.use(
      http.post(ACCESS_TOKENS_URL, async ({ request }) =>
        (await request.text())
          ? HttpResponse.error()
          : HttpResponse.json(
              {
                token: "ghs_installation_wide",
                expires_at: new Date(Date.now() + HOUR).toISOString(),
              },
              { status: 201 },
            ),
      ),
    );

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "github_error",
      message: "GitHub could not be reached. Try again.",
    });
    expect(
      await OAuthClientModel.listWithUserTokens({ userId: author.id }),
    ).toEqual([]);
  });

  test("answers an unexpected failure in the documented shape", async () => {
    const create = vi
      .spyOn(OAuthAccessTokenModel, "create")
      .mockRejectedValueOnce(new Error("database unavailable"));

    const response = await exchange({ token: await oidcToken() });
    create.mockRestore();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "server_error",
      message: expect.any(String),
    });
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("tells an author who has not connected GitHub where to connect it", async () => {
    pullRequest = {
      user: { id: 9999, login: "newcomer" },
      head: { repo: { full_name: REPOSITORY } },
    };

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body).toMatchObject({ error: "not_linked", login: "newcomer" });
    expect(body.message).toContain("/account/credentials");
  });

  test("treats a connected GitHub account of a former member as not linked", async ({
    makeUser,
  }) => {
    const formerMember = await makeUser();
    const login = { id: 5151, login: "former-member" };
    await connectGitHub(formerMember.id, login);
    pullRequest = { user: login, head: { repo: { full_name: REPOSITORY } } };

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("not_linked");
  });

  test("treats a connection whose authorization expired as not linked", async () => {
    await connectGitHub(author.id, AUTHOR, {
      expiresAt: Date.now() - HOUR,
      refreshExpiresAt: Date.now() - HOUR,
    });

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "not_linked",
      login: AUTHOR.login,
    });
    expect(response.json().message).toContain("connect GitHub again");
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("treats a connection GitHub refuses to refresh as not linked", async () => {
    let refreshes = 0;
    server.use(
      http.post("https://github.com/login/oauth/access_token", () => {
        refreshes += 1;
        return HttpResponse.json({
          error: "bad_refresh_token",
          error_description:
            "The refresh token passed is incorrect or expired.",
        });
      }),
    );
    await connectGitHub(author.id, AUTHOR, { expiresAt: Date.now() - HOUR });

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("not_linked");
    expect(refreshes).toBe(1);
  });

  test("treats a connection GitHub no longer accepts as not linked, though it has not expired here", async () => {
    server.use(
      http.get(GITHUB_USER_URL, () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "not_linked",
      login: AUTHOR.login,
    });
    expect(response.json().message).toContain("connect GitHub again");
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("treats a connection whose token acts as another GitHub account as not linked", async () => {
    server.use(
      http.get(GITHUB_USER_URL, () =>
        HttpResponse.json({ id: 1, login: "someone-else" }),
      ),
    );

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("not_linked");
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test.each([
    [
      "the primary limit",
      { "x-ratelimit-remaining": "0" },
      "API rate limit exceeded",
    ],
    ["a secondary limit", { "retry-after": "60" }, "API rate limit exceeded"],
    [
      "a secondary limit without a header",
      { "x-ratelimit-remaining": "4000" },
      "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    ],
  ])("reports %s on the connection check as a GitHub error, not as not linked", async (_case, headers, message) => {
    server.use(
      http.get(GITHUB_USER_URL, () =>
        HttpResponse.json({ message }, { status: 403, headers }),
      ),
    );

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("github_error");
    expect(response.json().message).toContain("rate-limited");
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("reports GitHub failing to check the author's connection", async () => {
    server.use(
      http.get(GITHUB_USER_URL, () =>
        HttpResponse.json({ message: "Server Error" }, { status: 500 }),
      ),
    );

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("github_error");
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("refuses a GitHub account connected by more than one member", async ({
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, organizationId);
    await connectGitHub(other.id, AUTHOR);

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "ambiguous_link",
      login: AUTHOR.login,
    });
  });

  test("refuses an author whose account cannot use the gateway", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId);
    const privateGateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      authorId: owner.id,
      access: "personal",
    });
    await AgentModel.update(privateGateway.id, {
      githubActionsAccess: githubActionsAccess(),
    });

    const response = await exchange({
      token: await oidcToken(),
      resource: gatewayUrl(privateGateway.id),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "forbidden",
      login: AUTHOR.login,
    });
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test.each([
    ["a body without a resource", { resource: undefined }],
    [
      "a resource outside this deployment",
      {
        resource:
          "https://elsewhere.example.com/v1/mcp/00000000-0000-4000-8000-000000000000",
      },
    ],
    [
      "a gateway id that is neither a uuid nor a slug",
      { resource: `/v1/mcp/${"-".repeat(36)}` },
    ],
  ])("refuses %s as an invalid request", async (_case, options) => {
    const resource = options.resource?.startsWith("/")
      ? `${buildOAuthIssuer()}${options.resource}`
      : options.resource;

    const response = await app.inject({
      method: "POST",
      url: "/api/github-actions/token",
      payload: { token: await oidcToken(), resource },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
  });

  test("has a request budget of its own", async () => {
    let lastStatus = 0;
    for (let request = 0; request <= 100; request++) {
      lastStatus = (
        await app.inject({
          method: "POST",
          url: "/api/github-actions/token",
          payload: {},
        })
      ).statusCode;
    }

    expect(lastStatus).toBe(429);
    expect((await oauthTokenRateLimiter.consume("127.0.0.1")).allowed).toBe(
      true,
    );
  });

  // ===== Helpers =====

  async function makeGitHubActionsGateway(
    makeAgent: (overrides: {
      organizationId: string;
      agentType: "mcp_gateway";
    }) => Promise<{ id: string; slug: string | null }>,
    access: { actAs?: "author" | "actor"; resolveReviewThreads?: boolean } = {},
  ) {
    const created = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    await AgentModel.update(created.id, {
      githubActionsAccess: { ...githubActionsAccess(), ...access },
    });
    return created;
  }

  function exchange(params: { token: string; resource?: string }) {
    return app.inject({
      method: "POST",
      url: "/api/github-actions/token",
      payload: {
        token: params.token,
        resource: params.resource ?? gatewayUrl(gateway.id),
      },
    });
  }

  async function setAppPrivateKey(privateKey: string) {
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "organization",
      userId: null,
      credentialId: "review-app",
      value: JSON.stringify({ privateKey, clientSecret: "client-secret" }),
    });
  }

  async function connectGitHub(
    userId: string,
    account: { id: number; login: string },
    lifetimes: { expiresAt?: number; refreshExpiresAt?: number } = {},
  ) {
    const githubId = GitHubUserIdSchema.parse(account.id);
    // Stored the way GitHub sign-in stores it.
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "personal",
      userId,
      credentialId: "github",
      value: JSON.stringify({
        accessToken: `ghu_${account.id}`,
        refreshToken: "ghr_user_refresh",
        expiresAt: lifetimes.expiresAt ?? Date.now() + 8 * HOUR,
        refreshExpiresAt:
          lifetimes.refreshExpiresAt ?? Date.now() + 1000 * HOUR,
        clientId: "review-client",
        githubId,
        login: account.login,
      }),
      githubId,
    });
  }
});

function githubActionsAccess() {
  return {
    githubAppCredentialKey: "review-app",
    repositories: ["ACME/Widgets"],
    workflows: [WORKFLOW],
  };
}

function gatewayUrl(id: string) {
  return `${buildOAuthIssuer()}/v1/mcp/${id}`;
}

async function oidcToken(
  options: {
    claims?: Record<string, unknown>;
    issuer?: string;
    audience?: string;
    expiresAt?: number;
  } = {},
) {
  return new SignJWT({
    jti: randomUUID(),
    event_name: "pull_request",
    ref: "refs/pull/42/merge",
    repository: REPOSITORY,
    repository_id: String(REPOSITORY_ID),
    repository_owner: "acme",
    job_workflow_ref: WORKFLOW,
    // The pull request's author started the run, unless a test says otherwise.
    actor_id: String(pullRequest.user.id),
    actor: pullRequest.user.login,
    ...options.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "github-actions-test" })
    .setIssuer(options.issuer ?? GITHUB_ISSUER)
    .setAudience(options.audience ?? buildOAuthIssuer())
    .setSubject(`repo:${REPOSITORY}:pull_request`)
    .setIssuedAt(
      options.expiresAt
        ? options.expiresAt - 300
        : Math.floor(Date.now() / 1000),
    )
    .setExpirationTime(options.expiresAt ?? "5m")
    .sign(oidcSigningKey);
}
