// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { OAUTH_TOKEN_TYPE } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { agentOwner } from "@/types";
import { resolveEnterpriseAssertion } from "./assertion-resolver";

describe("resolveEnterpriseAssertion", () => {
  test("uses MCP enterprise IdP config when the agent has no gateway IdP", async ({
    makeAgent,
    makeIdentityProvider,
    makeMember,
    makeOrganization,
    makeAccount,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const identityProvider = await makeIdentityProvider(org.id, {
      providerId: "EntraOBOE2E",
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      oidcConfig: {
        clientId: "archestra-entra-app",
        enterpriseManagedCredentials: {
          exchangeStrategy: "entra_obo",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: null,
    });

    await makeAccount(user.id, {
      accountId: "acct-entra-linked",
      providerId: identityProvider.providerId,
      accessToken: "linked-entra-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    });

    const result = await resolveEnterpriseAssertion({
      owner: agentOwner(agent.id),
      identityProviderId: identityProvider.id,
      tokenAuth: {
        tokenId: "user-token",
        teamId: null,
        isOrganizationToken: false,
        userId: user.id,
      },
    });

    expect(result).toEqual({
      assertion: "linked-entra-access-token",
      identityProviderId: identityProvider.id,
      providerId: identityProvider.providerId,
    });
  });
});
