import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { AgentModel } from "@/models";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0215_clear-agent-identity-provider.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith('UPDATE "agents"'));

  for (const statement of statements) {
    await db.execute(sql.raw(`${statement};`));
  }
}

async function setIdentityProviderForAgents(
  agentIds: string[],
  identityProviderId: string,
) {
  await db
    .update(schema.agentsTable)
    .set({ identityProviderId })
    .where(inArray(schema.agentsTable.id, agentIds));
}

async function getAgentIdentityProviderId(agentId: string) {
  const [agent] = await db
    .select({ identityProviderId: schema.agentsTable.identityProviderId })
    .from(schema.agentsTable)
    .where(eq(schema.agentsTable.id, agentId));

  return agent?.identityProviderId;
}

describe("0215 migration: clear agent identity provider config", () => {
  test("clears identity provider config only from internal agents", async ({
    makeAgent,
    makeInternalAgent,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const identityProviderId = "idp-0215";

    await db.insert(schema.identityProvidersTable).values({
      id: identityProviderId,
      issuer: "https://idp.example.com",
      providerId: "provider-0215",
      organizationId: organization.id,
      domain: "idp.example.com",
    });

    const internalAgent = await makeInternalAgent({
      organizationId: organization.id,
    });
    const profile = await makeAgent({
      organizationId: organization.id,
      agentType: "profile",
    });
    const mcpGateway = await makeAgent({
      organizationId: organization.id,
      agentType: "mcp_gateway",
    });
    const llmProxy = await makeAgent({
      organizationId: organization.id,
      agentType: "llm_proxy",
    });

    await setIdentityProviderForAgents(
      [internalAgent.id, profile.id, mcpGateway.id, llmProxy.id],
      identityProviderId,
    );

    await runMigration();

    await expect(
      getAgentIdentityProviderId(internalAgent.id),
    ).resolves.toBeNull();
    await expect(getAgentIdentityProviderId(profile.id)).resolves.toBe(
      identityProviderId,
    );
    await expect(getAgentIdentityProviderId(mcpGateway.id)).resolves.toBe(
      identityProviderId,
    );
    await expect(getAgentIdentityProviderId(llmProxy.id)).resolves.toBe(
      identityProviderId,
    );
  });

  test("leaves internal agents without identity provider config unchanged", async ({
    makeInternalAgent,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const internalAgent = await makeInternalAgent({
      organizationId: organization.id,
    });

    await expect(AgentModel.findById(internalAgent.id)).resolves.toMatchObject({
      identityProviderId: null,
    });

    await runMigration();

    await expect(
      getAgentIdentityProviderId(internalAgent.id),
    ).resolves.toBeNull();
  });
});
