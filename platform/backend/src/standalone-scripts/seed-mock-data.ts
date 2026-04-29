import { pathToFileURL } from "node:url";
import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import db, { initializeDatabase, schema } from "@/database";
import { seedDefaultUserAndOrg } from "@/database/seed";
import logger from "@/logging";
import {
  AgentLabelModel,
  AgentModel,
  AgentTeamModel,
  OrganizationModel,
  TeamModel,
} from "@/models";
import {
  generateMockAgents,
  generateMockInteractions,
  generateMockTools,
  type MockAgentWithTeams,
} from "./mocks";

// Set to true to create tools and interactions
// Don't delete this const for development convenience
const CREATE_TOOLS_AND_INTERACTIONS = false;

async function seedMockData() {
  logger.info("\n🌱 Starting mock data seed...\n");

  await initializeDatabase();

  // Step 0: Clean existing mock data (in correct order due to foreign keys)
  logger.info("Cleaning existing data...");
  for (const table of Object.values(schema)) {
    await db.delete(table);
  }
  logger.info("✅ Cleaned existing data");

  // Step 1: Create users
  const defaultAdmin = await seedDefaultUserAndOrg();
  const admin2User = await seedDefaultUserAndOrg({
    email: "admin-2@example.com",
    password: "password",
    role: ADMIN_ROLE_NAME,
    name: "Admin-2",
  });
  const editorUser = await seedDefaultUserAndOrg({
    email: "editor@gmail.com",
    password: "password",
    role: EDITOR_ROLE_NAME,
    name: "Editor",
  });
  const member1User = await seedDefaultUserAndOrg({
    email: "member-1@example.com",
    password: "password",
    role: MEMBER_ROLE_NAME,
    name: "Member-1",
  });
  const member2User = await seedDefaultUserAndOrg({
    email: "member-2@example.com",
    password: "password",
    role: MEMBER_ROLE_NAME,
    name: "Member-2",
  });

  // Step 2: Create teams and add members
  const org = await OrganizationModel.getOrCreateDefaultOrganization();

  const teamA = await TeamModel.create({
    name: "TeamA",
    description: "Team A for testing",
    organizationId: org.id,
    createdBy: defaultAdmin.id,
  });
  const teamB = await TeamModel.create({
    name: "TeamB",
    description: "Team B for testing",
    organizationId: org.id,
    createdBy: defaultAdmin.id,
  });
  const managementTeam = await TeamModel.create({
    name: "Management Team",
    description:
      "Management department responsible for overseeing the platform",
    organizationId: org.id,
    createdBy: admin2User.id,
  });
  const marketingTeam = await TeamModel.create({
    name: "Marketing Team",
    description: "Marketing department responsible for promoting the platform",
    organizationId: org.id,
    createdBy: admin2User.id,
  });
  const engineeringTeam = await TeamModel.create({
    name: "Engineering Team",
    description: "Engineering department",
    organizationId: org.id,
    createdBy: defaultAdmin.id,
  });

  // Add members to teams
  await TeamModel.addMember(teamA.id, defaultAdmin.id, ADMIN_ROLE_NAME);
  await TeamModel.addMember(teamA.id, editorUser.id, MEMBER_ROLE_NAME);
  await TeamModel.addMember(teamB.id, defaultAdmin.id, ADMIN_ROLE_NAME);
  await TeamModel.addMember(teamB.id, member1User.id, MEMBER_ROLE_NAME);
  await TeamModel.addMember(
    managementTeam.id,
    defaultAdmin.id,
    ADMIN_ROLE_NAME,
  );
  await TeamModel.addMember(managementTeam.id, admin2User.id, ADMIN_ROLE_NAME);
  await TeamModel.addMember(marketingTeam.id, defaultAdmin.id, ADMIN_ROLE_NAME);
  await TeamModel.addMember(marketingTeam.id, member1User.id, MEMBER_ROLE_NAME);
  await TeamModel.addMember(marketingTeam.id, member2User.id, MEMBER_ROLE_NAME);
  await TeamModel.addMember(
    engineeringTeam.id,
    defaultAdmin.id,
    ADMIN_ROLE_NAME,
  );
  await TeamModel.addMember(
    engineeringTeam.id,
    editorUser.id,
    MEMBER_ROLE_NAME,
  );

  logger.info("✅ Created 5 teams with members");

  // Step 3: Create agents, MCP gateways, and LLM proxies with ownership patterns
  logger.info("\nCreating agents, gateways, and proxies...");

  // Always recreate default agents
  await AgentModel.getLLMProxyOrCreateDefault();

  const sharedUsers = [
    { id: editorUser.id, name: "editor" },
    { id: defaultAdmin.id, name: "admin" },
  ];
  const sharedTeamConfig = [
    { teamId: teamA.id, teamName: "TeamA" },
    { teamId: teamB.id, teamName: "TeamB" },
  ];

  // Agents: 30 editor-personal, 40 admin-personal, 50 TeamA, 60 TeamB, 70 org
  const mockAgents = generateMockAgents({
    organizationId: org.id,
    agentType: "agent",
    namePrefix: "agent",
    users: sharedUsers.map((u) => ({
      ...u,
      personalCount: u.name === "editor" ? 30 : 40,
    })),
    teamConfig: [
      { ...sharedTeamConfig[0], count: 50 },
      { ...sharedTeamConfig[1], count: 60 },
    ],
    orgCount: 70,
  });

  // MCP Gateways: 15 editor-personal, 20 admin-personal, 25 TeamA, 30 TeamB, 35 org
  const mockGateways = generateMockAgents({
    organizationId: org.id,
    agentType: "mcp_gateway",
    namePrefix: "gw",
    users: sharedUsers.map((u) => ({
      ...u,
      personalCount: u.name === "editor" ? 15 : 20,
    })),
    teamConfig: [
      { ...sharedTeamConfig[0], count: 25 },
      { ...sharedTeamConfig[1], count: 30 },
    ],
    orgCount: 35,
  });

  // LLM Proxies: 10 editor-personal, 15 admin-personal, 20 TeamA, 25 TeamB, 30 org
  const mockProxies = generateMockAgents({
    organizationId: org.id,
    agentType: "llm_proxy",
    namePrefix: "proxy",
    users: sharedUsers.map((u) => ({
      ...u,
      personalCount: u.name === "editor" ? 10 : 15,
    })),
    teamConfig: [
      { ...sharedTeamConfig[0], count: 20 },
      { ...sharedTeamConfig[1], count: 25 },
    ],
    orgCount: 30,
  });

  const allMockEntities: MockAgentWithTeams[] = [
    ...mockAgents,
    ...mockGateways,
    ...mockProxies,
  ];

  // Insert all (without teamIds field which isn't a DB column)
  const allRows = allMockEntities.map(({ teamIds: _, ...row }) => row);
  await db.insert(schema.agentsTable).values(allRows);
  logger.info(
    `✅ Created ${mockAgents.length} agents, ${mockGateways.length} gateways, ${mockProxies.length} proxies`,
  );

  // Assign teams to team-scoped entries
  for (const entity of allMockEntities) {
    if (entity.teamIds.length > 0) {
      await AgentTeamModel.assignTeamsToAgent(entity.id, entity.teamIds);
    }
  }
  logger.info("✅ Assigned teams to team-scoped entities");

  // Step: Assign labels to agents for testing label-based filtering
  const labelDefs: {
    key: string;
    values: string[];
    frequency: number; // 1 = every entity, 2 = every 2nd, etc.
  }[] = [
    {
      key: "region",
      values: [
        "us-east-1",
        "us-east-2",
        "us-west-1",
        "us-west-2",
        "eu-west-1",
        "eu-west-2",
        "eu-central-1",
        "ap-southeast-1",
        "ap-southeast-2",
        "ap-northeast-1",
        "sa-east-1",
        "ca-central-1",
      ],
      frequency: 1,
    },
    {
      key: "environment",
      values: ["production", "staging", "development", "qa", "sandbox"],
      frequency: 1,
    },
    {
      key: "team",
      values: ["frontend", "backend", "platform", "ml", "infra", "data", "sre"],
      frequency: 2,
    },
    {
      key: "tier",
      values: ["free", "starter", "pro", "enterprise"],
      frequency: 3,
    },
    {
      key: "compliance",
      values: ["soc2", "hipaa", "gdpr", "pci-dss", "iso27001"],
      frequency: 4,
    },
    {
      key: "cost-center",
      values: ["engineering", "product", "sales", "marketing", "support"],
      frequency: 3,
    },
    {
      key: "priority",
      values: ["critical", "high", "medium", "low"],
      frequency: 2,
    },
    {
      key: "owner",
      values: ["alice", "bob", "charlie", "diana", "eve", "frank"],
      frequency: 5,
    },
  ];

  for (let i = 0; i < allMockEntities.length; i++) {
    const entity = allMockEntities[i];
    const labels: {
      key: string;
      value: string;
      keyId: string;
      valueId: string;
    }[] = [];

    for (const def of labelDefs) {
      if (i % def.frequency === 0) {
        labels.push({
          key: def.key,
          value: def.values[i % def.values.length],
          keyId: "",
          valueId: "",
        });
      }
    }

    await AgentLabelModel.syncAgentLabels(entity.id, labels);
  }
  logger.info(
    `✅ Assigned labels to ${allMockEntities.length} entities (${labelDefs.map((d) => d.key).join(", ")})`,
  );

  // Note: Archestra tools are no longer auto-assigned to agents.
  // They are now managed like any other MCP server tools and must be explicitly assigned.

  if (CREATE_TOOLS_AND_INTERACTIONS === false) return;

  // Step 4: Create tools linked to agents
  logger.info("\nCreating tools...");
  const agentIds = allRows
    .map((row) => row.id)
    .filter((id): id is string => !!id);
  const toolData = generateMockTools(agentIds);

  await db.insert(schema.toolsTable).values(toolData);
  logger.info(`✅ Created ${toolData.length} tools`);

  // Step 5: Create agent-tool relationships
  logger.info("\nCreating agent-tool relationships...");
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
  logger.info(`✅ Created ${agentToolData.length} agent-tool relationships`);

  // Step 6: Create 200 mock interactions
  logger.info("\nCreating interactions...");

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
  logger.info(`✅ Created ${interactionData.length} interactions`);

  // Show statistics
  const blockedCount = interactionData.filter((i) => {
    const response = i.response as { choices?: Array<{ message?: unknown }> };
    if (Array.isArray(response.choices)) {
      const message = response.choices[0]?.message;
      return (
        !!message &&
        typeof message === "object" &&
        "refusal" in message &&
        Boolean(message.refusal)
      );
    }
    return false;
  }).length;
  logger.info(`   - ${blockedCount} blocked by policy`);
  logger.info(`   - ${interactionData.length - blockedCount} allowed`);
}

/**
 * CLI entry point for seeding the database
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedMockData()
    .then(() => {
      logger.info("\n✅ Mock data seeded successfully!\n");
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ err: error }, "\n❌ Error seeding database:");
      process.exit(1);
    });
}
