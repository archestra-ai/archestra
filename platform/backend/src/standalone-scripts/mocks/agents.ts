import { randomUUID } from "node:crypto";
import type { InsertAgent } from "@/types/agent";
import { randomBool, randomDate, randomElement } from "./utils";

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

/**
 * Generate mock agent data
 * @param count - Number of agents to generate (defaults to 90)
 */
export function generateMockAgents(count = 90): InsertAgent[] {
  const agents: InsertAgent[] = [];
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

  for (let i = 0; i < count; i++) {
    const createdAt = randomDate(sixMonthsAgo, now);
    // updatedAt should be >= createdAt, and typically close to or after createdAt
    const maxUpdatedAt = new Date(
      createdAt.getTime() +
        Math.random() * (now.getTime() - createdAt.getTime()),
    );
    const updatedAt = randomDate(createdAt, maxUpdatedAt);

    agents.push({
      id: randomUUID(),
      name: generateAgentName(i),
      isDemo: randomBool(0.3), // 30% chance of being a demo agent
      createdAt,
      updatedAt,
      teams: [],
    });
  }

  return agents;
}
