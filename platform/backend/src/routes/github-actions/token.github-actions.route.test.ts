import { generateKeyPairSync, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import logger from "@/logging";
import {
  AgentModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { validateOAuthToken } from "@/routes/mcp-gateway/utils";
import { buildOAuthIssuer } from "@/services/identity-providers/enterprise-managed/authorization";
import { jwksValidator } from "@/services/jwks-validator";
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
const WORKFLOW =
  "acme/review-workflows/.github/workflows/review.yml@refs/heads/main";
const AUTHOR = { id: 4242, login: "octo-author" };
const SCOPED_GITHUB_TOKEN = "ghs_scoped_to_one_repository";

// The GitHub App's own key, which signs its requests for installation tokens.
const appPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

// GitHub's OIDC signing key, served from its published JWKS URL below.
let oidcSigningKey: CryptoKey;
let oidcPublicJwk: JWK;
let pullRequest: Record<string, unknown>;
let scopedTokenRequests: unknown[];

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
const server = useMswServer(
  http.get(`${GITHUB_ISSUER}/.well-known/jwks`, () =>
    HttpResponse.json({ keys: [oidcPublicJwk] }),
  ),
  http.post(
    "https://api.github.com/app/installations/456/access_tokens",
    async ({ request }) => {
      const text = await request.text();
      const body = text ? JSON.parse(text) : {};
      if (body.repositories) scopedTokenRequests.push(body);
      return HttpResponse.json(
        {
          token: body.repositories
            ? SCOPED_GITHUB_TOKEN
            : "ghs_installation_wide",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        { status: 201 },
      );
    },
  ),
  http.get("https://api.github.com/repos/:owner/:repo/pulls/:number", () =>
    HttpResponse.json(pullRequest),
  ),
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
  let gatewayId: string;

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
      await RuntimeCredentialConnectionModel.upsert({
        organizationId,
        scope: "organization",
        userId: null,
        credentialId: "review-app",
        value: JSON.stringify({
          privateKey: appPrivateKey,
          clientSecret: "client-secret",
        }),
      });
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
      await connectGitHub(author.id, AUTHOR.id);

      gatewayId = await makeGitHubActionsGateway(makeAgent);
      app = await authenticatedRouteApp({
        organizationId,
        routes: [githubActionsRoutes],
      });
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("issues a gateway token acting as the pull request's author and a GitHub token for that repository", async ({
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
        repositories: ["widgets"],
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
        profileId: gatewayId,
        tokenValue: body.access_token,
      }),
    ).toMatchObject({ userId: author.id, organizationId });
    const otherGatewayId = await makeGitHubActionsGateway(makeAgent);
    expect(
      await validateOAuthToken({
        profileId: otherGatewayId,
        tokenValue: body.access_token,
      }),
    ).toBeNull();

    // Named in the log, and no credential is.
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayId,
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

  test("refuses a token that was already exchanged", async () => {
    const oidc = await oidcToken();

    expect((await exchange({ token: oidc })).statusCode).toBe(200);
    const replay = await exchange({ token: oidc });

    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("invalid_token");
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

  test.each([
    [
      "an event other than pull_request",
      { event_name: "push", ref: "refs/heads/main" },
    ],
    ["a repository the gateway does not list", { repository: "acme/other" }],
    [
      "a workflow the gateway does not trust",
      {
        job_workflow_ref:
          "acme/widgets/.github/workflows/review.yml@refs/pull/42/merge",
      },
    ],
  ])("refuses %s as not trusted", async (_case, claims) => {
    const response = await exchange({ token: await oidcToken({ claims }) });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("not_trusted");
    expect(scopedTokenRequests).toHaveLength(0);
  });

  test("refuses a gateway without GitHub Actions access as not trusted", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });

    const response = await exchange({
      token: await oidcToken(),
      resource: gatewayUrl(gateway.id),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("not_trusted");
  });

  test("refuses a pull request from a fork as not trusted", async () => {
    pullRequest = {
      user: AUTHOR,
      head: { repo: { full_name: "someone-else/widgets" } },
    };

    const response = await exchange({ token: await oidcToken() });

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
    await connectGitHub(formerMember.id, 5151);
    pullRequest = {
      user: { id: 5151, login: "former-member" },
      head: { repo: { full_name: REPOSITORY } },
    };

    const response = await exchange({ token: await oidcToken() });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("not_linked");
  });

  test("refuses a GitHub account connected by more than one member", async ({
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, organizationId);
    await connectGitHub(other.id, AUTHOR.id);

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
    ["a body without a resource", (token: string) => ({ token })],
    [
      "a resource outside this deployment",
      (token: string) => ({
        token,
        resource:
          "https://elsewhere.example.com/v1/mcp/00000000-0000-4000-8000-000000000000",
      }),
    ],
  ])("refuses %s as an invalid request", async (_case, body) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/github-actions/token",
      payload: body(await oidcToken()),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
  });

  // ===== Helpers =====

  async function makeGitHubActionsGateway(
    makeAgent: (overrides: {
      organizationId: string;
      agentType: "mcp_gateway";
    }) => Promise<{ id: string }>,
  ) {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    await AgentModel.update(gateway.id, {
      githubActionsAccess: githubActionsAccess(),
    });
    return gateway.id;
  }

  function exchange(params: { token: string; resource?: string }) {
    return app.inject({
      method: "POST",
      url: "/api/github-actions/token",
      payload: {
        token: params.token,
        resource: params.resource ?? gatewayUrl(gatewayId),
      },
    });
  }

  async function connectGitHub(userId: string, githubId: number) {
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "personal",
      userId,
      credentialId: "github",
      value: "user-token",
      githubId: GitHubUserIdSchema.parse(githubId),
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
    repository_owner: "acme",
    job_workflow_ref: WORKFLOW,
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
