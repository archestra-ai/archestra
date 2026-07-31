import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { softDelete } from "@/database/soft-delete";
import { handleSoftDeletePurge } from "@/task-queue/handlers/soft-delete-purge-handler";
import { test } from "@/test";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Soft-delete an agent and backdate the deletion by `ageDays`. */
async function deleteAgentDaysAgo(agentId: string, ageDays: number) {
  await softDelete(db, schema.agentsTable, eq(schema.agentsTable.id, agentId));
  await db
    .update(schema.agentsTable)
    .set({ deletedAt: new Date(Date.now() - ageDays * DAY_MS) })
    .where(eq(schema.agentsTable.id, agentId));
}

async function survivingAgentIds(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: schema.agentsTable.id })
    .from(schema.agentsTable)
    .where(inArray(schema.agentsTable.id, ids));
  return rows.map((row) => row.id);
}

async function setRetention(
  organizationId: string,
  values: { retentionDays?: number; autoPurgeEnabled?: boolean },
) {
  await db
    .update(schema.organizationsTable)
    .set({
      ...(values.retentionDays !== undefined
        ? { softDeleteRetentionDays: values.retentionDays }
        : {}),
      ...(values.autoPurgeEnabled !== undefined
        ? { softDeleteAutoPurgeEnabled: values.autoPurgeEnabled }
        : {}),
    })
    .where(eq(schema.organizationsTable.id, organizationId));
}

describe("handleSoftDeletePurge", () => {
  // The shared setup restores the pristine config before and after every test,
  // so these assignments need no manual cleanup — but they must be re-applied
  // per test rather than once per file.
  beforeEach(() => {
    config.softDeletePurge.enabled = true;
    config.softDeletePurge.maxPerRun = 1_000;
  });

  test("purges only what is past the organization's retention window", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await setRetention(org.id, { retentionDays: 30 });
    const expired = await makeAgent({ organizationId: org.id });
    const recent = await makeAgent({ organizationId: org.id });
    const active = await makeAgent({ organizationId: org.id });
    await deleteAgentDaysAgo(expired.id, 40);
    await deleteAgentDaysAgo(recent.id, 5);

    await handleSoftDeletePurge();

    expect(await survivingAgentIds([expired.id, recent.id, active.id])).toEqual(
      expect.arrayContaining([recent.id, active.id]),
    );
    expect(await survivingAgentIds([expired.id])).toEqual([]);
  });

  test("keeps everything when the organization turns auto-purge off", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await setRetention(org.id, { retentionDays: 1, autoPurgeEnabled: false });
    const agent = await makeAgent({ organizationId: org.id });
    await deleteAgentDaysAgo(agent.id, 400);

    await handleSoftDeletePurge();

    expect(await survivingAgentIds([agent.id])).toEqual([agent.id]);
  });

  test("keeps everything when the deployment kill switch is off", async ({
    makeOrganization,
    makeAgent,
  }) => {
    config.softDeletePurge.enabled = false;
    const org = await makeOrganization();
    await setRetention(org.id, { retentionDays: 1 });
    const agent = await makeAgent({ organizationId: org.id });
    await deleteAgentDaysAgo(agent.id, 400);

    await handleSoftDeletePurge();

    expect(await survivingAgentIds([agent.id])).toEqual([agent.id]);
  });

  test("respects the per-run cap and drains the rest on the next run", async ({
    makeOrganization,
    makeAgent,
  }) => {
    // The backlog case: everything is already past the window when the feature
    // first ships, and the sweep must spread it over several runs rather than
    // purging it all at once.
    config.softDeletePurge.maxPerRun = 2;
    const org = await makeOrganization();
    await setRetention(org.id, { retentionDays: 30 });
    const agents = await Promise.all([
      makeAgent({ organizationId: org.id }),
      makeAgent({ organizationId: org.id }),
      makeAgent({ organizationId: org.id }),
      makeAgent({ organizationId: org.id }),
    ]);
    const ids = agents.map((agent) => agent.id);
    for (const [index, id] of ids.entries()) {
      // Distinct ages so "oldest first" is observable.
      await deleteAgentDaysAgo(id, 40 + index);
    }

    await handleSoftDeletePurge();
    const afterFirst = await survivingAgentIds(ids);
    expect(afterFirst).toHaveLength(2);
    // Oldest-first: the two most-aged deletions went, so the two youngest
    // remain — a capped run always makes progress on the longest-waiting rows.
    expect(afterFirst.sort()).toEqual([ids[0], ids[1]].sort());

    await handleSoftDeletePurge();
    expect(await survivingAgentIds(ids)).toEqual([]);
  });

  test("one organization's failure does not stop the others", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const healthy = await makeOrganization();
    await setRetention(healthy.id, { retentionDays: 30 });
    const agent = await makeAgent({ organizationId: healthy.id });
    await deleteAgentDaysAgo(agent.id, 90);

    // A second org with a soft-deleted row of its own; the sweep visits both in
    // one run, so a per-org error boundary is what keeps this one covered.
    const other = await makeOrganization();
    await setRetention(other.id, { retentionDays: 30 });
    const otherAgent = await makeAgent({ organizationId: other.id });
    await deleteAgentDaysAgo(otherAgent.id, 90);

    await handleSoftDeletePurge();

    expect(await survivingAgentIds([agent.id, otherAgent.id])).toEqual([]);
  });

  test("writes one purge audit record per entity, attributed to the system", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await setRetention(org.id, { retentionDays: 7 });
    const agent = await makeAgent({ organizationId: org.id, name: "Nightly" });
    await deleteAgentDaysAgo(agent.id, 30);

    await handleSoftDeletePurge();

    const records = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, agent.id));
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("agent.purged");
    expect(records[0].actorType).toBe("system");
    expect(records[0].actorId).toBeNull();
    expect(records[0].resourceName).toBe("Nightly");
  });
});
