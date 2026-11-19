import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0641_peaceful_wrecking_crew.sql"),
  "utf-8",
);

async function runDataMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) =>
      statement.includes('INSERT INTO "agent_identity_bindings"'),
    );
  expect(statements).toHaveLength(1);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function insertIdentityProvider(params: {
  id: string;
  organizationId: string;
  blueprintClientId: string | null;
}) {
  const oidcConfig = JSON.stringify({
    issuer: "https://login.microsoftonline.com/tenant/v2.0",
    pkce: true,
    clientId: "client",
    clientSecret: "secret",
    discoveryEndpoint:
      "https://login.microsoftonline.com/tenant/v2.0/.well-known/openid-configuration",
    enterpriseManagedCredentials:
      params.blueprintClientId === null
        ? {}
        : { entraAgentId: { blueprintClientId: params.blueprintClientId } },
  });
  await db.execute(sql`
    INSERT INTO "identity_provider" ("id", "issuer", "provider_id", "organization_id", "domain", "oidc_config")
    VALUES (${params.id}, 'https://login.microsoftonline.com/tenant/v2.0', ${params.id}, ${params.organizationId}, 'example.com', ${oidcConfig})
  `);
}

async function setEntraAgentIdentityId(agentId: string, value: string) {
  await db
    .update(schema.agentsTable)
    .set({ entraAgentIdentityId: value })
    .where(eq(schema.agentsTable.id, agentId));
}

async function bindingsOf(agentId: string) {
  return db
    .select({
      identityProviderId: schema.agentIdentityBindingsTable.identityProviderId,
      externalId: schema.agentIdentityBindingsTable.externalId,
    })
    .from(schema.agentIdentityBindingsTable)
    .where(eq(schema.agentIdentityBindingsTable.agentId, agentId));
}

describe("0641 migration: move Entra agent identities to bindings", () => {
  test("binds the identity on each provider of the agent's organization that has an Entra Agent ID blueprint", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    await insertIdentityProvider({
      id: "idp-0641-blueprint",
      organizationId: organization.id,
      blueprintClientId: "11111111-1111-1111-1111-111111111111",
    });
    await insertIdentityProvider({
      id: "idp-0641-no-blueprint",
      organizationId: organization.id,
      blueprintClientId: null,
    });
    await insertIdentityProvider({
      id: "idp-0641-blank-blueprint",
      organizationId: organization.id,
      blueprintClientId: "  ",
    });
    await insertIdentityProvider({
      id: "idp-0641-other-org",
      organizationId: otherOrganization.id,
      blueprintClientId: "22222222-2222-2222-2222-222222222222",
    });
    const agent = await makeAgent({ organizationId: organization.id });
    await setEntraAgentIdentityId(
      agent.id,
      "33333333-3333-3333-3333-333333333333",
    );

    await runDataMigration();

    await expect(bindingsOf(agent.id)).resolves.toEqual([
      {
        identityProviderId: "idp-0641-blueprint",
        externalId: "33333333-3333-3333-3333-333333333333",
      },
    ]);
  });

  test("gives an identity two agents held to the live agent, in any case", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await insertIdentityProvider({
      id: "idp-0641-duplicate",
      organizationId: organization.id,
      blueprintClientId: "11111111-1111-1111-1111-111111111111",
    });
    const trashed = await makeAgent({ organizationId: organization.id });
    const live = await makeAgent({ organizationId: organization.id });
    await setEntraAgentIdentityId(
      trashed.id,
      "44444444-4444-4444-4444-4444444444aa",
    );
    await setEntraAgentIdentityId(
      live.id,
      " 44444444-4444-4444-4444-4444444444AA ",
    );
    await db
      .update(schema.agentsTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.agentsTable.id, trashed.id));

    await runDataMigration();

    await expect(bindingsOf(trashed.id)).resolves.toEqual([]);
    await expect(bindingsOf(live.id)).resolves.toEqual([
      {
        identityProviderId: "idp-0641-duplicate",
        externalId: "44444444-4444-4444-4444-4444444444AA",
      },
    ]);
  });

  test("leaves agents without an Entra agent identity unbound", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await insertIdentityProvider({
      id: "idp-0641-unbound",
      organizationId: organization.id,
      blueprintClientId: "11111111-1111-1111-1111-111111111111",
    });
    const agent = await makeAgent({ organizationId: organization.id });
    await setEntraAgentIdentityId(agent.id, "  ");

    await runDataMigration();

    await expect(bindingsOf(agent.id)).resolves.toEqual([]);
  });
});
