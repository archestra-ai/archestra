import { withDbTransaction } from "@/database";
import ConnectionSetupModel, {
  CONNECTION_SETUP_TOKEN_PREFIX,
  CONNECTION_SETUP_TOKEN_TTL_MS,
} from "@/models/connection-setup";
import { describe, expect, test } from "@/test";

function futureExpiry(): Date {
  return new Date(Date.now() + CONNECTION_SETUP_TOKEN_TTL_MS);
}

describe("ConnectionSetupModel", () => {
  test("create returns a raw token that is never stored", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const { setup, rawToken } = await ConnectionSetupModel.create({
      organizationId: org.id,
      userId: user.id,
      clientId: "claude-code",
      baseUrl: "http://localhost:9000",
      includeSkills: false,
      expiresAt: futureExpiry(),
    });

    expect(rawToken.startsWith(CONNECTION_SETUP_TOKEN_PREFIX)).toBe(true);
    expect(setup.tokenHash).not.toContain(rawToken);
    expect(setup.tokenStart).toBe(rawToken.slice(0, 22));
    expect(setup.consumedAt).toBeNull();
    expect(setup.clientId).toBe("claude-code");
  });

  test("claimByToken consumes the setup exactly once", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const { rawToken } = await ConnectionSetupModel.create({
      organizationId: org.id,
      userId: user.id,
      clientId: "codex",
      baseUrl: "http://localhost:9000",
      includeSkills: false,
      expiresAt: futureExpiry(),
    });

    const first = await withDbTransaction((tx) =>
      ConnectionSetupModel.claimByToken({ rawToken, tx }),
    );
    expect(first).not.toBeNull();
    expect(first?.consumedAt).toBeInstanceOf(Date);

    const second = await withDbTransaction((tx) =>
      ConnectionSetupModel.claimByToken({ rawToken, tx }),
    );
    expect(second).toBeNull();
  });

  test("concurrent claims: exactly one wins", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const { rawToken } = await ConnectionSetupModel.create({
      organizationId: org.id,
      userId: user.id,
      clientId: "claude-code",
      baseUrl: "http://localhost:9000",
      includeSkills: false,
      expiresAt: futureExpiry(),
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withDbTransaction((tx) =>
          ConnectionSetupModel.claimByToken({ rawToken, tx }),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("claim rolls back with the surrounding transaction (token not burned)", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const { rawToken } = await ConnectionSetupModel.create({
      organizationId: org.id,
      userId: user.id,
      clientId: "claude-code",
      baseUrl: "http://localhost:9000",
      includeSkills: false,
      expiresAt: futureExpiry(),
    });

    await expect(
      withDbTransaction(async (tx) => {
        const claimed = await ConnectionSetupModel.claimByToken({
          rawToken,
          tx,
        });
        expect(claimed).not.toBeNull();
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");

    const retry = await withDbTransaction((tx) =>
      ConnectionSetupModel.claimByToken({ rawToken, tx }),
    );
    expect(retry).not.toBeNull();
  });

  test("claimByToken rejects expired and unknown tokens", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const { rawToken } = await ConnectionSetupModel.create({
      organizationId: org.id,
      userId: user.id,
      clientId: "cursor",
      baseUrl: "http://localhost:9000",
      includeSkills: false,
      expiresAt: new Date(Date.now() - 1000),
    });

    const expired = await withDbTransaction((tx) =>
      ConnectionSetupModel.claimByToken({ rawToken, tx }),
    );
    expect(expired).toBeNull();
    // but the row is still discoverable for 404-vs-410 decisions
    expect(await ConnectionSetupModel.findByToken(rawToken)).not.toBeNull();

    const unknown = await withDbTransaction((tx) =>
      ConnectionSetupModel.claimByToken({
        rawToken: `${CONNECTION_SETUP_TOKEN_PREFIX}does-not-exist`,
        tx,
      }),
    );
    expect(unknown).toBeNull();
    expect(
      await ConnectionSetupModel.findByToken(
        `${CONNECTION_SETUP_TOKEN_PREFIX}does-not-exist`,
      ),
    ).toBeNull();
  });

  test("stores selections incl. references and skill ids", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
    });

    const { setup, rawToken } = await ConnectionSetupModel.create({
      organizationId: org.id,
      userId: user.id,
      clientId: "copilot-cli",
      baseUrl: "https://archestra.example.com",
      mcpGatewayId: gateway.id,
      llmProxyId: proxy.id,
      provider: "anthropic",
      includeSkills: false,
      expiresAt: futureExpiry(),
    });

    const found = await ConnectionSetupModel.findByToken(rawToken);
    expect(found?.id).toBe(setup.id);
    expect(found?.mcpGatewayId).toBe(gateway.id);
    expect(found?.llmProxyId).toBe(proxy.id);
    expect(found?.provider).toBe("anthropic");
    expect(
      await ConnectionSetupModel.getSkillIds({ connectionSetupId: setup.id }),
    ).toEqual([]);
  });
});
