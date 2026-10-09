import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db from "@/database";
import { LimitLabelModel } from "@/models/entity-labels";
import LimitModel from "@/models/limit";
import { expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0525_remove-llm-proxy-cost-limits.sql"),
  "utf-8",
);

test("removes active and retired proxy budgets and their usage while preserving other budgets", async ({
  makeOrganization,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const proxy = await makeAgent({
    organizationId: organization.id,
    agentType: "llm_proxy",
  });
  const retiredProxy = await makeAgent({
    organizationId: organization.id,
    agentType: "llm_proxy",
    deletedAt: new Date(),
  });
  const agent = await makeAgent({ organizationId: organization.id });
  const proxyLimits = [];
  for (const target of [proxy, retiredProxy]) {
    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: target.id,
      limitType: "token_cost",
      limitValue: 100,
      model: ["test-model"],
      labels: [{ key: "budget", value: "legacy" }],
    });
    expect(await LimitModel.getModelUsageBreakdown(limit.id)).toHaveLength(1);
    expect(await LimitLabelModel.getLabelsFor(limit.id)).toHaveLength(1);
    proxyLimits.push(limit);
  }
  const preserved = [];
  for (const target of [
    { entityType: "organization" as const, entityId: organization.id },
    { entityType: "agent" as const, entityId: agent.id },
  ]) {
    preserved.push(
      await LimitModel.create({
        ...target,
        limitType: "token_cost",
        limitValue: 200,
        model: ["test-model"],
      }),
    );
  }

  // Replaying an upgrade cleanup must also be safe after it has already run.
  await db.execute(sql.raw(migrationSql));
  await db.execute(sql.raw(migrationSql));

  for (const limit of proxyLimits) {
    expect(await LimitModel.findById(limit.id)).toBeNull();
    expect(await LimitModel.getModelUsageBreakdown(limit.id)).toEqual([]);
    expect(await LimitLabelModel.getLabelsFor(limit.id)).toEqual([]);
  }
  for (const limit of preserved) {
    expect(await LimitModel.findById(limit.id)).toMatchObject({
      limitValue: 200,
    });
    expect(await LimitModel.getModelUsageBreakdown(limit.id)).toHaveLength(1);
  }
});
