import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import { validateMCPGatewayToken } from "@/routes/mcp-gateway/utils";
import { runScopedResourcePermissionCutover } from "@/services/resource-permissions-cutover";
import { expect, test } from "@/test";

const statements = fs
  .readFileSync(
    path.join(__dirname, "0547_unify-oauth-client-scopes.sql"),
    "utf8",
  )
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

test("versioned upgrade preserves dynamic registrations' old A2A access without widening new tokens on startup", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: org.id, agentType: "agent" });
  const clientId = "https://client.example.com/metadata.json";
  await db.insert(schema.oauthClientsTable).values({
    id: crypto.randomUUID(),
    clientId,
    name: "Dynamic client",
    scopes: ["mcp"],
    redirectUris: ["https://client.example.com/callback"],
  });
  const token = "existing-dynamic-token";
  const expiresAt = new Date(Date.now() + 3600000);
  const old = await OAuthAccessTokenModel.create({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(token),
    clientId,
    userId: user.id,
    expiresAt,
    scopes: ["mcp"],
  });
  for (let run = 0; run < 2; run++)
    for (const statement of statements) await db.execute(sql.raw(statement));
  expect(
    (
      await db
        .select()
        .from(schema.oauthAccessTokensTable)
        .where(eq(schema.oauthAccessTokensTable.id, old.id))
    )[0].scopes,
  ).toEqual(["mcp", "a2a"]);
  expect(await validateMCPGatewayToken(agent.id, token, "a2a")).not.toBeNull();
  const narrow = "new-dynamic-token";
  await OAuthAccessTokenModel.create({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(narrow),
    clientId,
    userId: user.id,
    expiresAt,
    scopes: ["mcp"],
  });
  await runScopedResourcePermissionCutover();
  expect(await validateMCPGatewayToken(agent.id, narrow, "a2a")).toBeNull();
  const a2a = "new-a2a-token";
  await OAuthAccessTokenModel.create({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(a2a),
    clientId,
    userId: user.id,
    expiresAt,
    scopes: ["a2a"],
  });
  expect(await validateMCPGatewayToken(agent.id, a2a, "a2a")).not.toBeNull();
  expect(await validateMCPGatewayToken(agent.id, a2a)).toBeNull();
});
