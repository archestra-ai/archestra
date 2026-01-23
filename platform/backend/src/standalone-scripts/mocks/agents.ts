import { randomUUID } from "node:crypto";
import { randomBool, randomElement } from "./utils";

const AGENT_NAME_TEMPLATES = [
  "Data Analyst",
  "API Monitor",
  "Security Scanner",
  "Performance Optimizer",
  "Code Reviewer",
  "Content Moderator",
  "Quality Assurance",
  "System Administrator",
  "Database Manager",
  "Network Engineer",
  "Cloud Architect",
  "DevOps Specialist",
  "Frontend Developer",
  "Backend Developer",
  "Full Stack Engineer",
  "Machine Learning Engineer",
  "Data Scientist",
  "Automation Specialist",
  "Integration Expert",
  "Support Agent",
];

const AGENT_SUFFIXES = [
  "",
  " Pro",
  " Advanced",
  " Enterprise",
  " Plus",
  " AI",
  " Assistant",
  " Bot",
  " v2",
  " Next",
];

/**
 * Generate a unique agent name by combining templates and suffixes
 */
function generateAgentName(index: number): string {
  const template = randomElement(AGENT_NAME_TEMPLATES);
  const suffix =
    index < AGENT_NAME_TEMPLATES.length * 3
      ? randomElement(AGENT_SUFFIXES)
      : ` #${Math.floor(index / 10) + 1}`;
  return `${template}${suffix}`;
}

// Raw agent data for direct database insertion (without junction table fields like teams)
type MockAgentRaw = {
  id: string;
  name: string;
  organizationId: string;
  isDemo: boolean;
  isDefault: boolean;
  considerContextUntrusted: boolean;
  agentType: "mcp_gateway" | "agent";
};

/**
 * Generate mock agent data for direct database insertion
 * @param organizationId - Organization ID to associate agents with
 * @param count - Number of agents to generate (defaults to 90)
 */
export function generateMockAgents(
  organizationId: string,
  count = 90,
): MockAgentRaw[] {
  const agents: MockAgentRaw[] = [];

  for (let i = 0; i < count; i++) {
    agents.push({
      id: randomUUID(),
      name: generateAgentName(i),
      organizationId,
      isDemo: randomBool(0.3), // 30% chance of being a demo agent
      isDefault: false,
      considerContextUntrusted: false,
      agentType: "mcp_gateway", // Mock agents are external profiles
    });
  }

  return agents;
}
