import { pathToFileURL } from "node:url";
import db, { schema } from "@/database";
import {
  generateMockAgents,
  generateMockInteractions,
  generateMockTools,
} from "./mocks";

async function seedMockData() {
  console.log("\n🌱 Starting mock data seed...\n");

  // Step 0: Clean existing mock data (in correct order due to foreign keys)
  console.log("Cleaning existing data...");
  await db.delete(schema.interactionsTable);
  await db.delete(schema.dualLlmResultsTable);
  await db.delete(schema.toolInvocationPoliciesTable);
  await db.delete(schema.trustedDataPoliciesTable);
  await db.delete(schema.agentToolsTable);
  await db.delete(schema.toolsTable);
  await db.delete(schema.agentsTable);
  console.log("✅ Cleaned existing data");

  // Step 1: Create agents
  console.log("\nCreating agents...");
  const agentData = generateMockAgents();

  await db.insert(schema.agentsTable).values(agentData);
  console.log(`✅ Created ${agentData.length} agents`);

  // Step 2: Create tools linked to agents
  console.log("\nCreating tools...");
  const agentIds = agentData
    .map((agent) => agent.id)
    .filter((id): id is string => !!id);
  const toolData = generateMockTools(agentIds);

  await db.insert(schema.toolsTable).values(toolData);
  console.log(`✅ Created ${toolData.length} tools`);

  // Step 3: Create agent-tool relationships
  console.log("\nCreating agent-tool relationships...");
  const agentToolData = toolData.map((tool) => ({
    agentId: tool.agentId,
    toolId: tool.id,
    allowUsageWhenUntrustedDataIsPresent:
      tool.allowUsageWhenUntrustedDataIsPresent || false,
    toolResultTreatment: (tool.dataIsTrustedByDefault
      ? "trusted"
      : "untrusted") as "trusted" | "untrusted" | "sanitize_with_dual_llm",
  }));

  await db.insert(schema.agentToolsTable).values(agentToolData);
  console.log(`✅ Created ${agentToolData.length} agent-tool relationships`);

  // Step 4: Create 200 mock interactions
  console.log("\nCreating interactions...");

  // Group tools by agent for efficient lookup
  const toolsByAgent = new Map<string, typeof toolData>();
  for (const tool of toolData) {
    const existing = toolsByAgent.get(tool.agentId) || [];
    toolsByAgent.set(tool.agentId, [...existing, tool]);
  }

  const interactionData = generateMockInteractions(
    agentIds,
    toolsByAgent,
    200, // number of interactions
    0.3, // 30% block probability
  );

  // biome-ignore lint/suspicious/noExplicitAny: Mock data generation requires flexible interaction structure
  await db.insert(schema.interactionsTable).values(interactionData as any);
  console.log(`✅ Created ${interactionData.length} interactions`);

  // Show statistics
  const blockedCount = interactionData.filter((i) => {
    if ("choices" in i.response) {
      return i.response.choices[0]?.message?.refusal;
    }
    return false;
  }).length;
  console.log(`   - ${blockedCount} blocked by policy`);
  console.log(`   - ${interactionData.length - blockedCount} allowed`);
}

/**
 * CLI entry point for seeding the database
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedMockData()
    .then(() => {
      console.log("\n✅ Mock data seeded successfully!\n");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Error seeding database:", error);
      process.exit(1);
    });
}
