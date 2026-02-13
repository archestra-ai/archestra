import { createHash } from "node:crypto";
import { OAUTH_TOKEN_ID_PREFIX } from "@shared";
import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { TeamTokenModel, UserTokenModel } from "@/models";
import type { JwksValidationResult } from "@/services/jwks-validator";
import { describe, expect, test } from "@/test";

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      enterpriseLicenseActivated: true,
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
  validateMCPGatewayToken,
  validateOAuthToken,
  validateExternalIdpToken,
} = await import("./mcp-gateway.utils");

describe("validateMCPGatewayToken", () => {
  describe("invalid token scenarios", () => {
    test("returns null for invalid token", async () => {
      const result = await validateMCPGatewayToken(
        crypto.randomUUID(),
        "archestra_invalidtoken1234567890ab",
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
      const agent = await makeAgent({ teams: [team.id] });

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
      const agent = await makeAgent({ teams: [team2.id] });

      // Token for team1
      const { value } = await TeamTokenModel.create({
        organizationId: org.id,
        name: "Team 1 Token",
        teamId: team1.id,
      });

      const result = await validateMCPGatewayToken(agent.id, value);
      expect(result).toBeNull();
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
      const agent = await makeAgent({ teams: [team.id] });

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
      const agent = await makeAgent({ teams: [team2.id] });

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
      const agent = await makeAgent({ teams: [team.id] });

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
      const agent = await makeAgent({ teams: [team.id] });

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
      const agent = await makeAgent({ teams: [team.id] });

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

    test("validateMCPGatewayToken skips OAuth validation for archestra_ prefixed tokens", async () => {
      // archestra_ prefixed tokens should never reach validateOAuthToken
      const result = await validateMCPGatewayToken(
        crypto.randomUUID(),
        "archestra_fake_token_that_does_not_exist",
      );
      // Returns null because the archestra_ token is invalid, but importantly
      // it should NOT have tried OAuth token validation
      expect(result).toBeNull();
    });

    test("validateMCPGatewayToken tries OAuth validation for non-archestra tokens", async () => {
      // A non-archestra token should try OAuth validation path and return null
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

  test("grants access when user has profile:admin permission", async ({
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
