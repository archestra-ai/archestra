import fs from "node:fs";
import path from "node:path";
import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { sql } from "drizzle-orm";
import db from "@/database";
import AgentModel from "@/models/agent";
import ToolModel from "@/models/tool";
import { expect, test } from "@/test";

const statements = fs
  .readFileSync(path.join(__dirname, "0534_rename-appa-keeper.sql"), "utf8")
  .split("--> statement-breakpoint");

test("renames only the built-in identity and its delegation tools, preserving settings", async ({
  makeAgent,
}) => {
  const builtin = await makeAgent({
    name: "APPAdvisor",
    builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    systemPrompt: "Custom policy instructions",
  });
  const ordinary = await makeAgent({ name: "APPAdvisor" });
  const tool = await ToolModel.findOrCreateDelegationTool(builtin.id);
  for (let run = 0; run < 2; run++) {
    for (const statement of statements) await db.execute(sql.raw(statement));
  }
  expect(await AgentModel.findById(builtin.id)).toMatchObject({
    id: builtin.id,
    name: "APPA Keeper",
    systemPrompt: "Custom policy instructions",
    builtInAgentConfig: builtin.builtInAgentConfig,
  });
  expect(await AgentModel.findById(ordinary.id)).toMatchObject({
    name: ordinary.name,
  });
  expect(await ToolModel.findById(tool.id)).toMatchObject({
    name: "agent__appa_keeper",
    description: "Delegate task to agent: APPA Keeper",
    delegateToAgentId: builtin.id,
  });
});
