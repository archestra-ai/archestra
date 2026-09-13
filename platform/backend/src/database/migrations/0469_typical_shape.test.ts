import fs from "node:fs";
import { sql } from "drizzle-orm";
import db from "@/database";
import AgentModel from "@/models/agent";
import ClaudeCodeAccountModel from "@/models/claude-code-account";
import SecretModel from "@/models/secret";
import UserCredentialModel from "@/models/user-credential";
import { expect, test } from "@/test";

test("upgrades personal Claude accounts without reconnecting or tying them to an Agent", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const otherUser = await makeUser();
  const first = await makeAgent({ organizationId: organization.id });
  const second = await makeAgent({ organizationId: organization.id });
  const owner = { organizationId: organization.id, userId: user.id };
  const old = await UserCredentialModel.upsert({
    ...owner,
    agentId: first.id,
    key: "claude-code-account:old",
    value: "old",
  });
  const valid = await UserCredentialModel.upsert({
    ...owner,
    agentId: second.id,
    key: "claude-code-account:valid",
    value: "valid",
  });
  const expired = await UserCredentialModel.upsert({
    ...owner,
    agentId: first.id,
    key: "claude-code-account:expired",
    value: "expired",
  });
  const other = await UserCredentialModel.upsert({
    ...owner,
    userId: otherUser.id,
    agentId: first.id,
    key: "claude-code-account:other",
    value: "other",
  });
  const unrelated = await UserCredentialModel.upsert({
    ...owner,
    agentId: first.id,
    key: "EXAMPLE_TOKEN",
    value: "unrelated",
  });
  // Reconstruct pre-upgrade metadata; runtime models no longer write this shape.
  for (const [credential, expiresAt, updatedAt] of [
    [old, "2999-01-01T00:00:00.000Z", "2025-01-01"],
    [valid, "2999-01-01T00:00:00.000Z", "2025-02-01"],
    [expired, "2000-01-01T00:00:00.000Z", "2025-03-01"],
    [other, null, "2025-01-01"],
  ] as const) {
    const metadata = JSON.stringify({
      image: "example.test/claude:v1",
      models: [],
      expiresAt,
    });
    await db.execute(
      sql`UPDATE user_credentials SET metadata = ${metadata}::jsonb, updated_at = ${updatedAt}::timestamp WHERE id = ${credential.id}`,
    );
  }
  const migration = fs.readFileSync(
    new URL("./0469_typical_shape.sql", import.meta.url),
    "utf8",
  );
  const statements = migration.split("--> statement-breakpoint").slice(1);
  for (let pass = 0; pass < 2; pass++) {
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect((await ClaudeCodeAccountModel.find(owner))?.secretId).toBe(
      valid.secretId,
    );
    expect(
      (await ClaudeCodeAccountModel.find({ ...owner, userId: otherUser.id }))
        ?.secretId,
    ).toBe(other.secretId);
  }
  expect(
    await UserCredentialModel.listForAgentUser({ ...owner, agentId: first.id }),
  ).toEqual([unrelated]);
  expect(
    await UserCredentialModel.listForAgentUser({
      ...owner,
      agentId: second.id,
    }),
  ).toEqual([]);
  await AgentModel.delete(second.id);
  expect((await ClaudeCodeAccountModel.find(owner))?.secretId).toBe(
    valid.secretId,
  );
  expect(await SecretModel.findById(valid.secretId)).not.toBeNull();
});
