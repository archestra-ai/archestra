import { createHash } from "node:crypto";
import {
  ARCHESTRA_TOKEN_PREFIX,
  LEGACY_ARCHESTRA_TOKEN_PREFIXES,
  OAUTH_TOKEN_ID_PREFIX,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_CREATE_SKILL_FULL_NAME,
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_LOAD_SKILL_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_UPDATE_SKILL_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
  TOOL_WHOAMI_FULL_NAME,
} from "@archestra/shared";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import mcpClient from "@/clients/mcp-client";
import type * as originalConfigModule from "@/config";
import {
  AgentTeamModel,
  McpCatalogLabelModel,
  TeamTokenModel,
  ToolModel,
  UserTokenModel,
} from "@/models";
import {
  appConnectorAudienceRef,
  buildConnectorResourceUri,
} from "@/services/apps/app-connector-resource";
import { MCP_RESOURCE_REFERENCE_PREFIX } from "@/services/identity-providers/enterprise-managed/authorization";
import type { JwksValidationResult } from "@/services/jwks-validator";
import { describe, expect, test } from "@/test";

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      enterpriseFeatures: { ...actual.default.enterpriseFeatures, core: true },
    },
  };
});

const mockValidateJwt = vi.fn<() => Promise<JwksValidationResult | null>>();

vi.mock("@/services/jwks-validator", () => ({
  jwksValidator: {
    validateJwt: (...args: unknown[]) => mockValidateJwt(...(args as [])),
  },
}));

const {
  createAgentServer,
  ensureRequestSocketDestroySoon,
  validateMCPGatewayToken,
  validateOAuthToken,
  validateExternalIdpToken,
  buildKnowledgeSourcesDescription,
} = await import("./mcp-gateway.utils");

type TestListToolsHandler = (request: unknown) => Promise<ListToolsResult>;
type TestCallToolHandler = (
  request: unknown,
  extra: { sendRequest: ReturnType<typeof vi.fn> },
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: { items?: unknown[] };
}>;

describe("ensureRequestSocketDestroySoon", () => {
  test("adds destroySoon to injected request sockets", () => {
    const destroy = vi.fn();
    const request = {
      socket: {
        destroy,
      },
    };

    ensureRequestSocketDestroySoon(request as never);

    const socket = request.socket as typeof request.socket & {
      destroySoon: () => void;
    };
    expect(socket.destroySoon).toBeTypeOf("function");
    socket.destroySoon();
    expect(destroy).toHaveBeenCalledOnce();
  });

  test("preserves sockets that already have destroySoon", () => {
    const destroySoon = vi.fn();
    const request = {
      socket: {
        destroySoon,
      },
    };

    ensureRequestSocketDestroySoon(request as never);

    expect(request.socket.destroySoon).toBe(destroySoon);
  });

  test("falls back to end when destroy is unavailable", () => {
    const end = vi.fn();
    const request = {
      socket: {
        end,
      },
    };

    ensureRequestSocketDestroySoon(request as never);

    const socket = request.socket as typeof request.socket & {
      destroySoon: () => void;
    };
    expect(socket.destroySoon).toBeTypeOf("function");
    socket.destroySoon();
    expect(end).toHaveBeenCalledOnce();
  });
});

