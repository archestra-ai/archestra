// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0494_cleanup-orphaned-personal-assistants.sql"),
  "utf-8",
);

describe("0494 orphaned personal assistants cleanup", () => {
  test("soft-deletes unowned seeded assistants while preserving active, shared, and custom agents", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const currentOwner = await makeUser();
    const formerOwner = await makeUser();
    const recipient = await makeUser();
    await makeMember(currentOwner.id, organization.id);
    await makeMember(recipient.id, organization.id);

    const seeded = {
      organizationId: organization.id,
      agentType: "agent" as const,
      name: "My Assistant",
      description: "Your personal chat assistant",
    };
    const active = await makeAgent({
      ...seeded,
      authorId: currentOwner.id,
      access: "personal",
    });
    const departed = await makeAgent({
      ...seeded,
      authorId: formerOwner.id,
      access: "personal",
    });
    const orphan = await makeAgent({
      ...seeded,
      authorId: formerOwner.id,
      access: "personal",
    });
    const shared = await makeAgent({
      ...seeded,
      authorId: formerOwner.id,
      access: { users: [recipient.id] },
    });
    const custom = await makeAgent({
      ...seeded,
      authorId: formerOwner.id,
      name: "Custom assistant",
      access: "personal",
    });
    await db
      .update(schema.agentsTable)
      .set({ authorId: null })
      .where(eq(schema.agentsTable.id, orphan.id));

    await db.execute(sql.raw(migrationSql));
    await db.execute(sql.raw(migrationSql));

    const rows = await db
      .select({
        id: schema.agentsTable.id,
        deletedAt: schema.agentsTable.deletedAt,
      })
      .from(schema.agentsTable);
    expect(rows.find((row) => row.id === active.id)?.deletedAt).toBeNull();
    expect(
      rows.find((row) => row.id === departed.id)?.deletedAt,
    ).not.toBeNull();
    expect(rows.find((row) => row.id === orphan.id)?.deletedAt).not.toBeNull();
    expect(rows.find((row) => row.id === shared.id)?.deletedAt).toBeNull();
    expect(rows.find((row) => row.id === custom.id)?.deletedAt).toBeNull();
  });
});
