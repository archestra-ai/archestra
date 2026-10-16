// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { resolveDefaultChatAgentId } from "@/services/apps/app-chat-conversation";
import { expect, test } from "@/test";

test("app fallback chooses the oldest accessible non-built-in agent after personal deletion", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const reader = await makeUser();
  const owner = await makeUser();
  await makeMember(reader.id, org.id);
  await makeMember(owner.id, org.id);
  const history = await makeAgent({
    organizationId: org.id,
    authorId: reader.id,
    agentType: "agent",
    access: "personal",
  });
  await db
    .update(schema.agentsTable)
    .set({ deletedAt: new Date() })
    .where(eq(schema.agentsTable.id, history.id));
  const first = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "org",
  });
  const second = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "org",
  });
  const hidden = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "personal",
  });
  const builtin = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "org",
  });
  await db
    .update(schema.agentsTable)
    .set({
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION },
    })
    .where(eq(schema.agentsTable.id, builtin.id));
  const foreign = await makeOrganization();
  const other = await makeAgent({
    organizationId: foreign.id,
    agentType: "agent",
    access: "org",
  });
  for (const agent of [hidden, builtin, other])
    await db
      .update(schema.agentsTable)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(schema.agentsTable.id, agent.id));
  for (const agent of [first, second])
    await db
      .update(schema.agentsTable)
      .set({ createdAt: new Date("2025-01-01T00:00:00Z") })
      .where(eq(schema.agentsTable.id, agent.id));
  const expected = [first.id, second.id].sort()[0];
  expect(
    await resolveDefaultChatAgentId({
      userId: reader.id,
      organizationId: org.id,
    }),
  ).toBe(expected);
});
