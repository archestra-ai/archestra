import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import InteractionModel from "./interaction";
import { interactionBelongsToOrganization } from "./log-organization";

test("organization filtering preserves mixed-owner isolation without per-row owner reads", async ({
  makeOrganization,
  makeAgent,
  makeApp,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
}) => {
  const local = await makeOrganization();
  const other = await makeOrganization();
  const agent = await makeAgent({ organizationId: local.id });
  const foreignAgent = await makeAgent({ organizationId: other.id });
  const app = await makeApp({ organizationId: local.id });
  const foreignApp = await makeApp({ organizationId: other.id });
  const kb = await makeKnowledgeBase(local.id);
  const connector = await makeKnowledgeBaseConnector(kb.id, local.id);
  const foreignKb = await makeKnowledgeBase(other.id);
  const foreignConnector = await makeKnowledgeBaseConnector(
    foreignKb.id,
    other.id,
  );
  const expected: string[] = [];
  const ownerships = [
    { profileId: agent.id },
    { profileId: null, appId: app.id },
    { profileId: null, connectorId: connector.id },
    { profileId: agent.id, appId: app.id, connectorId: connector.id },
    { profileId: foreignAgent.id },
    { profileId: agent.id, appId: foreignApp.id },
    { profileId: agent.id, connectorId: foreignConnector.id },
    { profileId: null },
  ];
  for (const [index, ownership] of ownerships.entries()) {
    const row = await InteractionModel.create({
      ...ownership,
      type: "openai:chatCompletions",
      request: { model: "example", messages: [] },
      response: {
        id: "example",
        object: "chat.completion",
        created: 0,
        model: "example",
        choices: [],
      },
    });
    if (index < 4) expected.push(row.id);
  }
  await drainBackgroundWork();
  const query = db
    .select({ id: schema.interactionsTable.id })
    .from(schema.interactionsTable)
    .where(interactionBelongsToOrganization(local.id));
  expect((await query).map((row) => row.id).sort()).toEqual(expected.sort());
  const result = await db.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`);
  const plan = (result.rows[0] as Record<string, unknown>)["QUERY PLAN"];
  // Inspect actual execution rather than elapsed time: owner-table work must
  // not repeat once for each interaction in a growing log.
  const ownerReads: PlanNode[] = [];
  const collect = (node: PlanNode) => {
    if (
      ["agents", "apps", "knowledge_base_connectors"].includes(
        node["Relation Name"] ?? "",
      )
    )
      ownerReads.push(node);
    for (const child of node.Plans ?? []) collect(child);
  };
  collect((plan as Array<{ Plan: PlanNode }>)[0].Plan);
  expect(ownerReads.length).toBeGreaterThan(0);
  expect(ownerReads.every((node) => node["Actual Loops"] <= 1)).toBe(true);
});

// === internals ===
type PlanNode = {
  "Relation Name"?: string;
  "Actual Loops": number;
  Plans?: PlanNode[];
};