describe("validateMCPGatewayToken", () => {
  describe("invalid token scenarios", () => {
    test("returns null for invalid token", async () => {
      const result = await validateMCPGatewayToken(
        crypto.randomUUID(),
        `${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}invalidtoken1234567890ab`,
      );
      expect(result).toBeNull();
    });
  });

  describe("team token validation", () => {
    test("validates org token for any profile", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const { token, value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Org Token",
        teamId: null,
        isOrganizationToken: true,
      });

      const profileId = crypto.randomUUID();
      const result = await validateMCPGatewayToken(profileId, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isOrganizationToken).toBe(true);
      expect(result?.teamId).toBeNull();
      expect(result?.organizationId).toBe(org.id);
    });

    test("validates team token when profile is assigned to that team", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Dev Team" });
      const agent = await makeAgent({ teams: [team.id], scope: "team" });

      const { token, value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Team Token",
        teamId: team.id,
      });

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isOrganizationToken).toBe(false);
      expect(result?.teamId).toBe(team.id);
    });

    test("returns null when team token used for profile not in that team", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      // Agent assigned to team2 only
      const agent = await makeAgent({ teams: [team2.id], scope: "team" });

      // Token for team1
      const { value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Team 1 Token",
        teamId: team1.id,
      });

      const result = await validateMCPGatewayToken(agent.id, value);
      expect(result).toBeNull();
    });

    test("does not cache negative per-profile auth results", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeAgent,
    }) => {
      // Regression coverage for the "negative cache treadmill": when a
      // per-profile auth check returned null, the result used to be cached
      // for several seconds. A retry inside that window would refresh the
      // cached null, turning a transient race (e.g. a profile/team binding
      // created milliseconds after the first call) into a sticky 401.
      // The contract is now: failures bypass the cache, so each call
      // re-evaluates against fresh DB state.
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      const agent = await makeAgent({ teams: [team2.id], scope: "team" });
      const { value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Team 1 Token",
        teamId: team1.id,
      });

      const teamHasAgentAccessSpy = vi.spyOn(
        AgentTeamModel,
        "teamHasAgentAccess",
      );

      const firstResult = await validateMCPGatewayToken(agent.id, value);
      const secondResult = await validateMCPGatewayToken(agent.id, value);

      expect(firstResult).toBeNull();
      expect(secondResult).toBeNull();
      // Both calls must re-run the per-profile check; if negative caching
      // were reintroduced this would drop to 1.
      expect(teamHasAgentAccessSpy).toHaveBeenCalledTimes(2);

      teamHasAgentAccessSpy.mockRestore();
    });

    test("reuses resolved team tokens across profiles", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const { value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Org Token",
        teamId: null,
        isOrganizationToken: true,
      });
      const validateTeamTokenSpy = vi.spyOn(TeamTokenModel, "validateToken");

      const firstResult = await validateMCPGatewayToken(
        crypto.randomUUID(),
        value,
      );
      const secondResult = await validateMCPGatewayToken(
        crypto.randomUUID(),
        value,
      );

      expect(firstResult).not.toBeNull();
      expect(secondResult).not.toBeNull();
      expect(validateTeamTokenSpy).toHaveBeenCalledTimes(1);

      validateTeamTokenSpy.mockRestore();
    });
  });

  describe("user token validation", () => {
    test("validates user token when user has team access to profile", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "member" });

      const team = await makeTeam(org.id, user.id, { name: "Dev Team" });
      await makeTeamMember(team.id, user.id);
      const agent = await makeAgent({ teams: [team.id], scope: "team" });

      const { token, value } = await UserTokenModel.create(
        user.id,
        org.id,
        "Personal Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isUserToken).toBe(true);
      expect(result?.userId).toBe(user.id);
      expect(result?.organizationId).toBe(org.id);
    });

    test("returns null when user has no team access to profile", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser();
      const user2 = await makeUser();
      await makeMember(user1.id, org.id, { role: "member" });
      await makeMember(user2.id, org.id, { role: "member" });

      // user1 is in team1
      await makeTeam(org.id, user1.id, { name: "Team 1" });
      // user2 is in team2
      const team2 = await makeTeam(org.id, user2.id, { name: "Team 2" });

      // Agent is only assigned to team2
      const agent = await makeAgent({ teams: [team2.id], scope: "team" });

      // Create token for user1 (who is NOT in team2)
      const { value } = await UserTokenModel.create(
        user1.id,
        org.id,
        "User1 Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);
      expect(result).toBeNull();
    });

    test("admin user can access any profile regardless of team membership", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const adminUser = await makeUser();
      const regularUser = await makeUser();

      await makeMember(adminUser.id, org.id, { role: "admin" });
      await makeMember(regularUser.id, org.id, { role: "member" });

      // Create a team with regular user only (admin is NOT in this team)
      const team = await makeTeam(org.id, regularUser.id, {
        name: "Other Team",
      });

      // Agent assigned to team
      const agent = await makeAgent({ teams: [team.id], scope: "team" });

      // Create token for admin user
      const { token, value } = await UserTokenModel.create(
        adminUser.id,
        org.id,
        "Admin Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isUserToken).toBe(true);
      expect(result?.userId).toBe(adminUser.id);
    });

    test("passes preloaded access context into user access checks", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "member" });

      const team = await makeTeam(org.id, user.id, { name: "Dev Team" });
      await makeTeamMember(team.id, user.id);
      const agent = await makeAgent({ teams: [team.id], scope: "team" });
      const { value } = await UserTokenModel.create(user.id, org.id);
      const userHasAgentAccessSpy = vi.spyOn(
        AgentTeamModel,
        "userHasAgentAccess",
      );

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(userHasAgentAccessSpy).toHaveBeenCalledTimes(1);
      expect(userHasAgentAccessSpy.mock.calls[0]?.[3]).toMatchObject({
        id: agent.id,
        organizationId: agent.organizationId,
        scope: "team",
        authorId: agent.authorId,
      });

      userHasAgentAccessSpy.mockRestore();
    });
  });

  describe("edge cases", () => {
    test("profile with no teams - team token fails, admin user token succeeds", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const adminUser = await makeUser();
      await makeMember(adminUser.id, org.id, { role: "admin" });

      // Agent with no teams
      const agent = await makeAgent({ teams: [] });

      // Create admin user token
      const { token, value } = await UserTokenModel.create(
        adminUser.id,
        org.id,
        "Admin Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isUserToken).toBe(true);
    });

    test("user with no teams can only access profiles if admin", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const userWithNoTeams = await makeUser();
      const otherUser = await makeUser();

      await makeMember(userWithNoTeams.id, org.id, { role: "member" });
      await makeMember(otherUser.id, org.id, { role: "member" });

      // Create team with other user, agent in that team
      const team = await makeTeam(org.id, otherUser.id, { name: "Other Team" });
      const agent = await makeAgent({ teams: [team.id], scope: "team" });

      // Token for user with no teams
      const { value } = await UserTokenModel.create(
        userWithNoTeams.id,
        org.id,
        "No Teams Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);
      expect(result).toBeNull();
    });

    test("admin user with no teams can still access any profile", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const adminWithNoTeams = await makeUser();
      const otherUser = await makeUser();

      await makeMember(adminWithNoTeams.id, org.id, { role: "admin" });
      await makeMember(otherUser.id, org.id, { role: "member" });

      // Create team with other user, agent in that team
      const team = await makeTeam(org.id, otherUser.id, { name: "Other Team" });
      const agent = await makeAgent({ teams: [team.id], scope: "team" });

      // Token for admin with no teams
      const { token, value } = await UserTokenModel.create(
        adminWithNoTeams.id,
        org.id,
        "Admin No Teams Token",
      );

      const result = await validateMCPGatewayToken(agent.id, value);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(token.id);
      expect(result?.isUserToken).toBe(true);
      expect(result?.userId).toBe(adminWithNoTeams.id);
    });
  });

  describe("OAuth token validation", () => {
    test("validateOAuthToken returns null for unknown token", async () => {
      const result = await validateOAuthToken(
        crypto.randomUUID(),
        "not-a-valid-oauth-token",
      );
      expect(result).toBeNull();
    });

    test("validateOAuthToken returns null for random token that doesn't match any hash", async () => {
      const result = await validateOAuthToken(
        crypto.randomUUID(),
        "some-random-bearer-token-value-123",
      );
      expect(result).toBeNull();
    });

    test("validateMCPGatewayToken skips OAuth validation for legacy prefixed tokens", async () => {
      const result = await validateMCPGatewayToken(
        crypto.randomUUID(),
        `${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}fake_token_that_does_not_exist`,
      );
      // Returns null because the legacy token is invalid, but importantly
      // it should NOT have tried OAuth token validation
      expect(result).toBeNull();
    });

    test("validateMCPGatewayToken skips OAuth validation for current prefixed tokens", async () => {
      const result = await validateMCPGatewayToken(
        crypto.randomUUID(),
        `${ARCHESTRA_TOKEN_PREFIX}fake_token_that_does_not_exist`,
      );
      expect(result).toBeNull();
    });

    test("validateMCPGatewayToken tries OAuth validation for non-platform tokens", async () => {
      // A non-platform token should try OAuth validation path and return null
      const result = await validateMCPGatewayToken(
        crypto.randomUUID(),
        "some-random-bearer-token",
      );
      expect(result).toBeNull();
    });

    test("validateOAuthToken returns null for expired token", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeOAuthClient,
      makeOAuthAccessToken,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "admin" });

      const client = await makeOAuthClient({ userId: user.id });

      // Create a raw token and pre-compute its SHA-256 base64url hash
      const rawToken = `test-expired-token-${crypto.randomUUID()}`;
      const tokenHash = createHash("sha256")
        .update(rawToken)
        .digest("base64url");

      await makeOAuthAccessToken(client.clientId, user.id, {
        token: tokenHash,
        expiresAt: new Date(Date.now() - 3600000), // expired 1h ago
      });

      const agent = await makeAgent({ organizationId: org.id });
      const result = await validateOAuthToken(agent.id, rawToken);

      expect(result).toBeNull();
    });

    test("validateOAuthToken returns null when refresh token is revoked", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeOAuthClient,
      makeOAuthRefreshToken,
      makeOAuthAccessToken,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "admin" });

      const client = await makeOAuthClient({ userId: user.id });

      // Create a revoked refresh token
      const refreshToken = await makeOAuthRefreshToken(
        client.clientId,
        user.id,
        { revoked: new Date() },
      );

      // Create an access token linked to the revoked refresh token
      const rawToken = `test-revoked-refresh-${crypto.randomUUID()}`;
      const tokenHash = createHash("sha256")
        .update(rawToken)
        .digest("base64url");

      await makeOAuthAccessToken(client.clientId, user.id, {
        token: tokenHash,
        refreshId: refreshToken.id,
      });

      const agent = await makeAgent({ organizationId: org.id });
      const result = await validateOAuthToken(agent.id, rawToken);

      expect(result).toBeNull();
    });

    test("validateOAuthToken returns valid result for admin user with valid token", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeOAuthClient,
      makeOAuthAccessToken,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "admin" });

      const client = await makeOAuthClient({ userId: user.id });

      const rawToken = `test-valid-token-${crypto.randomUUID()}`;
      const tokenHash = createHash("sha256")
        .update(rawToken)
        .digest("base64url");

      const accessToken = await makeOAuthAccessToken(client.clientId, user.id, {
        token: tokenHash,
      });

      const agent = await makeAgent({ organizationId: org.id });
      const result = await validateOAuthToken(agent.id, rawToken);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(`${OAUTH_TOKEN_ID_PREFIX}${accessToken.id}`);
      expect(result?.userId).toBe(user.id);
      expect(result?.isUserToken).toBe(true);
      expect(result?.organizationId).toBe(org.id);
    });

    test("validateOAuthToken returns null when token is bound to another MCP resource", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeOAuthClient,
      makeOAuthAccessToken,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "admin" });

      const client = await makeOAuthClient({ userId: user.id });
      const otherAgent = await makeAgent({ organizationId: org.id });
      const targetAgent = await makeAgent({ organizationId: org.id });

      const rawToken = `test-bound-resource-token-${crypto.randomUUID()}`;
      const tokenHash = createHash("sha256")
        .update(rawToken)
        .digest("base64url");

      await makeOAuthAccessToken(client.clientId, user.id, {
        token: tokenHash,
        referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${otherAgent.id}`,
      });

      const result = await validateOAuthToken(targetAgent.id, rawToken);

      expect(result).toBeNull();
    });

    test("validateOAuthToken returns null for a token bound to an app connector", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeOAuthClient,
      makeOAuthAccessToken,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "admin" });

      const client = await makeOAuthClient({ userId: user.id });
      const targetAgent = await makeAgent({ organizationId: org.id });

      const rawToken = `app-connector-token-${crypto.randomUUID()}`;
      const tokenHash = createHash("sha256")
        .update(rawToken)
        .digest("base64url");

      // A token bound to an App connector must never authenticate the gateway,
      // even for an admin who would otherwise pass the user-access check.
      await makeOAuthAccessToken(client.clientId, user.id, {
        token: tokenHash,
        referenceId: appConnectorAudienceRef(
          buildConnectorResourceUri(
            "https://host",
            "11111111-1111-1111-1111-111111111111",
          ) as string,
        ),
      });

      const result = await validateOAuthToken(targetAgent.id, rawToken);

      expect(result).toBeNull();
    });

    test("validateOAuthToken returns valid result when refresh token is not revoked", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeOAuthClient,
      makeOAuthRefreshToken,
      makeOAuthAccessToken,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "admin" });

      const client = await makeOAuthClient({ userId: user.id });

      // Create a non-revoked refresh token
      const refreshToken = await makeOAuthRefreshToken(
        client.clientId,
        user.id,
      );

      const rawToken = `test-valid-refresh-${crypto.randomUUID()}`;
      const tokenHash = createHash("sha256")
        .update(rawToken)
        .digest("base64url");

      const accessToken = await makeOAuthAccessToken(client.clientId, user.id, {
        token: tokenHash,
        refreshId: refreshToken.id,
      });

      const agent = await makeAgent({ organizationId: org.id });
      const result = await validateOAuthToken(agent.id, rawToken);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(`${OAUTH_TOKEN_ID_PREFIX}${accessToken.id}`);
      expect(result?.userId).toBe(user.id);
    });

    test("validateOAuthToken uses the target agent organization for multi-org users", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeOAuthClient,
      makeOAuthAccessToken,
      makeAgent,
    }) => {
      const user = await makeUser();
      const firstOrg = await makeOrganization();
      const targetOrg = await makeOrganization();

      await makeMember(user.id, firstOrg.id, { role: "member" });
      await makeMember(user.id, targetOrg.id, { role: "admin" });

      const client = await makeOAuthClient({ userId: user.id });

      const rawToken = `test-multi-org-token-${crypto.randomUUID()}`;
      const tokenHash = createHash("sha256")
        .update(rawToken)
        .digest("base64url");

      const accessToken = await makeOAuthAccessToken(client.clientId, user.id, {
        token: tokenHash,
      });

      const agent = await makeAgent({ organizationId: targetOrg.id });
      const result = await validateOAuthToken(agent.id, rawToken);

      expect(result).not.toBeNull();
      expect(result?.tokenId).toBe(`${OAUTH_TOKEN_ID_PREFIX}${accessToken.id}`);
      expect(result?.organizationId).toBe(targetOrg.id);
      expect(result?.userId).toBe(user.id);
    });
  });
});

describe("validateExternalIdpToken", () => {
  const FAKE_JWT = "eyJhbGciOiJSUzI1NiJ9.fake.jwt";

  test("returns null when profile has no identity provider", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const result = await validateExternalIdpToken(agent.id, FAKE_JWT);
    expect(result).toBeNull();
  });

  test("returns null when JWT has no email claim", async ({
    makeOrganization,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://example.com/.well-known/jwks.json",
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    mockValidateJwt.mockResolvedValueOnce({
      sub: "user-123",
      email: null,
      name: "Test User",
      rawClaims: { sub: "user-123" },
    });

    const result = await validateExternalIdpToken(agent.id, FAKE_JWT);
    expect(result).toBeNull();
  });

  test("uses email-shaped subject when JWT has no email claim", async ({
    makeOrganization,
    makeIdentityProvider,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "user@example.com" });
    await makeMember(user.id, org.id, { role: "admin" });
    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://example.com/.well-known/jwks.json",
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    mockValidateJwt.mockResolvedValueOnce({
      sub: "user@example.com",
      email: null,
      name: "Test User",
      rawClaims: { sub: "user@example.com" },
    });

    const result = await validateExternalIdpToken(agent.id, FAKE_JWT);
    expect(result?.userId).toBe(user.id);
    expect(result?.isExternalIdp).toBe(true);
  });

  test("returns null when the identity provider OIDC config has no clientId for audience validation", async ({
    makeOrganization,
    makeIdentityProvider,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    mockValidateJwt.mockClear();

    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });

    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        jwksEndpoint: "https://example.com/.well-known/jwks.json",
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    const result = await validateExternalIdpToken(agent.id, FAKE_JWT);

    expect(result).toBeNull();
    expect(mockValidateJwt).not.toHaveBeenCalled();
  });

  test("returns null when email does not match any Archestra user", async ({
    makeOrganization,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://example.com/.well-known/jwks.json",
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    mockValidateJwt.mockResolvedValueOnce({
      sub: "user-123",
      email: "nonexistent@example.com",
      name: "Unknown User",
      rawClaims: { sub: "user-123", email: "nonexistent@example.com" },
    });

    const result = await validateExternalIdpToken(agent.id, FAKE_JWT);
    expect(result).toBeNull();
  });

  test("returns null when user is not a member of the gateway's organization", async ({
    makeOrganization,
    makeUser,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    // user exists but is NOT a member of org

    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://example.com/.well-known/jwks.json",
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    mockValidateJwt.mockResolvedValueOnce({
      sub: "user-123",
      email: user.email,
      name: user.name,
      rawClaims: { sub: "user-123", email: user.email },
    });

    const result = await validateExternalIdpToken(agent.id, FAKE_JWT);
    expect(result).toBeNull();
  });

  test("returns null when user has no shared teams with profile", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const otherUser = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    await makeMember(otherUser.id, org.id, { role: "member" });

    // user is in team1
    const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
    await makeTeamMember(team1.id, user.id);

    // agent is in team2 (user is NOT)
    const team2 = await makeTeam(org.id, otherUser.id, { name: "Team 2" });
    const agent = await makeAgent({
      organizationId: org.id,
      teams: [team2.id],
      scope: "team",
    });

    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://example.com/.well-known/jwks.json",
      },
    });
    // Link agent to identity provider
    const { AgentModel } = await import("@/models");
    await AgentModel.update(agent.id, { identityProviderId: idp.id });

    mockValidateJwt.mockResolvedValueOnce({
      sub: "user-123",
      email: user.email,
      name: user.name,
      rawClaims: { sub: "user-123", email: user.email },
    });

    const result = await validateExternalIdpToken(agent.id, FAKE_JWT);
    expect(result).toBeNull();
  });

  test("grants access when user has mcpGateway:admin permission", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const adminUser = await makeUser();
    await makeMember(adminUser.id, org.id, { role: "admin" });

    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://example.com/.well-known/jwks.json",
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
      teams: [], // no teams assigned
    });

    mockValidateJwt.mockResolvedValueOnce({
      sub: "admin-sub",
      email: adminUser.email,
      name: adminUser.name,
      rawClaims: { sub: "admin-sub", email: adminUser.email },
    });

    const result = await validateExternalIdpToken(agent.id, FAKE_JWT);

    expect(result).not.toBeNull();
    expect(result?.isUserToken).toBe(true);
    expect(result?.userId).toBe(adminUser.id);
    expect(result?.isExternalIdp).toBe(true);
    expect(result?.isOrganizationToken).toBe(false);
    expect(result?.organizationId).toBe(org.id);
    expect(result?.rawToken).toBe(FAKE_JWT);
  });

  test("grants access with permissionResource llmProxy for admin user", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const adminUser = await makeUser();
    await makeMember(adminUser.id, org.id, { role: "admin" });

    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://example.com/.well-known/jwks.json",
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
      teams: [],
    });

    mockValidateJwt.mockResolvedValueOnce({
      sub: "admin-sub",
      email: adminUser.email,
      name: adminUser.name,
      rawClaims: { sub: "admin-sub", email: adminUser.email },
    });

    const result = await validateExternalIdpToken(
      agent.id,
      FAKE_JWT,
      "llmProxy",
    );

    expect(result).not.toBeNull();
    expect(result?.isUserToken).toBe(true);
    expect(result?.userId).toBe(adminUser.id);
    expect(result?.isExternalIdp).toBe(true);
    expect(result?.organizationId).toBe(org.id);
  });

  test("grants access when user shares a team with the profile", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const team = await makeTeam(org.id, user.id, { name: "Shared Team" });
    await makeTeamMember(team.id, user.id);

    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://example.com/.well-known/jwks.json",
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
      teams: [team.id],
      scope: "team",
    });

    mockValidateJwt.mockResolvedValueOnce({
      sub: "user-sub",
      email: user.email,
      name: user.name,
      rawClaims: { sub: "user-sub", email: user.email },
    });

    const result = await validateExternalIdpToken(agent.id, FAKE_JWT);

    expect(result).not.toBeNull();
    expect(result?.isUserToken).toBe(true);
    expect(result?.userId).toBe(user.id);
    expect(result?.isExternalIdp).toBe(true);
    expect(result?.isOrganizationToken).toBe(false);
    expect(result?.organizationId).toBe(org.id);
    expect(result?.teamId).toBeNull();
  });
});

describe("buildKnowledgeSourcesDescription", () => {
  test("returns null when agent has no knowledge bases and no direct connectors", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const result = await buildKnowledgeSourcesDescription(agent.id);
    expect(result).toBeNull();
  });

  test("returns null for non-existent agent id", async () => {
    const result = await buildKnowledgeSourcesDescription(crypto.randomUUID());
    expect(result).toBeNull();
  });

  test("includes knowledge base name in description", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const { AgentKnowledgeBaseModel } = await import("@/models");
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const kb = await makeKnowledgeBase(org.id, { name: "Engineering Docs" });
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    expect(result).toContain("Engineering Docs");
    expect(result).toContain("Available knowledge bases:");
  });

  test("includes connector types in description", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { AgentKnowledgeBaseModel } = await import("@/models");
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const kb = await makeKnowledgeBase(org.id);
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
    await makeKnowledgeBaseConnector(kb.id, org.id, { connectorType: "jira" });

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    expect(result).toContain("jira");
    expect(result).toContain("Connected sources:");
  });

  test("includes multiple knowledge base names", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const { AgentKnowledgeBaseModel } = await import("@/models");
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const kb1 = await makeKnowledgeBase(org.id, { name: "Product KB" });
    const kb2 = await makeKnowledgeBase(org.id, { name: "Support KB" });
    await AgentKnowledgeBaseModel.assign(agent.id, kb1.id);
    await AgentKnowledgeBaseModel.assign(agent.id, kb2.id);

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    expect(result).toContain("Product KB");
    expect(result).toContain("Support KB");
  });

  test("deduplicates connector types", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { AgentKnowledgeBaseModel } = await import("@/models");
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const kb = await makeKnowledgeBase(org.id);
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
    await makeKnowledgeBaseConnector(kb.id, org.id, { connectorType: "jira" });
    await makeKnowledgeBaseConnector(kb.id, org.id, { connectorType: "jira" });

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    // "jira" should appear once in "Connected sources: jira."
    const match = result?.match(/Connected sources: (.+?)\./);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("jira");
  });

  test("includes multiple distinct connector types", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { AgentKnowledgeBaseModel } = await import("@/models");
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const kb = await makeKnowledgeBase(org.id);
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
    await makeKnowledgeBaseConnector(kb.id, org.id, { connectorType: "jira" });
    await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "confluence",
    });

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    expect(result).toContain("jira");
    expect(result).toContain("confluence");
  });

  test("includes base instruction text", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const { AgentKnowledgeBaseModel } = await import("@/models");
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const kb = await makeKnowledgeBase(org.id);
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    expect(result).toContain(
      "Query the organization's knowledge sources to retrieve relevant information",
    );
    expect(result).toContain("Pass the user's original query as-is");
  });

  test("omits 'Connected sources' when no connectors exist", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const { AgentKnowledgeBaseModel } = await import("@/models");
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const kb = await makeKnowledgeBase(org.id);
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    expect(result).not.toContain("Connected sources:");
  });

  test("returns description when agent has only direct connector assignments (no KB)", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { AgentConnectorAssignmentModel } = await import("@/models");
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "jira",
    });

    // Agent with direct connector but no KB assignment
    const agent = await makeAgent({ organizationId: org.id });
    await AgentConnectorAssignmentModel.assign(agent.id, connector.id);

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    expect(result).toContain("Connected sources:");
    expect(result).toContain("jira");
  });

  test("includes connector types from both KB and direct assignments", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { AgentKnowledgeBaseModel, AgentConnectorAssignmentModel } =
      await import("@/models");
    const org = await makeOrganization();

    // KB with a jira connector
    const kb = await makeKnowledgeBase(org.id, { name: "My KB" });
    await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "jira",
    });

    // Separate connector for direct assignment
    const directConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "confluence",
    });

    const agent = await makeAgent({ organizationId: org.id });
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
    await AgentConnectorAssignmentModel.assign(agent.id, directConnector.id);

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    expect(result).toContain("My KB");
    expect(result).toContain("jira");
    expect(result).toContain("confluence");
  });

  test("omits 'Available knowledge bases' when agent has only direct connectors", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { AgentConnectorAssignmentModel } = await import("@/models");
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
    });

    const agent = await makeAgent({ organizationId: org.id });
    await AgentConnectorAssignmentModel.assign(agent.id, connector.id);

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    expect(result).not.toContain("Available knowledge bases:");
    expect(result).toContain("Connected sources: github");
  });

  test("deduplicates connector types across KB and direct assignments", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { AgentKnowledgeBaseModel, AgentConnectorAssignmentModel } =
      await import("@/models");
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);

    // Same connector type from KB and direct assignment
    const kbConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "jira",
    });
    await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "jira",
    });

    const agent = await makeAgent({ organizationId: org.id });
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
    await AgentConnectorAssignmentModel.assign(agent.id, kbConnector.id);

    const result = await buildKnowledgeSourcesDescription(agent.id);

    expect(result).not.toBeNull();
    // "jira" should appear once in "Connected sources: jira."
    const match = result?.match(/Connected sources: (.+?)\./);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("jira");
  });
});

describe("createAgentServer tools/list", () => {
  test("returns branded built-in tool names through the MCP tools/list handler", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });

    await ToolModel.syncArchestraBuiltInCatalog({
      organization: {
        appName: "Acme Control Plane",
        iconLogo: null,
      },
    });
    await ToolModel.assignArchestraToolsToAgent(
      agent.id,
      "00000000-0000-4000-8000-000000000001",
    );

    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Control Plane",
      iconLogo: null,
    });

    const { server } = await createAgentServer(agent.id);
    const listToolsHandler = (
      server.server as unknown as {
        _requestHandlers: Map<string, TestListToolsHandler>;
      }
    )._requestHandlers.get("tools/list");

    expect(listToolsHandler).toBeDefined();
    if (!listToolsHandler) {
      throw new Error("Expected tools/list handler to be registered");
    }

    const response = await listToolsHandler({
      method: "tools/list",
      params: {},
    });

    expect(
      response.tools.some((tool) =>
        tool.name.startsWith("acme_control_plane__"),
      ),
    ).toBe(true);

    archestraMcpBranding.syncFromOrganization(null);
  });

  test("returns implicit search_tools and run_tool when toolExposureMode is search_and_run_only", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      toolExposureMode: "search_and_run_only",
    });

    const { server } = await createAgentServer(agent.id);
    const listToolsHandler = (
      server.server as unknown as {
        _requestHandlers: Map<string, TestListToolsHandler>;
      }
    )._requestHandlers.get("tools/list");

    expect(listToolsHandler).toBeDefined();
    if (!listToolsHandler) {
      throw new Error("Expected tools/list handler to be registered");
    }

    const response = await listToolsHandler({
      method: "tools/list",
      params: {},
    });

    expect(response.tools.map((tool) => tool.name).sort()).toEqual(
      [TOOL_RUN_TOOL_FULL_NAME, TOOL_SEARCH_TOOLS_FULL_NAME].sort(),
    );
    expect(
      response.tools.every((tool) => tool.inputSchema?.type === "object"),
    ).toBe(true);
    expect(
      response.tools.some(
        (tool) => tool.name === TOOL_ARTIFACT_WRITE_FULL_NAME,
      ),
    ).toBe(false);
  });

  test("keeps assigned skill and sandbox runtime tools top-level in search_and_run_only", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const adminUser = await makeUser();
    await makeMember(adminUser.id, org.id, { role: "admin" });
    const config = (await import("@/config")).default;
    const originalSandboxEnabled = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = true;

    try {
      const agent = await makeAgent({
        organizationId: org.id,
        toolExposureMode: "search_and_run_only",
      });
      await seedAndAssignArchestraTools(agent.id);

      const { server } = await createAgentServer(agent.id, {
        tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
        teamId: null,
        isOrganizationToken: false,
        organizationId: org.id,
        isUserToken: true,
        userId: adminUser.id,
      });
      const listToolsHandler = (
        server.server as unknown as {
          _requestHandlers: Map<string, TestListToolsHandler>;
        }
      )._requestHandlers.get("tools/list");

      expect(listToolsHandler).toBeDefined();
      if (!listToolsHandler) {
        throw new Error("Expected tools/list handler to be registered");
      }

      const response = await listToolsHandler({
        method: "tools/list",
        params: {},
      });
      const names = new Set(response.tools.map((tool) => tool.name));

      // meta tools and the skill/sandbox runtime path stay top-level
      for (const exposed of [
        TOOL_SEARCH_TOOLS_FULL_NAME,
        TOOL_RUN_TOOL_FULL_NAME,
        TOOL_LIST_SKILLS_FULL_NAME,
        TOOL_LOAD_SKILL_FULL_NAME,
        TOOL_RUN_COMMAND_FULL_NAME,
        TOOL_DOWNLOAD_FILE_FULL_NAME,
        TOOL_UPLOAD_FILE_FULL_NAME,
      ]) {
        expect(names.has(exposed)).toBe(true);
      }
      // authoring + unrelated tools remain hidden behind search_tools/run_tool
      for (const hidden of [
        TOOL_CREATE_SKILL_FULL_NAME,
        TOOL_UPDATE_SKILL_FULL_NAME,
        TOOL_WHOAMI_FULL_NAME,
      ]) {
        expect(names.has(hidden)).toBe(false);
      }
    } finally {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
    }
  });

  test("adds assigned MCP server context to search_tools description", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      toolExposureMode: "search_and_run_only",
    });
    const sentryCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "sentry",
    });
    await McpCatalogLabelModel.syncCatalogLabels(sentryCatalog.id, [
      { key: "app", value: "observability" },
      { key: "type", value: "errors" },
    ]);
    const sentryTool = await makeTool({
      catalogId: sentryCatalog.id,
      name: "sentry__list_issues",
      parameters: { type: "object", properties: {} },
    });
    await makeAgentTool(agent.id, sentryTool.id);

    const { server } = await createAgentServer(agent.id);
    const listToolsHandler = (
      server.server as unknown as {
        _requestHandlers: Map<string, TestListToolsHandler>;
      }
    )._requestHandlers.get("tools/list");

    expect(listToolsHandler).toBeDefined();
    if (!listToolsHandler) {
      throw new Error("Expected tools/list handler to be registered");
    }

    const response = await listToolsHandler({
      method: "tools/list",
      params: {},
    });
    const searchTool = response.tools.find(
      (tool) => tool.name === TOOL_SEARCH_TOOLS_FULL_NAME,
    );

    expect(searchTool?.description).toContain(
      "Available MCP servers for this gateway include: sentry",
    );
    expect(searchTool?.description).toContain("app:observability");
    expect(searchTool?.description).toContain("type:errors");
  });

  test("preserves user context when calling restricted Archestra tools", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const adminUser = await makeUser();
    await makeMember(adminUser.id, org.id, { role: "admin" });

    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await seedAndAssignArchestraTools(agent.id);

    const { server } = await createAgentServer(agent.id, {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
      teamId: null,
      isOrganizationToken: false,
      organizationId: org.id,
      isUserToken: true,
      userId: adminUser.id,
    });
    const callToolHandler = (
      server.server as unknown as {
        _requestHandlers: Map<
          string,
          (request: unknown) => Promise<{
            content: Array<{ type: string; text: string }>;
            isError?: boolean;
            structuredContent?: { items?: unknown[] };
          }>
        >;
      }
    )._requestHandlers.get("tools/call");

    expect(callToolHandler).toBeDefined();
    if (!callToolHandler) {
      throw new Error("Expected tools/call handler to be registered");
    }

    const response = await callToolHandler({
      method: "tools/call",
      params: {
        name: "archestra__get_mcp_servers",
        arguments: {},
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent?.items).toEqual(expect.any(Array));
    expect(response.content[0]?.text).not.toContain(
      "User context not available",
    );
  });

  test("forwards downstream elicitation requests to the MCP caller", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "workspace",
    });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "workspace__create_event",
      parameters: { type: "object", properties: {} },
    });
    await makeAgentTool(agent.id, tool.id);

    const executeToolCallForOwnerSpy = vi
      .spyOn(mcpClient, "executeToolCallForOwner")
      .mockResolvedValueOnce({
        id: "call_123",
        name: "workspace__create_event",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });

    try {
      const { server } = await createAgentServer(agent.id);
      const callToolHandler = (
        server.server as unknown as {
          _requestHandlers: Map<string, TestCallToolHandler>;
        }
      )._requestHandlers.get("tools/call");

      expect(callToolHandler).toBeDefined();
      if (!callToolHandler) {
        throw new Error("Expected tools/call handler to be registered");
      }

      const sendRequest = vi.fn().mockResolvedValue({
        action: "accept",
        content: { title: "Team sync" },
      });

      await callToolHandler(
        {
          method: "tools/call",
          params: {
            name: "workspace__create_event",
            arguments: {},
          },
        },
        { sendRequest },
      );

      const options = executeToolCallForOwnerSpy.mock.calls.at(-1)?.[3];
      const elicitationHandler = options?.elicitationHandler;
      expect(elicitationHandler).toBeTypeOf("function");

      const elicitationRequest = {
        method: "elicitation/create" as const,
        params: {
          mode: "form" as const,
          message: "Provide event details",
          requestedSchema: {
            type: "object" as const,
            properties: {
              title: { type: "string" as const },
            },
          },
        },
      };

      const result = await elicitationHandler?.(elicitationRequest, {
        signal: new AbortController().signal,
        requestId: "downstream-elicitation",
        sendNotification: vi.fn(),
        sendRequest: vi.fn(),
      });

      expect(sendRequest).toHaveBeenCalledWith(
        elicitationRequest,
        expect.any(Object),
      );
      expect(result).toEqual({
        action: "accept",
        content: { title: "Team sync" },
      });
    } finally {
      executeToolCallForOwnerSpy.mockRestore();
    }
  });

  test("advertises the healthy-connection tool when two assigned tools share a name across different catalog items", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    // Two different catalog items whose installs happen to share a display
    // name, producing two tool rows with the identical slugified name.
    const brokenCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "weather-fixture-broken",
      serverUrl: "https://weather.example.com/mcp",
    });
    await makeMcpServer({
      name: "Weather Fixture",
      catalogId: brokenCatalog.id,
      ownerId: user.id,
      localInstallationStatus: "success",
      oauthRefreshError: "refresh_failed",
    });
    const brokenTool = await ToolModel.createToolIfNotExists({
      name: "weather_fixture__get_weather",
      description: "broken connection",
      parameters: { type: "object", properties: {} },
      catalogId: brokenCatalog.id,
    });

    const healthyCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "weather-fixture-healthy",
      serverUrl: "https://weather.example.com/mcp",
    });
    await makeMcpServer({
      name: "Weather Fixture",
      catalogId: healthyCatalog.id,
      ownerId: user.id,
      localInstallationStatus: "success",
    });
    const healthyTool = await ToolModel.createToolIfNotExists({
      name: "weather_fixture__get_weather",
      description: "healthy connection",
      parameters: { type: "object", properties: {} },
      catalogId: healthyCatalog.id,
    });

    // Assign the broken one first so a naive "last one wins" dedupe would
    // keep it.
    await makeAgentTool(agent.id, brokenTool.id);
    await makeAgentTool(agent.id, healthyTool.id);

    const { server } = await createAgentServer(agent.id);
    const listToolsHandler = (
      server.server as unknown as {
        _requestHandlers: Map<string, TestListToolsHandler>;
      }
    )._requestHandlers.get("tools/list");

    expect(listToolsHandler).toBeDefined();
    if (!listToolsHandler) {
      throw new Error("Expected tools/list handler to be registered");
    }

    const response = await listToolsHandler({
      method: "tools/list",
      params: {},
    });

    const weatherTools = response.tools.filter(
      (tool) => tool.name === "weather_fixture__get_weather",
    );
    expect(weatherTools).toHaveLength(1);
    expect(weatherTools[0]?.description).toBe("healthy connection");
  });
});

describe("extractPassthroughHeaders", async () => {
  const { extractPassthroughHeaders } = await import("./mcp-gateway.utils");

  test("returns undefined when allowlist is null", () => {
    expect(extractPassthroughHeaders(null, { "x-foo": "bar" })).toBeUndefined();
  });

  test("returns undefined when allowlist is empty", () => {
    expect(extractPassthroughHeaders([], { "x-foo": "bar" })).toBeUndefined();
  });

  test("extracts matching headers from request", () => {
    const result = extractPassthroughHeaders(
      ["x-correlation-id", "x-tenant-id"],
      {
        "x-correlation-id": "abc-123",
        "x-tenant-id": "tenant-1",
        "x-other": "ignored",
      },
    );
    expect(result).toEqual({
      "x-correlation-id": "abc-123",
      "x-tenant-id": "tenant-1",
    });
  });

  test("returns undefined when no headers match", () => {
    const result = extractPassthroughHeaders(["x-correlation-id"], {
      "x-other": "value",
    });
    expect(result).toBeUndefined();
  });

  test("joins array header values with comma", () => {
    const result = extractPassthroughHeaders(["x-multi"], {
      "x-multi": ["val1", "val2"],
    });
    expect(result).toEqual({ "x-multi": "val1, val2" });
  });

  test("skips undefined header values", () => {
    const result = extractPassthroughHeaders(["x-present", "x-missing"], {
      "x-present": "yes",
    });
    expect(result).toEqual({ "x-present": "yes" });
  });
});
