import fs from "node:fs";
import path from "node:path";
import type { IdentityProviderOidcConfig } from "@shared";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0210_rename-provider-type-to-exchange-strategy.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith('UPDATE "identity_provider"'));

  for (const statement of statements) {
    await db.execute(sql.raw(`${statement};`));
  }
}

async function insertIdentityProvider(params: {
  id: string;
  organizationId: string;
  providerId: string;
  issuer: string;
  exchangeProviderType: "generic_oidc" | "keycloak" | "okta";
}) {
  const oidcConfig = {
    issuer: params.issuer,
    pkce: true,
    clientId: `${params.providerId}-client`,
    clientSecret: "test-secret",
    discoveryEndpoint: `${params.issuer}/.well-known/openid-configuration`,
    enterpriseManagedCredentials: {
      providerType: params.exchangeProviderType,
      clientId: `${params.providerId}-exchange-client`,
    },
  } as IdentityProviderOidcConfig & {
    enterpriseManagedCredentials: IdentityProviderOidcConfig["enterpriseManagedCredentials"] & {
      providerType: "generic_oidc" | "keycloak" | "okta";
    };
  };

  await db.insert(schema.identityProvidersTable).values({
    id: params.id,
    issuer: params.issuer,
    providerId: params.providerId,
    organizationId: params.organizationId,
    domain: `${params.providerId}.example.com`,
    oidcConfig: JSON.stringify(
      oidcConfig,
    ) as unknown as typeof schema.identityProvidersTable.$inferInsert.oidcConfig,
  });
}

async function getEnterpriseManagedCredentials(identityProviderId: string) {
  const [row] = await db
    .select({ oidcConfig: schema.identityProvidersTable.oidcConfig })
    .from(schema.identityProvidersTable)
    .where(sql`${schema.identityProvidersTable.id} = ${identityProviderId}`);

  const parsedConfig =
    typeof row.oidcConfig === "string"
      ? (JSON.parse(row.oidcConfig) as {
          enterpriseManagedCredentials?: Record<string, unknown>;
        })
      : ((row.oidcConfig ?? {}) as {
          enterpriseManagedCredentials?: Record<string, unknown>;
        });

  return parsedConfig.enterpriseManagedCredentials ?? {};
}

describe("0210 migration: providerType to exchangeStrategy rename", () => {
  test("renames legacy providerType values to exchangeStrategy values", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();

    await insertIdentityProvider({
      id: "idp-generic-0210",
      organizationId: organization.id,
      providerId: "generic-0210",
      issuer: "https://idp.example.com/oauth2/default",
      exchangeProviderType: "generic_oidc",
    });
    await insertIdentityProvider({
      id: "idp-keycloak-0210",
      organizationId: organization.id,
      providerId: "keycloak-0210",
      issuer: "https://idp.example.com/realms/demo",
      exchangeProviderType: "keycloak",
    });
    await insertIdentityProvider({
      id: "idp-okta-0210",
      organizationId: organization.id,
      providerId: "okta-0210",
      issuer: "https://example.okta.com/oauth2/default",
      exchangeProviderType: "okta",
    });

    await runMigration();

    await expect(
      getEnterpriseManagedCredentials("idp-generic-0210"),
    ).resolves.toMatchObject({
      exchangeStrategy: "rfc8693",
      clientId: "generic-0210-exchange-client",
    });
    await expect(
      getEnterpriseManagedCredentials("idp-keycloak-0210"),
    ).resolves.toMatchObject({
      exchangeStrategy: "rfc8693",
      clientId: "keycloak-0210-exchange-client",
    });
    await expect(
      getEnterpriseManagedCredentials("idp-okta-0210"),
    ).resolves.toMatchObject({
      exchangeStrategy: "okta_managed",
      clientId: "okta-0210-exchange-client",
    });

    const genericCredentials =
      await getEnterpriseManagedCredentials("idp-generic-0210");
    const keycloakCredentials =
      await getEnterpriseManagedCredentials("idp-keycloak-0210");
    const oktaCredentials =
      await getEnterpriseManagedCredentials("idp-okta-0210");

    expect(genericCredentials.providerType).toBeUndefined();
    expect(keycloakCredentials.providerType).toBeUndefined();
    expect(oktaCredentials.providerType).toBeUndefined();
  });
});
